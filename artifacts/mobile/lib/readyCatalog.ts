import { TARANEEM_POEMS } from './catalog/taraneemData';
import { CATALOG_RECITERS, POEM_CATALOG } from './catalog/poemCatalog';
import type { CatalogPoemEntry, CatalogReciter } from './catalog/poemCatalog';
import type { ParsedMizanPoem } from './mizan';
import type { Poem } from './types';

/**
 * These curated catalog entries power the mobile ready-made library.
 */
export {
  CATALOG_RECITERS,
  POEM_CATALOG,
} from './catalog/poemCatalog';
export type {
  CatalogPoemEntry,
  CatalogReciter,
} from './catalog/poemCatalog';

/** Prefer the actual recording's reader when several catalog voices share a text. */
export function getReciterForMobilePoem(poem: Poem): CatalogReciter | undefined {
  const reciterName = poem.recording?.reciter;
  if (reciterName) {
    const recordedReader = Object.values(CATALOG_RECITERS).find(
      (reader) => reader.name === reciterName || reader.id === reciterName,
    );
    if (recordedReader) return recordedReader;
  }
  // A Mizan text can have many unrelated readings. Never attribute an
  // unknown recording to the first catalog reader for the same poem.
  if (poem.recording || poem.recordings?.length) return undefined;
  if (poem.externalProvider === 'mizan_al_arab' && poem.externalId) {
    const entry = POEM_CATALOG.find((item) => item.mizanPoemId === poem.externalId);
    return entry ? CATALOG_RECITERS[entry.reciterId] : undefined;
  }
  return undefined;
}

export function getReadyEntryForMobilePoem(poem: Poem): CatalogPoemEntry | undefined {
  if (poem.externalProvider !== 'mizan_al_arab' || !poem.externalId) return undefined;
  const reader = getReciterForMobilePoem(poem);
  return POEM_CATALOG.find(
    (entry) => entry.mizanPoemId === poem.externalId && entry.reciterId === reader?.id,
  ) ?? POEM_CATALOG.find((entry) => entry.mizanPoemId === poem.externalId);
}

/** Taraneem poems have bundled text rather than a live Mizan API entry. */
export function getBundledReadyPoem(entry: CatalogPoemEntry): ParsedMizanPoem | null {
  const poem = TARANEEM_POEMS.find(
    (item) =>
      item.sourceUrl === entry.youtubeUrl ||
      item.id === entry.id.replace(/^catalog-/, ''),
  );
  if (!poem) return null;
  const verses = poem.verses
    .map((verse, orderIndex) => ({ orderIndex, text: verse.text.trim() }))
    .filter((verse) => verse.text.length > 0);
  if (!verses.length) {
    throw new Error('نص القصيدة الجاهزة غير متاح');
  }
  return {
    title: poem.title,
    poetName: poem.poet.name,
    era: poem.era,
    meter: poem.bahr,
    verses,
  };
}