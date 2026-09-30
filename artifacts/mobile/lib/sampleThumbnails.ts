import { POEM_CATALOG } from './readyCatalog';
import type { Poem } from './types';

// Actual video thumbnails for the three built-in poems, bundled so they
// remain visible when the phone is offline and for libraries seeded earlier.
const thumbnails: Record<string, number> = {
  'catalog-taraneem-2': require('../assets/poem-thumbnails/taraneem-2.jpg'),
  'catalog-taraneem-22': require('../assets/poem-thumbnails/taraneem-22.jpg'),
  'catalog-taraneem-28': require('../assets/poem-thumbnails/taraneem-28.jpg'),
};

export function getSampleThumbnailSource(catalogId: string): number | undefined {
  return thumbnails[catalogId];
}

export function getBundledSampleThumbnailSource(poem: Poem): number | undefined {
  const catalogId = poem.id.replace(/^sample-/, '');
  const entry = POEM_CATALOG.find((item) => item.id === catalogId);
  if (
    poem.id !== `sample-${catalogId}` ||
    !entry ||
    poem.externalProvider !== 'mizan_al_arab' ||
    poem.externalId !== entry.mizanPoemId ||
    poem.sourceUrl !== entry.youtubeUrl
  ) return undefined;
  return getSampleThumbnailSource(catalogId);
}

export function getPoemCoverSource(poem: Poem): number | { uri: string } | undefined {
  const bundled = getBundledSampleThumbnailSource(poem);
  if (!poem.coverImageUrl) return bundled;
  // An older import may have saved the same YouTube thumbnail as a remote
  // link. Prefer the bundled copy so it still appears without connectivity.
  if (bundled && poem.sourceUrl) {
    try {
      const videoId = new URL(poem.sourceUrl).searchParams.get('v');
      const cover = new URL(poem.coverImageUrl);
      if (videoId && cover.protocol === 'https:' && cover.hostname === 'i.ytimg.com' &&
          cover.pathname.startsWith(`/vi/${videoId}/`)) return bundled;
    } catch {
      // Preserve any custom URI, including local files and data URLs.
    }
  }
  return { uri: poem.coverImageUrl };
}