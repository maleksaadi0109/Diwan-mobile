import { describe, expect, it } from 'vitest';
import { createSamplePoems, SAMPLE_SEED_KEY, seedSamplePoems } from './samplePoems';

describe('bundled sample poems', () => {
  it('adds three different complete poems with stable catalog identities, without fake audio', () => {
    const samples = createSamplePoems(1234);
    expect(samples).toHaveLength(3);
    expect(new Set(samples.map((poem) => poem.externalId)).size).toBe(3);
    for (const poem of samples) {
      expect(poem.title.length).toBeGreaterThan(3);
      expect(poem.verses.length).toBeGreaterThan(0);
      expect(poem.verses.every((verse) => verse.text.length > 0)).toBe(true);
      expect(poem.recording).toBeUndefined();
      expect(poem.sourceUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?/);
    }
    expect(createSamplePoems(1234)).toEqual(samples);
  });

  it('does not overwrite existing poems or re-add samples after the first seed', async () => {
    const data = new Map<string, string>();
    const added = new Map<string, ReturnType<typeof createSamplePoems>[number]>();
    const storage = {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => { data.set(key, value); },
    };
    const existing = createSamplePoems()[0];
    added.set(existing.externalId!, { ...existing, title: 'نسختي الشخصية' });
    const addPoem = async (poem: typeof existing) => {
      if (!added.has(poem.externalId!)) added.set(poem.externalId!, poem);
    };
    await seedSamplePoems(storage, addPoem);
    expect(added.size).toBe(3);
    expect(added.get(existing.externalId!)?.title).toBe('نسختي الشخصية');
    added.delete(existing.externalId!);
    await seedSamplePoems(storage, addPoem);
    expect(added.size).toBe(2);
  });

  it('does not mark partial insertion as completed so it can resume next launch', async () => {
    const data = new Map<string, string>();
    const added = new Set<string>();
    const storage = {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => { data.set(key, value); },
    };
    let calls = 0;
    await expect(seedSamplePoems(storage, async (poem) => {
      if (++calls === 2) throw new Error('storage full');
      added.add(poem.externalId!);
    })).rejects.toThrow('storage full');
    expect(data.has(SAMPLE_SEED_KEY)).toBe(false);
    await seedSamplePoems(storage, async (poem) => { added.add(poem.externalId!); });
    expect(added.size).toBe(3);
    expect(data.get(SAMPLE_SEED_KEY)).toBe('1');
  });
});