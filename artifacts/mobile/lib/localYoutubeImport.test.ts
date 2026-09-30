import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMizanPoemOnDevice } from './localYoutubeImport';

afterEach(() => vi.unstubAllGlobals());

describe('Android Mizan text fetch', () => {
  it('fetches directly from Mizan, not the application server', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'قصيدة', verses: [{ id: 1, text: 'بيت' }] }),
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchMizanPoemOnDevice('123')).resolves.toMatchObject({ title: 'قصيدة' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://mizanalarab.com/api/poems/123',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('rejects unsafe IDs before any request and malformed provider data', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: '', verses: [] }),
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchMizanPoemOnDevice('../internal')).rejects.toThrow('غير صالح');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fetchMizanPoemOnDevice('123')).rejects.toThrow('ناقصة');
  });
});