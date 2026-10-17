import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveStreamConsumer } from '@mega-yfue/eufy-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startLivePreview } from '../../src/media/live-preview.js';

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
  /** An executable standing in for FFmpeg that echoes its input, so the pictures out are the bytes written in. */
  let echo: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-preview-'));
    echo = join(directory, 'ffmpeg');
    await writeFile(echo, '#!/bin/sh\nexec cat\n');
    await chmod(echo, 0o755);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Nothing is adapted before the first keyframe, each JPEG end marker closes one picture, and the stop releases
   * the SDK source and reports the end exactly once.
   */
  it('hands on one picture per JPEG from the first keyframe, and stops once', async () => {
    const live = consumer();
    const pictures: string[] = [];
    const onEnd = vi.fn();
    const stop = startLivePreview(
      echo,
      { live: async () => live as unknown as LiveStreamConsumer },
      (jpeg) => pictures.push(jpeg.toString('hex')),
      onEnd,
    );
    await vi.waitFor(() => expect(live.listenerCount('video')).toBe(1));

    live.emit('video', frame([0xff, 0xd8, 0x00, 0xff, 0xd9], false));
    live.emit('video', frame([0xff, 0xd8, 0x01, 0xff, 0xd9, 0xff, 0xd8], true));
    live.emit('video', frame([0x02, 0xff, 0xd9], false));
    await vi.waitFor(() => expect(pictures).toEqual(['ffd801ffd9', 'ffd802ffd9']));

    stop();
    stop();
    expect(live.stop).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  /** A camera whose codec changes mid-stream ends the preview rather than feeding FFmpeg a second format. */
  it('ends on a codec change', async () => {
    const live = consumer();
    const onEnd = vi.fn();
    startLivePreview(echo, { live: async () => live as unknown as LiveStreamConsumer }, () => undefined, onEnd);
    await vi.waitFor(() => expect(live.listenerCount('video')).toBe(1));

    live.emit('video', frame([0x00], true));
    live.emit('video', frame([0x00], true, 'h265'));

    expect(onEnd).toHaveBeenCalledOnce();
    expect(live.stop).toHaveBeenCalledOnce();
  });

  /** A source that never opens ends the preview, and nothing is left to stop. */
  it('ends when the source cannot open', async () => {
    const onEnd = vi.fn();
    startLivePreview(
      echo,
      { live: async () => Promise.reject(new Error('synthetic refusal')) },
      () => undefined,
      onEnd,
    );

    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
  });
});
