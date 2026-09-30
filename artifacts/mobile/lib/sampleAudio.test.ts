import { describe, expect, it, vi } from 'vitest';
import { attachSampleAudio, hasPoemAudio } from './sampleAudio';
import { createSamplePoems } from './samplePoems';
import type { Poem, Recording } from './types';

function setup() {
  let poem: Poem | undefined = createSamplePoems(123)[0];
  const download = vi.fn(async () => ({
    playback_audio_path: '/api-worker/youtube/audio/yt-abcd1234/playback.mp3',
    duration_ms: 30408,
  }));
  const cache = vi.fn(async (recording: Recording) => ({
    ...recording,
    audioUrl: `file:///recording-audio/${recording.id}.mp3`,
    serverAudioUrl: recording.audioUrl,
  }));
  const phases: string[] = [];
  const deps = {
    getPoem: () => poem,
    download,
    playableUrl: (path: string) => `https://example.test${path}`,
    cache,
    updatePoem: vi.fn(async (_id: string, updater: (current: Poem) => Poem) => {
      if (poem) poem = updater(poem);
    }),
    onPhase: (phase: string) => { phases.push(phase); },
  };
  return { deps, download, cache, phases, getPoem: () => poem, setPoem: (value: Poem | undefined) => { poem = value; } };
}

describe('automatic sample audio', () => {
  it('downloads, caches and attaches real audio without touching the poem text', async () => {
    const test = setup();
    const originalVerses = test.getPoem()!.verses;
    expect(await attachSampleAudio('catalog-taraneem-2', test.deps)).toBe('attached');
    expect(test.phases).toEqual(['downloading', 'saving']);
    expect(test.getPoem()!.verses).toEqual(originalVerses);
    expect(test.getPoem()!.recording).toMatchObject({
      audioUrl: 'file:///recording-audio/sample-audio-catalog-taraneem-2.mp3',
      durationMs: 30408,
      reciter: 'ترنيم (نواف)',
    });
    expect(await attachSampleAudio('catalog-taraneem-2', test.deps)).toBe('skipped');
    expect(test.download).toHaveBeenCalledTimes(1);
  });

  it('keeps text and allows a later retry when download or cache fails', async () => {
    const test = setup();
    test.download.mockRejectedValueOnce(new Error('offline'));
    await expect(attachSampleAudio('catalog-taraneem-2', test.deps)).rejects.toThrow('offline');
    expect(test.getPoem()!.recording).toBeUndefined();
    test.cache.mockRejectedValueOnce(new Error('disk full'));
    await expect(attachSampleAudio('catalog-taraneem-2', test.deps)).rejects.toThrow('disk full');
    expect(test.getPoem()!.recording).toBeUndefined();
    expect(await attachSampleAudio('catalog-taraneem-2', test.deps)).toBe('attached');
  });

  it('never replaces a recording inserted during the download', async () => {
    const test = setup();
    const personalRecording: Recording = { id: 'own', audioUrl: 'file:///own.mp3', durationMs: 1000 };
    test.download.mockImplementationOnce(async () => {
      test.setPoem({ ...test.getPoem()!, recording: personalRecording });
      return { playback_audio_path: '/api-worker/youtube/audio/yt-abcd1234/playback.mp3', duration_ms: 30408 };
    });
    expect(await attachSampleAudio('catalog-taraneem-2', test.deps)).toBe('skipped');
    expect(test.getPoem()!.recording).toEqual(personalRecording);
    expect(test.cache).not.toHaveBeenCalled();
    expect(hasPoemAudio(test.getPoem()!)).toBe(true);
  });

  it('rejects unlisted IDs and unexpected server audio paths', async () => {
    const test = setup();
    await expect(attachSampleAudio('catalog-taraneem-1', test.deps)).rejects.toThrow();
    test.download.mockResolvedValueOnce({ playback_audio_path: 'https://untrusted.test/audio.mp3', duration_ms: 100 });
    await expect(attachSampleAudio('catalog-taraneem-2', test.deps)).rejects.toThrow('مسار الصوت');
    expect(test.cache).not.toHaveBeenCalled();
  });
});