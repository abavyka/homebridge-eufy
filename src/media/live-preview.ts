import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { LiveStreamConsumer, LiveVideoFrame } from '@mega-yfue/eufy-sdk';

import type { AdaptationDiagnostics, AdaptationRole, LiveMediaSource, NegotiatedLiveVideo } from './contracts.js';
import {
  adaptationReporter,
  AdaptationStderr,
  commonArguments,
  type FfmpegLiveMedia,
  PROCESS_STOP_GRACE_MS,
} from './live-stream.js';

/** How long one preview runs before it ends on its own, so a page left open does not hold a camera. */
export const LIVE_PREVIEW_MAX_MS = 3 * 60_000;

/** How long coded video may flow without decoding to a picture before the preview ends as unplayable. */
export const LIVE_PREVIEW_PICTURE_MS = 10_000;

/** The most bytes one picture may reach before FFmpeg's output is taken as no longer pictures. */
const MAX_PICTURE_BYTES = 1024 * 1024;

const JPEG_END = Buffer.from([0xff, 0xd9]);

/** The JPEG output both preview sides are decoded into: five pictures a second, 640 pixels wide, on stdout. */
const STILLS = ['-an', '-vf', 'fps=5,scale=640:-2', '-q:v', '8', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];

/** Which picture a preview still shows: the camera's own, or the camera coded as HomeKit receives it. */
export type LivePreviewSide = 'raw' | 'homekit';

/**
 * How one preview run ended, and what it was coded with: `picture` showed at least one HomeKit picture,
 * `stopped` was stopped before one, `unplayable` showed the camera but no HomeKit picture, and `no-video` ended
 * without even a camera picture.
 */
export interface LivePreviewResult {
  outcome: 'picture' | 'unplayable' | 'no-video' | 'stopped';
  selection: Pick<NegotiatedLiveVideo, 'profile' | 'level' | 'width' | 'height' | 'fps' | 'maxBitRate'>;
  encoder?: string;
  source?: LiveVideoFrame['codec'];
  kbps?: number;
}

/** The selection an iPhone on Wi-Fi asks a camera for: High 4.0, 1280x720 at 30 fps, 299 kbps, MTU 1378. */
const IPHONE_SELECTION: NegotiatedLiveVideo = {
  width: 1280,
  height: 720,
  fps: 30,
  maxBitRate: 299,
  profile: 'high',
  level: '4.0',
  payloadType: 99,
  ssrc: 1,
  mtu: 1378,
  rtcpInterval: 0.5,
};

/**
 * A camera's live video as JPEG pictures for the settings page, five a second and 640 pixels wide, on two sides:
 * `raw` decoded straight from the camera, and `homekit` coded as a live session codes it for
 * {@link IPHONE_SELECTION} and decoded again.
 *
 * Each picture carries its side, the encoder of the HomeKit side and, once that has written for a second, the
 * kilobits a second it wrote.
 *
 * The SDK source is fanned out to two FFmpegs: one decodes it into the `raw` pictures, one runs the session's own
 * encoder and argument list and writes the coded H.264 elementary stream, which a third decodes into the
 * `homekit` pictures. Starts at the first keyframe and has no audio. A write either refuses holds the SDK source
 * until it drains, so the SDK's keyframe-aware queue is the only one, and the HomeKit decoder holds the encoder
 * the same way. A codec change, a source or FFmpeg failure, the time limit and the returned stop all end it, and
 * `onEnd` is called exactly once with the run's result whichever came first. `diagnostics` receives each
 * process's `started` and `output` notices as a live session's do, under the `preview-raw`, `preview-encode` and
 * `preview-decode` roles.
 */
export function startLivePreview(
  executable: string,
  media: Pick<FfmpegLiveMedia, 'videoAdaptation'>,
  source: LiveMediaSource,
  onPicture: (jpeg: Buffer, coding: { side: LivePreviewSide; encoder: string; kbps?: number }) => void,
  onEnd: (result: LivePreviewResult) => void,
  diagnostics?: AdaptationDiagnostics,
): () => void {
  const report = adaptationReporter(diagnostics);
  const abandonment = new AbortController();
  let live: LiveStreamConsumer | undefined;
  const processes: ReturnType<typeof spawn>[] = [];
  let codec: LiveVideoFrame['codec'] | undefined;
  let pictureless: ReturnType<typeof setTimeout> | undefined;
  let coding: { encoder: string; kbps?: number } | undefined;
  const pictures = { raw: 0, homekit: 0 };
  let ended = false;
  const end = (stopped = false): void => {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    clearTimeout(pictureless);
    abandonment.abort();
    try {
      live?.stop();
    } catch {
      live = undefined;
    }
    for (const process of processes) {
      process.stdin?.destroy();
      process.kill('SIGTERM');
      const kill = setTimeout(() => process.kill('SIGKILL'), PROCESS_STOP_GRACE_MS);
      kill.unref();
      process.once('exit', () => clearTimeout(kill));
    }
    const { profile, level, width, height, fps, maxBitRate } = IPHONE_SELECTION;
    onEnd({
      outcome: pictures.homekit ? 'picture' : stopped ? 'stopped' : pictures.raw ? 'unplayable' : 'no-video',
      selection: { profile, level, width, height, fps, maxBitRate },
      ...(coding ? { encoder: coding.encoder } : {}),
      ...(codec ? { source: codec } : {}),
      ...(coding?.kbps === undefined ? {} : { kbps: coding.kbps }),
    });
  };
  const deadline = setTimeout(() => end(), LIVE_PREVIEW_MAX_MS);
  deadline.unref();

  const run = (role: AdaptationRole, args: string[]): ReturnType<typeof spawn> => {
    const process = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr = new AdaptationStderr();
    process.stderr!.on('data', (chunk: Buffer) => stderr.observe(chunk));
    process.once('error', () => end());
    process.once('exit', (code, signal) => {
      report(role, 'output', stderr, code, signal);
      end();
    });
    process.stdin!.on('error', () => end());
    processes.push(process);
    return process;
  };

  const stills = (output: Readable, side: LivePreviewSide, coded: { encoder: string; kbps?: number }): void => {
    let pending = Buffer.alloc(0);
    output.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let at = pending.indexOf(JPEG_END); at !== -1; at = pending.indexOf(JPEG_END)) {
        if (side === 'homekit') clearTimeout(pictureless);
        pictures[side] += 1;
        onPicture(pending.subarray(0, at + JPEG_END.length), { side, ...coded });
        pending = pending.subarray(at + JPEG_END.length);
      }
      if (pending.length > MAX_PICTURE_BYTES) end();
    });
  };

  const adapt = (input: LiveVideoFrame['codec']): ReturnType<typeof spawn>[] => {
    const { encoder, args } = media.videoAdaptation(input, IPHONE_SELECTION, ['-f', 'h264', 'pipe:1']);
    coding = { encoder };
    diagnostics?.report({ role: 'preview-encode', event: 'started', cause: 'first', encoder, source: input });
    const encoding = run('preview-encode', args);
    diagnostics?.report({ role: 'preview-decode', event: 'started', cause: 'first', source: 'h264' });
    const decoding = run('preview-decode', [...commonArguments('h264'), ...STILLS]);
    diagnostics?.report({ role: 'preview-raw', event: 'started', cause: 'first', source: input });
    const raw = run('preview-raw', [...commonArguments(input === 'h265' ? 'hevc' : input), ...STILLS]);
    const coded = coding;
    let firstCodedAt: number | undefined;
    let countedBytes = 0;
    encoding.stdout!.on('data', (chunk: Buffer) => {
      const now = Date.now();
      if (firstCodedAt === undefined) {
        firstCodedAt = now;
        pictureless = setTimeout(() => end(), LIVE_PREVIEW_PICTURE_MS);
        pictureless.unref();
        return;
      }
      countedBytes += chunk.length;
      if (now - firstCodedAt >= 1_000) coded.kbps = Math.round((countedBytes * 8) / (now - firstCodedAt));
    });
    encoding.stdout!.pipe(decoding.stdin!);
    stills(decoding.stdout!, 'homekit', coded);
    stills(raw.stdout!, 'raw', coded);
    return [raw, encoding];
  };

  source.live({ signal: abandonment.signal }).then(
    (consumer) => {
      if (ended) {
        consumer.stop();
        return;
      }
      live = consumer;
      consumer.on('error', () => end());
      consumer.on('stop', () => end());
      consumer.on('budget', (notice) => notice.extend());
      let inputs: ReturnType<typeof spawn>[] | undefined;
      let held = 0;
      const feed = (stdin: Writable, data: Buffer): void => {
        if (stdin.write(data)) return;
        held += 1;
        consumer.pause();
        const release = (): void => {
          stdin.off('drain', release).off('close', release);
          if (--held === 0) consumer.resume();
        };
        stdin.on('drain', release).on('close', release);
      };
      consumer.on('video', (frame: LiveVideoFrame) => {
        if (ended) return;
        if (!inputs) {
          if (!frame.keyframe) return;
          codec = frame.codec;
          inputs = adapt(codec);
        }
        if (frame.codec !== codec) return end();
        for (const input of inputs) feed(input.stdin!, frame.data);
      });
    },
    () => end(),
  );
  return () => end(true);
}
