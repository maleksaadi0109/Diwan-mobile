import { getBundledReadyPoem, POEM_CATALOG } from './readyCatalog';
import type { Poem } from './types';

export const SAMPLE_SEED_KEY = 'diwan.mobile.sample-poems.v1';

/** Three full, locally bundled poems so a new library is useful even offline. */
export const SAMPLE_CATALOG_IDS = [
  'catalog-taraneem-2',
  'catalog-taraneem-22',
  'catalog-taraneem-28',
] as const;

export function createSamplePoems(createdAt = Date.now()): Poem[] {
  return SAMPLE_CATALOG_IDS.map((catalogId) => {
    const entry = POEM_CATALOG.find((item) => item.id === catalogId);
    const text = entry && getBundledReadyPoem(entry);
    if (!entry || !text) {
      throw new Error(`نص القصيدة التجريبية غير متاح: ${catalogId}`);
    }
    return {
      id: `sample-${catalogId}`,
      title: text.title,
      poetName: text.poetName,
      era: text.era,
      meter: text.meter,
      verses: text.verses.map((verse, index) => ({
        id: `sample-${catalogId}-verse-${index}`,
        orderIndex: index,
        text: verse.text,
      })),
      createdAt,
      // These Taraneem entries use local text; their synthetic catalog IDs are
      // not live Mizan pages. Link to the actual performance instead.
      sourceUrl: entry.youtubeUrl,
      externalProvider: 'mizan_al_arab',
      externalId: entry.mizanPoemId,
    };
  });
}

/** Mark completion only after all inserts. Retrying after interruption is safe
 * because the library rejects duplicate external poem IDs. */
export async function seedSamplePoems(
  storage: Pick<typeof import('@react-native-async-storage/async-storage').default, 'getItem' | 'setItem'>,
  addPoem: (poem: Poem) => Promise<unknown>,
): Promise<void> {
  if (await storage.getItem(SAMPLE_SEED_KEY) === '1') return;
  for (const poem of createSamplePoems()) {
    await addPoem(poem);
  }
  await storage.setItem(SAMPLE_SEED_KEY, '1');
}