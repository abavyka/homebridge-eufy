import { spawn } from 'node:child_process';

import type { LiveStreamConsumer, LiveVideoFrame } from '@mega-yfue/eufy-sdk';

import type { LiveMediaSource } from './contracts.js';
import { commonArguments, PROCESS_STOP_GRACE_MS } from './live-stream.js';

/** How long one preview runs before it ends on its own, so a page left open does not hold a camera. */
export const LIVE_PREVIEW_MAX_MS = 3 * 60_000;

/** The most bytes one picture may reach before FFmpeg's output is taken as no longer pictures. */
const MAX_PICTURE_BYTES = 1024 * 1024;

const JPEG_END = Buffer.from([0xff, 0xd9]);

/** The FFmpeg input format each SDK codec is read in. AV1 has none, so such a camera has no preview. */
const INPUT_FORMATS: Partial<Record<LiveVideoFrame['codec'], string>> = { h264: 'h264', h265: 'hevc' };

/**
 * A camera's live video as JPEG pictures, five a second and 640 pixels wide, for the settings page.
 *
 * Starts at the first keyframe and has no audio. A write FFmpeg refuses holds the SDK source until it drains,
 * so the SDK's keyframe-aware queue is the only one. A codec change, a source or FFmpeg failure, the time limit
 * and the returned stop all end it, and `onEnd` is called exactly once whichever came first.
 */
export function startLivePreview(
  executable: string,
  source: LiveMediaSource,
  onPicture: (jpeg: Buffer) => void,
  onEnd: () => void,
): () => void {
  const abandonment = new AbortController();
  let live: LiveStreamConsumer | undefined;
  let ffmpeg: ReturnType<typeof spawn> | undefined;
  let codec: LiveVideoFrame['codec'] | undefined;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    abandonment.abort();
    try {
      live?.stop();
    } catch {
      live = undefined;
    }
    if (ffmpeg) {
      const process = ffmpeg;
      process.stdin?.destroy();
      process.kill('SIGTERM');
      const kill = setTimeout(() => process.kill('SIGKILL'), PROCESS_STOP_GRACE_MS);
      kill.unref();
      process.once('exit', () => clearTimeout(kill));
    }
    onEnd();
  };
  const deadline = setTimeout(end, LIVE_PREVIEW_MAX_MS);
  deadline.unref();

  const adapt = (format: string): ReturnType<typeof spawn> => {
    const process = spawn(
      executable,
      [...commonArguments(format), '-an', '-vf', 'fps=5,scale=640:-2', '-q:v', '8', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    process.once('error', end);
    process.once('exit', end);
    process.stdin!.on('error', end);
    let pending = Buffer.alloc(0);
    process.stdout!.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let at = pending.indexOf(JPEG_END); at !== -1; at = pending.indexOf(JPEG_END)) {
        onPicture(pending.subarray(0, at + JPEG_END.length));
        pending = pending.subarray(at + JPEG_END.length);
      }
      if (pending.length > MAX_PICTURE_BYTES) end();
    });
    return process;
  };

  source.live({ signal: abandonment.signal }).then(
    (consumer) => {
      if (ended) {
        consumer.stop();
        return;
      }
      live = consumer;
      consumer.on('error', end);
      consumer.on('stop', end);
      consumer.on('budget', (notice) => notice.extend());
      consumer.on('video', (frame: LiveVideoFrame) => {
        if (ended) return;
        if (!ffmpeg) {
          const format = INPUT_FORMATS[frame.codec];
          if (!frame.keyframe) return;
          if (!format) return end();
          codec = frame.codec;
          ffmpeg = adapt(format);
        }
        if (frame.codec !== codec) return end();
        const stdin = ffmpeg.stdin!;
        if (!stdin.write(frame.data)) {
          consumer.pause();
          stdin.once('drain', () => consumer.resume());
        }
      });
    },
    end,
  );
  return end;
}
