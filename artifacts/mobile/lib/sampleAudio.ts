import { CATALOG_RECITERS, POEM_CATALOG } from './readyCatalog';
import { SAMPLE_CATALOG_IDS } from './samplePoems';
import type { Poem, Recording } from './types';

export type SampleAudioPhase = 'downloading' | 'saving' | 'resuming' | 'interrupted' | 'ready' | 'error';
export interface SampleAudioStatus {
  phase: SampleAudioPhase;
  message?: string;
  progress?: number;
}

interface SampleAudioDependencies {
  getPoem: () => Poem | undefined;
  download: (youtubeUrl: string) => Promise<{
    playback_audio_path: string;
    duration_ms?: number;
    jobId?: string;
  }>;
  playableUrl: (path: string) => string;
  cache: (recording: Recording) => Promise<Recording>;
  updatePoem: (id: string, updater: (poem: Poem) => Poem) => Promise<void>;
  onPhase: (phase: 'downloading' | 'saving') => void;
}

export function isSampleCatalogId(value: string): value is (typeof SAMPLE_CATALOG_IDS)[number] {
  return SAMPLE_CATALOG_IDS.some((id) => id === value);
}

export function hasPoemAudio(poem: Poem): boolean {
  return Boolean(poem.recording || poem.recordings?.length);
}

/**
 * Downloads only the three opt-in samples and persists real audio on the
 * device before attaching it to the poem. It never overwrites user audio.
 */
export async function attachSampleAudio(
  catalogId: string,
  deps: SampleAudioDependencies,
): Promise<'attached' | 'skipped'> {
  if (!isSampleCatalogId(catalogId)) throw new Error('القصيدة ليست من قصائد التجربة الثلاث.');
  const entry = POEM_CATALOG.find((item) => item.id === catalogId);
  if (!entry) throw new Error('مصدر صوت القصيدة غير موجود.');
  const poemId = `sample-${catalogId}`;
  const current = deps.getPoem();
  if (!current || current.id !== poemId || current.externalId !== entry.mizanPoemId || hasPoemAudio(current)) {
    return 'skipped';
  }

  deps.onPhase('downloading');
  const download = await deps.download(entry.youtubeUrl);
  if (!/^\/api(?:-worker)?\/youtube\/audio\/yt-[a-zA-Z0-9_-]{1,64}\/playback\.mp3$/.test(download.playback_audio_path)) {
    throw new Error('مسار الصوت الذي أعاده الخادم غير صالح.');
  }
  // The user may have deleted the sample or added their own recording while
  // the YouTube download was running.
  const afterDownload = deps.getPoem();
  if (!afterDownload || afterDownload.id !== poemId || hasPoemAudio(afterDownload)) return 'skipped';

  deps.onPhase('saving');
  const recording = await deps.cache({
    id: download.jobId ? `sample-audio-${catalogId}-${download.jobId}` : `sample-audio-${catalogId}`,
    audioUrl: deps.playableUrl(download.playback_audio_path),
    durationMs: Number.isFinite(download.duration_ms) && (download.duration_ms ?? 0) > 0
      ? download.duration_ms!
      : 0,
    reciter: CATALOG_RECITERS[entry.reciterId]?.name,
  });

  let attached = false;
  await deps.updatePoem(poemId, (latest) => {
    if (latest.externalId !== entry.mizanPoemId || hasPoemAudio(latest)) return latest;
    attached = true;
    return { ...latest, recording };
  });
  return attached ? 'attached' : 'skipped';
}