import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlignmentResult } from '@/lib/api';
import type { Verse } from '@/lib/types';

const STORAGE_KEY = 'diwan.mobile.pending-alignment.v1';
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export interface PendingAlignmentImport {
  jobId: string;
  poem: {
    id: string;
    title: string;
    poetName: string;
    era?: string;
    meter?: string;
    verses: Verse[];
    createdAt: number;
    sourceUrl: string;
    externalProvider: 'mizan_al_arab';
    externalId: string;
    coverImageUrl?: string;
  };
  recording: {
    id: string;
    playbackAudioPath: string;
    durationMs: number;
    reciter?: string;
  };
  alignment?: AlignmentResult;
}

function isBoundedString(value: unknown, maxLength = 20_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(value: object, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidAlignment(value: unknown): value is AlignmentResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !hasOnlyKeys(value, ['alignments']) ||
    !Array.isArray((value as AlignmentResult).alignments)
  ) {
    return false;
  }
  return (value as AlignmentResult).alignments.every((item) =>
    item &&
    hasOnlyKeys(item, ['verse_id', 'start_ms', 'end_ms', 'confidence']) &&
    isBoundedString(item.verse_id, 200) &&
    Number.isFinite(item.start_ms) &&
    Number.isFinite(item.end_ms) &&
    Number.isFinite(item.confidence),
  );
}

export function isPendingAlignmentImport(value: unknown): value is PendingAlignmentImport {
  if (!value || typeof value !== 'object') return false;
  const draft = value as PendingAlignmentImport;
  const poem = draft.poem;
  const recording = draft.recording;
  if (
    typeof draft.jobId !== 'string' ||
    !JOB_ID_PATTERN.test(draft.jobId) ||
    !poem ||
    !recording ||
    !hasOnlyKeys(draft, ['jobId', 'poem', 'recording', 'alignment']) ||
    !hasOnlyKeys(poem, [
      'id',
      'title',
      'poetName',
      'era',
      'meter',
      'verses',
      'createdAt',
      'sourceUrl',
      'externalProvider',
      'externalId',
      'coverImageUrl',
    ]) ||
    !hasOnlyKeys(recording, ['id', 'playbackAudioPath', 'durationMs', 'reciter']) ||
    !isBoundedString(poem.id, 200) ||
    !isBoundedString(poem.title) ||
    !isBoundedString(poem.poetName) ||
    (poem.era !== undefined && !isBoundedString(poem.era, 500)) ||
    (poem.meter !== undefined && !isBoundedString(poem.meter, 500)) ||
    (poem.coverImageUrl !== undefined && !isBoundedString(poem.coverImageUrl, 4000)) ||
    !isBoundedString(poem.externalId, 500) ||
    poem.externalProvider !== 'mizan_al_arab' ||
    !isBoundedString(poem.sourceUrl, 2000) ||
    !Array.isArray(poem.verses) ||
    poem.verses.length < 1 ||
    poem.verses.length > 1000 ||
    !isBoundedString(recording.id, 200) ||
    (recording.reciter !== undefined && !isBoundedString(recording.reciter, 100)) ||
    typeof recording.playbackAudioPath !== 'string' ||
    recording.playbackAudioPath.length > 2000 ||
    !/^\/(?:api|api-worker)\//.test(recording.playbackAudioPath) ||
    !Number.isFinite(recording.durationMs) ||
    !Number.isFinite(poem.createdAt)
  ) {
    return false;
  }
  const verseIds = new Set<string>();
  for (const verse of poem.verses) {
    if (
      !verse ||
      !hasOnlyKeys(verse, ['id', 'orderIndex', 'text', 'externalId', 'alignment']) ||
      !isBoundedString(verse.id, 200) ||
      !isBoundedString(verse.text) ||
      !Number.isInteger(verse.orderIndex) ||
      (verse.externalId !== undefined && !isBoundedString(verse.externalId, 500)) ||
      (verse.alignment !== undefined &&
        (!verse.alignment ||
          !hasOnlyKeys(verse.alignment, ['startMs', 'endMs', 'confidence']) ||
          !Number.isFinite(verse.alignment.startMs) ||
          !Number.isFinite(verse.alignment.endMs) ||
          !Number.isFinite(verse.alignment.confidence))) ||
      verseIds.has(verse.id)
    ) {
      return false;
    }
    verseIds.add(verse.id);
  }
  return draft.alignment === undefined || isValidAlignment(draft.alignment);
}

export async function readPendingAlignmentImport(): Promise<PendingAlignmentImport | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPendingAlignmentImport(parsed)) return parsed;
  } catch {
    // Invalid persisted data is removed below rather than being used unsafely.
  }
  await AsyncStorage.removeItem(STORAGE_KEY);
  throw new Error('تعذر استعادة مسودة الاستيراد المحفوظة؛ حُذفت المسودة غير الصالحة.');
}

export async function savePendingAlignmentImport(draft: PendingAlignmentImport): Promise<void> {
  if (!isPendingAlignmentImport(draft)) {
    throw new Error('بيانات مسودة الاستيراد غير صالحة، لم تُحفظ عملية المزامنة.');
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export async function clearPendingAlignmentImport(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}