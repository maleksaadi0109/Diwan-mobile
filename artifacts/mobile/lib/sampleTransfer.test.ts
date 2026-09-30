import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => saved.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { saved.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { saved.delete(key); }),
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  FileSystemSessionType: { BACKGROUND: 0 },
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  deleteAsync: vi.fn(async () => undefined),
  createDownloadResumable: vi.fn(),
  moveAsync: vi.fn(async () => undefined),
}));
vi.mock('./api', () => ({ toPlayableAudioUrl: (path: string) => `https://example.test${path}` }));

import * as fs from 'expo-file-system/legacy';
import { AudioServerBusyError, cacheSampleTransfer, clearSampleTransfer, prepareSampleTransfer, readSampleTransfer } from './sampleTransfer';

const catalog = 'catalog-taraneem-2';
const playback = '/api-worker/youtube/audio/yt-sample-test123/playback.mp3';

describe('restartable sample transfers', () => {
  beforeEach(() => {
    saved.clear();
    vi.resetAllMocks();
  });

  it('saves the job before requesting it and reuses the server result on restart', async () => {
    const start = vi.fn(async (_url: string, jobId: string) => {
      expect((await readSampleTransfer(catalog))?.jobId).toBe(jobId);
      return { playback_audio_path: `/api-worker/youtube/audio/${jobId}/playback.mp3`, duration_ms: 123 };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 404 }));
    const first = await prepareSampleTransfer(catalog, 'https://youtube.test/video', start, vi.fn());
    vi.mocked(fetch).mockResolvedValueOnce({ status: 200, json: async () => ({
      status: 'ready', playback_audio_path: first.playback_audio_path, duration_ms: 123,
    }) } as never);
    const resumed = vi.fn();
    const second = await prepareSampleTransfer(catalog, 'https://youtube.test/video', start, resumed);
    expect(second).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledOnce();
    await clearSampleTransfer(catalog);
    expect(await readSampleTransfer(catalog)).toBeNull();
  });

  it('starts a new job when saved server audio expired during an offline period', async () => {
    saved.set(`diwan.mobile.sample-transfer.${catalog}.v1`, JSON.stringify({
      jobId: 'yt-sample-expired', url: 'youtube-url',
      playbackPath: '/api-worker/youtube/audio/yt-sample-expired/playback.mp3',
    }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ status: 404 }) // expired temporary job
      .mockResolvedValueOnce({ status: 404 })); // fresh ID not yet submitted
    const start = vi.fn(async (_url: string, jobId: string) => ({
      playback_audio_path: `/api-worker/youtube/audio/${jobId}/playback.mp3`,
    }));
    const result = await prepareSampleTransfer(catalog, 'youtube-url', start, vi.fn());
    expect(result.jobId).not.toBe('yt-sample-expired');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toBe(result.jobId);
    expect((await readSampleTransfer(catalog))?.playbackPath).toBe(result.playback_audio_path);
  });

  it('waits for an existing server job instead of starting another', async () => {
    const jobId = 'yt-sample-test123';
    saved.set(`diwan.mobile.sample-transfer.${catalog}.v1`, JSON.stringify({ jobId, url: 'youtube-url' }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ status: 202 })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ status: 'ready', playback_audio_path: playback, duration_ms: 200 }) }));
    const start = vi.fn();
    const result = await prepareSampleTransfer(catalog, 'youtube-url', start, vi.fn());
    expect(result).toMatchObject({ jobId, duration_ms: 200 });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports server overload immediately without losing the saved job ID or polling for minutes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const start = vi.fn(async () => { throw new AudioServerBusyError(429, '600'); });
    await expect(prepareSampleTransfer(catalog, 'youtube-url', start, vi.fn()))
      .rejects.toThrow(/HTTP 429/);
    expect(start).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await readSampleTransfer(catalog))?.jobId).toMatch(/^yt-sample-/);
  });

  it('never replaces an existing local recording file', async () => {
    vi.mocked(fs.getInfoAsync).mockResolvedValue({ exists: true, size: 1024, uri: 'file:///docs/test' } as never);
    const record = { id: `sample-audio-${catalog}-yt-sample-test123`, audioUrl: 'https://example.test/audio.mp3', durationMs: 0 };
    const cached = await cacheSampleTransfer(record, vi.fn());
    expect(cached.audioUrl).toContain('file:///docs/recording-audio/');
    expect(fs.createDownloadResumable).not.toHaveBeenCalled();
    expect(fs.moveAsync).not.toHaveBeenCalled();
  });

  it('downloads into a staging file using the native background session, then commits it', async () => {
    const record = { id: `sample-audio-${catalog}-yt-sample-test123`, audioUrl: 'https://example.test/audio.mp3', durationMs: 0 };
    vi.mocked(fs.getInfoAsync)
      .mockResolvedValueOnce({ exists: false, uri: '' } as never)
      .mockResolvedValueOnce({ exists: true, size: 500, uri: '' } as never)
      .mockResolvedValueOnce({ exists: false, uri: '' } as never);
    vi.mocked(fs.createDownloadResumable).mockReturnValue({
      downloadAsync: vi.fn(async () => ({ status: 200 })),
    } as never);
    const result = await cacheSampleTransfer(record, vi.fn());
    expect(fs.createDownloadResumable).toHaveBeenCalledWith(
      record.audioUrl,
      expect.stringContaining('.part.mp3'),
      { sessionType: 0 },
      expect.any(Function),
    );
    expect(fs.moveAsync).toHaveBeenCalledWith({
      from: expect.stringContaining('.part.mp3'),
      to: expect.stringContaining(`${record.id}.mp3`),
    });
    expect(result.serverAudioUrl).toBe(record.audioUrl);
  });
});