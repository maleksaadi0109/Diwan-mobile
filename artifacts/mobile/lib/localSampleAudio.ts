import { POEM_CATALOG, CATALOG_RECITERS } from './readyCatalog';
import { hasPoemAudio, isSampleCatalogId } from './sampleAudio';
import type { Poem, Recording } from './types';

/** Keep deletion/edit races and failed saves from replacing existing user audio. */
export async function attachDeviceSampleAudio(catalogId: string, deps: {
  getPoem: () => Poem | undefined;
  download: (url: string) => Promise<Recording>;
  discard: (recording: Recording) => Promise<void>;
  updatePoem: (id: string, updater: (poem: Poem) => Poem) => Promise<void>;
  signal?: AbortSignal;
}): Promise<'attached' | 'skipped'> {
  if (!isSampleCatalogId(catalogId)) throw new Error('القصيدة ليست من قصائد التجربة.');
  const entry = POEM_CATALOG.find((item) => item.id === catalogId)!;
  const eligible = (poem: Poem | undefined) => poem?.id === `sample-${catalogId}` &&
    poem.externalId === entry.mizanPoemId && !hasPoemAudio(poem);
  if (!eligible(deps.getPoem()) || deps.signal?.aborted) return 'skipped';
  const recording = await deps.download(entry.youtubeUrl);
  let attached = false;
  try {
    if (deps.signal?.aborted || !eligible(deps.getPoem())) return 'skipped';
    await deps.updatePoem(`sample-${catalogId}`, (poem) => {
      if (deps.signal?.aborted || !eligible(poem)) return poem;
      attached = true;
      return { ...poem, recording: { ...recording, reciter: CATALOG_RECITERS[entry.reciterId]?.name } };
    });
    return attached ? 'attached' : 'skipped';
  } finally {
    const current = deps.getPoem();
    const saved = current?.recording?.id === recording.id ||
      current?.recordings?.some((item) => item.id === recording.id);
    if (!saved) await deps.discard(recording);
  }
}