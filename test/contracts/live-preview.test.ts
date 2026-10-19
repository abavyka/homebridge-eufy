import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveStreamConsumer } from '@mega-yfue/eufy-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AdaptationNotice } from '../../src/media/contracts.js';
import { LIVE_PREVIEW_PICTURE_MS, startLivePreview } from '../../src/media/live-preview.js';
import { FfmpegLiveMedia } from '../../src/media/live-stream.js';

/** The live encoder picker on a host where nothing qualified, so a preview is coded by libx264. */
const media = new FfmpegLiveMedia('/synthetic/ffmpeg');

/** The selection a preview is coded at, as its result states it. */
const IPHONE_SELECTION = { profile: 'high', level: '4.0', width: 1280, height: 720, fps: 30, maxBitRate: 299 };

/** A consumer the test drives, with the members a preview uses. */
function consumer() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { stop: vi.fn(), pause: vi.fn(), resume: vi.fn() });
}

function frame(data: number[], keyframe: boolean, codec: 'h264' | 'h265' = 'h264') {
  return { keyframe, codec, width: 640, height: 360, data: Buffer.from(data) };
}

describe('live preview', () => {
  let directory: string;
  /**
   * An executable standing in for both FFmpegs that writes one progress line and echoes its input, so the coded
   * stream is the bytes written in and the pictures out are the coded stream.
   */
  let echo: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-preview-'));
    echo = join(directory, 'ffmpeg');
    await writeFile(echo, "#!/bin/sh\necho 'bitrate= 287.0kbits/s' >&2\nexec cat\n");
    await chmod(echo, 0o755);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Nothing is adapted before the first keyframe, each JPEG end marker closes one picture carrying the encoder
   * it was coded by, and the stop releases the SDK source and reports the result exactly once. Each process is
   * reported as a live session's are, `started` and then its `output`, under its preview role.
   */
  it('hands on one picture per JPEG from the first keyframe, and stops once', async () => {
    const live = consumer();
    const pictures: string[] = [];
    const notices: AdaptationNotice[] = [];
    const onEnd = vi.fn();
    const stop = startLivePreview(
      echo,
      media,
      { live: async () => live as unknown as LiveStreamConsumer },
      (jpeg, coding) => pictures.push(`${jpeg.toString('hex')}@${coding.encoder}`),
      onEnd,
      { report: (notice) => notices.push(notice) },
    );
    await vi.waitFor(() => expect(live.listenerCount('video')).toBe(1));

    live.emit('video', frame([0xff, 0xd8, 0x00, 0xff, 0xd9], false));
    live.emit('video', frame([0xff, 0xd8, 0x01, 0xff, 0xd9, 0xff, 0xd8], true));
    live.emit('video', frame([0x02, 0xff, 0xd9], false));
    await vi.waitFor(() => expect(pictures).toEqual(['ffd801ffd9@libx264', 'ffd802ffd9@libx264']));

    stop();
    stop();
    expect(live.stop).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith({
      outcome: 'picture',
      selection: IPHONE_SELECTION,
      encoder: 'libx264',
      source: 'h264',
    });
    await vi.waitFor(() => expect(notices).toHaveLength(4));
    expect(notices.slice(0, 2)).toEqual([
      { role: 'preview-encode', event: 'started', cause: 'first', encoder: 'libx264', source: 'h264' },
      { role: 'preview-decode', event: 'started', cause: 'first', source: 'h264' },
    ]);
    expect(
      notices
        .slice(2)
        .map(({ role, event, stderr }) => `${role} ${event} ${stderr?.join()}`)
        .sort(),
    ).toEqual(['preview-decode output bitrate= 287.0kbits/s', 'preview-encode output bitrate= 287.0kbits/s']);
  });

  /** Coded video that decodes to no picture within its bound ends the preview as unplayable. */
  it('ends as unplayable when the coded video yields no picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const live = consumer();
      const onEnd = vi.fn();
      startLivePreview(
        echo,
        media,
        { live: async () => live as unknown as LiveStreamConsumer },
        () => undefined,
        onEnd,
      );
      await vi.waitFor(() => expect(live.listenerCount('video')).toBe(1));

      live.emit('video', frame([0x00, 0x00, 0x01, 0x65], true));
      await vi.waitFor(() => expect(vi.getTimerCount(), 'the picture bound arms on the first coded bytes').toBe(2));
      vi.advanceTimersByTime(LIVE_PREVIEW_PICTURE_MS);

      expect(onEnd).toHaveBeenCalledExactlyOnceWith({
        outcome: 'unplayable',
        selection: IPHONE_SELECTION,
        encoder: 'libx264',
        source: 'h264',
      });
      expect(live.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A camera whose codec changes mid-stream ends the preview rather than feeding FFmpeg a second format. */
  it('ends on a codec change', async () => {
    const live = consumer();
    const onEnd = vi.fn();
    startLivePreview(echo, media, { live: async () => live as unknown as LiveStreamConsumer }, () => undefined, onEnd);
    await vi.waitFor(() => expect(live.listenerCount('video')).toBe(1));

    live.emit('video', frame([0x00], true));
    live.emit('video', frame([0x00], true, 'h265'));

    expect(onEnd).toHaveBeenCalledOnce();
    expect(live.stop).toHaveBeenCalledOnce();
  });

  /** A source that never opens ends the preview with no video, and a stop before any picture says it was stopped. */
  it('ends with no video when the source cannot open, and stopped when stopped first', async () => {
    const onEnd = vi.fn();
    startLivePreview(
      echo,
      media,
      { live: async () => Promise.reject(new Error('synthetic refusal')) },
      () => undefined,
      onEnd,
    );
    await vi.waitFor(() =>
      expect(onEnd).toHaveBeenCalledExactlyOnceWith({ outcome: 'no-video', selection: IPHONE_SELECTION }),
    );

    const stopped = vi.fn();
    startLivePreview(echo, media, { live: () => new Promise(() => undefined) }, () => undefined, stopped)();
    expect(stopped).toHaveBeenCalledExactlyOnceWith({ outcome: 'stopped', selection: IPHONE_SELECTION });
  });
});
