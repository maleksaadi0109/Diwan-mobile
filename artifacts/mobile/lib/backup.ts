import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Poem, Playlist, Verse, VerseAlignment, Recording } from '@/lib/types';
import { poemRecordings } from './recordings';
import { getOfflineRecordingFile, prepareOfflineRecordingAudio, readOfflineRecordingAudio, restoreOfflineRecordingAudio } from './offlineAudio';
import * as FileSystem from 'expo-file-system/legacy';
import { File, FileMode, type FileHandle } from 'expo-file-system';

const POEMS_KEY = 'diwan.mobile.poems.v1';
const PLAYLISTS_KEY = 'diwan.mobile.playlists.v1';
const SETTINGS_KEY = 'diwan.mobile.settings.v1';

export const BACKUP_MAX_BYTES = 100 * 1024 * 1024;
const MAX_POEMS = 1_000;
const MAX_VERSES_PER_POEM = 500;
const MAX_TOTAL_VERSES = 50_000;
const MAX_PLAYLISTS = 500;
const MAX_POEMS_PER_PLAYLIST = 1_000;
const MAX_STRING_LENGTH = 10_000;

export interface MobileBackup {
  format: 'diwan-mobile-backup';
  version: 1 | 2;
  createdAt: string;
  poems: Poem[];
  playlists: Playlist[];
  settings: { fontSize: number };
  audioFiles?: { poemId: string; recordingId: string; base64: string }[];
}

const ARCHIVE_MAGIC = 'DIWAN01\n';

/** Validate original references before writing any restored poems or audio. */
export function assertBackupPlaylistReferences(
  backup: MobileBackup,
  currentPoemIds: string[],
): void {
  const availablePoemIds = new Set([
    ...currentPoemIds,
    ...backup.poems.map((poem) => poem.id),
  ]);
  for (const playlist of backup.playlists) {
    for (const poemId of playlist.poemIds) {
      if (!availablePoemIds.has(poemId)) {
        throw new Error(
          `القائمة "${playlist.name}" تشير إلى قصيدة غير موجودة في النسخة أو المكتبة الحالية. لم يتم تغيير أي بيانات.`,
        );
      }
    }
  }
}

/** Remap only imported playlists; two backup IDs may resolve to one local poem. */
export function remapBackupPlaylists(
  playlists: Playlist[],
  remappedIds: ReadonlyMap<string, string>,
): Playlist[] {
  return playlists.map((playlist) => ({
    ...playlist,
    poemIds: Array.from(new Set(playlist.poemIds.map((id) => remappedIds.get(id) ?? id))),
  }));
}

/** Commit the merge while retaining enough information to undo only this import's
 * additions if a later write fails. Existing poems, playlists and audio are never
 * candidates for cleanup. */
export async function restoreBackupMerge(
  backup: MobileBackup,
  existingPoemIds: string[],
  savePoem: (poem: Poem) => Promise<{ inserted: boolean; poemId: string }>,
  removePoems: (ids: string[]) => Promise<void>,
  mergePlaylists: (imported: Playlist[], availablePoemIds: string[]) => Promise<{ added: number; skipped: number }>,
  archive?: Extract<PickedBackup, { kind: 'archive' }>,
): Promise<{ added: number; skipped: number }> {
  assertBackupPlaylistReferences(backup, existingPoemIds);
  const poemIds = new Set(existingPoemIds);
  const remappedIds = new Map<string, string>();
  const insertedPoems: Poem[] = [];
  try {
    await restoreBackupAudio(backup, poemIds, archive, async (poem) => {
      const result = await savePoem(poem);
      poemIds.add(result.poemId);
      if (!result.inserted && result.poemId !== poem.id) remappedIds.set(poem.id, result.poemId);
      if (result.inserted) insertedPoems.push(poem);
      return result.inserted;
    });
    return await mergePlaylists(remapBackupPlaylists(backup.playlists, remappedIds), [...poemIds]);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    if (insertedPoems.length) {
      try {
        await removePoems(insertedPoems.map((poem) => poem.id));
      } catch (cleanupError) {
        // Keep the audio if its poem could still reference it.
        throw new Error(
          `${originalMessage}\nتعذر التراجع عن القصائد المضافة. احتفظ بالنسخة الاحتياطية وأعد المحاولة بعد تحرير مساحة التخزين. ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: error },
        );
      }
      const uris = [...new Set(insertedPoems.flatMap((poem) =>
        poemRecordings(poem).map((recording) => recording.audioUrl).filter((uri) => uri.startsWith('file:'))))];
      const results = await Promise.allSettled(uris.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true })));
      const leftover = uris.filter((_, i) => results[i].status === 'rejected');
      if (leftover.length) {
        throw new Error(
          `${originalMessage}\nتعذر حذف ملفات الصوت المضافة: ${leftover.join('، ')}. قد تحتاج إلى حذفها يدوياً.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, max = MAX_STRING_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)
  );
}

function validId(value: unknown): value is string {
  return boundedString(value, 128) && !/[\s]/.test(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateAlignment(value: unknown): value is VerseAlignment {
  if (!isObject(value) || !hasOnlyKeys(value, ['startMs', 'endMs', 'confidence'])) {
    return false;
  }
  return (
    typeof value.startMs === 'number' &&
    Number.isFinite(value.startMs) &&
    value.startMs >= 0 &&
    typeof value.endMs === 'number' &&
    Number.isFinite(value.endMs) &&
    value.endMs > value.startMs &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function validateVerse(value: unknown): value is Verse {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['id', 'orderIndex', 'text', 'alignment', 'recordingAlignments', 'externalId']) ||
    !validId(value.id) ||
    !Number.isSafeInteger(value.orderIndex) ||
    (value.orderIndex as number) < 0 ||
    !boundedString(value.text)
  ) {
    return false;
  }
  return (
    (value.alignment === undefined || validateAlignment(value.alignment)) &&
    (value.recordingAlignments === undefined || (
      isObject(value.recordingAlignments) &&
      Object.keys(value.recordingAlignments).length <= 50 &&
      Object.entries(value.recordingAlignments).every(([id, alignment]) => validId(id) && validateAlignment(alignment))
    )) &&
    (value.externalId === undefined ||
      (typeof value.externalId === 'string' && /^[0-9]{1,20}$/.test(value.externalId)))
  );
}

function validateRecording(value: unknown): value is Recording {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['id', 'audioUrl', 'serverAudioUrl', 'durationMs', 'title', 'reciter']) ||
    !validId(value.id) ||
    !boundedString(value.audioUrl, 2_048) ||
    !Number.isFinite(value.durationMs) ||
    (value.durationMs as number) < 0
  ) {
    return false;
  }
  return (value.serverAudioUrl === undefined || boundedString(value.serverAudioUrl, 2_048)) &&
    (value.title === undefined || boundedString(value.title, 500)) &&
    (value.reciter === undefined || boundedString(value.reciter, 500));
}

function validatePoem(value: unknown): value is Poem {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      'id',
      'title',
      'poetName',
      'era',
      'meter',
      'verses',
      'recording',
      'recordings',
      'selectedRecordingId',
      'coverImageUrl',
      'createdAt',
      'sourceUrl',
      'externalProvider',
      'externalId',
    ]) ||
    !validId(value.id) ||
    !boundedString(value.title, 500) ||
    !boundedString(value.poetName, 500) ||
    !Array.isArray(value.verses) ||
    value.verses.length > MAX_VERSES_PER_POEM ||
    !value.verses.every(validateVerse) ||
    !validTimestamp(value.createdAt)
  ) {
    return false;
  }
  if (value.recording !== undefined && !validateRecording(value.recording)) return false;
  if (value.recordings !== undefined && (
    !Array.isArray(value.recordings) || value.recordings.length > 50 ||
    !value.recordings.every(validateRecording) ||
    !haveUniqueIds(value.recordings as Recording[])
  )) return false;
  if (value.selectedRecordingId !== undefined &&
      (!validId(value.selectedRecordingId) ||
        !poemRecordings(value as unknown as Poem).some((r) => r.id === value.selectedRecordingId))) return false;
  for (const optional of ['era', 'meter', 'coverImageUrl', 'sourceUrl', 'externalProvider', 'externalId']) {
    if (value[optional] !== undefined && !boundedString(value[optional], 2_048)) return false;
  }
  return true;
}

function validatePlaylist(value: unknown): value is Playlist {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ['id', 'name', 'poemIds', 'createdAt']) &&
    validId(value.id) &&
    boundedString(value.name, 500) &&
    Array.isArray(value.poemIds) &&
    value.poemIds.length <= MAX_POEMS_PER_PLAYLIST &&
    value.poemIds.every(validId) &&
    validTimestamp(value.createdAt)
  );
}

function validateSettings(value: unknown): value is { fontSize: number } {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ['fontSize']) &&
    typeof value.fontSize === 'number' &&
    Number.isFinite(value.fontSize) &&
    value.fontSize >= 18 &&
    value.fontSize <= 40
  );
}

function parseStoredArray<T>(
  raw: string | null,
  label: string,
  validator: (item: unknown) => item is T,
  maxCount: number,
): T[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`تعذر تصدير ${label}: بيانات التخزين الحالية غير قابلة للقراءة.`);
  }
  if (!Array.isArray(value) || value.length > maxCount || !value.every(validator)) {
    throw new Error(`تعذر تصدير ${label}: بيانات التخزين الحالية غير صالحة.`);
  }
  return value;
}

function parseStoredSettings(raw: string | null): { fontSize: number } {
  if (raw === null) return { fontSize: 24 };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('تعذر تصدير الإعدادات: بيانات التخزين الحالية غير قابلة للقراءة.');
  }
  if (!validateSettings(value)) {
    throw new Error('تعذر تصدير الإعدادات: بيانات التخزين الحالية غير صالحة.');
  }
  return value;
}

function haveUniqueIds<T extends { id: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > BACKUP_MAX_BYTES) return bytes;
  }
  return bytes;
}

async function loadBackupData(): Promise<Omit<MobileBackup, 'audioFiles'>> {
  const stored = await AsyncStorage.multiGet([POEMS_KEY, PLAYLISTS_KEY, SETTINGS_KEY]);
  const values = new Map(stored);
  const poems = parseStoredArray(values.get(POEMS_KEY) ?? null, 'المكتبة', validatePoem, MAX_POEMS);
  const playlists = parseStoredArray(
    values.get(PLAYLISTS_KEY) ?? null,
    'قوائم التشغيل',
    validatePlaylist,
    MAX_PLAYLISTS,
  );
  if (poems.reduce((sum, poem) => sum + poem.verses.length, 0) > MAX_TOTAL_VERSES) {
    throw new Error('تعذر تصدير المكتبة: عدد الأبيات يتجاوز الحد المسموح.');
  }
  if (!haveUniqueIds(poems) || !haveUniqueIds(playlists)) {
    throw new Error('تعذر التصدير: توجد معرّفات مكررة في بيانات التخزين الحالية.');
  }
  const poemIds = new Set(poems.map((poem) => poem.id));
  if (playlists.some((playlist) => playlist.poemIds.some((id) => !poemIds.has(id)))) {
    throw new Error('تعذر التصدير: توجد قوائم تشير إلى قصائد غير موجودة في المكتبة.');
  }
  const seen = new Set<string>();
  for (const poem of poems) {
    for (const recording of poemRecordings(poem)) {
      if (seen.has(recording.id)) {
        throw new Error('تعذر التصدير: معرّف تسجيل مكرر في المكتبة.');
      }
      seen.add(recording.id);
    }
  }
  return {
    format: 'diwan-mobile-backup',
    version: 2,
    createdAt: new Date().toISOString(),
    poems,
    playlists,
    settings: parseStoredSettings(values.get(SETTINGS_KEY) ?? null),
  };
}
export async function createBackupJson(): Promise<string> {
  const data = await loadBackupData();
  const audioFiles: NonNullable<MobileBackup['audioFiles']> = [];
  for (const poem of data.poems) {
    for (const recording of poemRecordings(poem)) {
      const base64 = await readOfflineRecordingAudio(recording);
      if (base64) audioFiles.push({ poemId: poem.id, recordingId: recording.id, base64 });
      else if (recording.audioUrl.startsWith('file:')) {
        throw new Error(`تعذر التصدير: ملف صوت محلي مفقود للتسجيل ${recording.id}.`);
      }
    }
  }
  const backup: MobileBackup = { ...data, audioFiles };
  const json = JSON.stringify(backup, null, 2);
  if (utf8ByteLength(json) > BACKUP_MAX_BYTES) {
    throw new Error('حجم النسخة الاحتياطية أكبر من الحد المسموح (100 ميغابايت).');
  }
  return json;
}

/** Returns a temporary archive URI; caller must delete it after sharing. */
export async function createBackupArchive(): Promise<string> {
  const data = await loadBackupData();
  const directory = FileSystem.cacheDirectory;
  if (!directory) throw new Error('مساحة الملفات المؤقتة غير متاحة على هذا الجهاز.');
  const uri = `${directory}diwan-backup-${Date.now()}.diwan`;
  const sources: File[] = [];
  const entries: AudioEntry[] = [];
  for (const poem of data.poems) {
    for (const recording of poemRecordings(poem)) {
      const source = await getOfflineRecordingFile(recording);
      if (!source) {
        if (recording.audioUrl.startsWith('file:')) {
          throw new Error(`تعذر التصدير: ملف صوت محلي مفقود للتسجيل ${recording.id}.`);
        }
        continue;
      }
      if (!source.size || !Number.isSafeInteger(source.size)) throw new Error('ملف الصوت غير صالح.');
      sources.push(source);
      entries.push({ poemId: poem.id, recordingId: recording.id, extension: extensionFor(recording), size: source.size, crc32: 0 });
    }
  }
  // A first pass calculates checksums so the manifest precedes the raw audio.
  for (let index = 0; index < sources.length; index++) {
    const handle = sources[index].open(FileMode.ReadOnly);
    try {
      entries[index].crc32 = await transfer(handle, null, entries[index].size);
    } finally { handle.close(); }
  }
  const manifest: ArchiveManifest = { ...data, version: 3, audioEntries: entries };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('بيانات النسخة الاحتياطية كبيرة جداً.');
  const output = new File(uri);
  output.create();
  try {
    const writer = output.open(FileMode.WriteOnly);
    try {
      writer.writeBytes(header(manifestBytes.length));
      writer.writeBytes(manifestBytes);
      for (let index = 0; index < sources.length; index++) {
        const reader = sources[index].open(FileMode.ReadOnly);
        try {
          if (await transfer(reader, writer, entries[index].size) !== entries[index].crc32 ||
              reader.size !== entries[index].size) {
            throw new Error('تغير ملف صوت أثناء إنشاء النسخة. أعد المحاولة.');
          }
        } finally { reader.close(); }
      }
    } finally { writer.close(); }
    return uri;
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw error;
  }
}
/** Fail closed before restore if local storage is malformed, so context state
 * initialized as an empty list cannot accidentally overwrite damaged originals. */
export async function assertLocalStorageValid(): Promise<void> {
  const stored = await AsyncStorage.multiGet([POEMS_KEY, PLAYLISTS_KEY, SETTINGS_KEY]);
  const values = new Map(stored);
  const poems = parseStoredArray(values.get(POEMS_KEY) ?? null, 'المكتبة', validatePoem, MAX_POEMS);
  const playlists = parseStoredArray(
    values.get(PLAYLISTS_KEY) ?? null,
    'قوائم التشغيل',
    validatePlaylist,
    MAX_PLAYLISTS,
  );
  parseStoredSettings(values.get(SETTINGS_KEY) ?? null);
  if (
    poems.reduce((sum, poem) => sum + poem.verses.length, 0) > MAX_TOTAL_VERSES ||
    !haveUniqueIds(poems) ||
    !haveUniqueIds(playlists)
  ) {
    throw new Error('بيانات التخزين الحالية غير صالحة للاستعادة؛ لم يتم تغيير أي بيانات.');
  }
}

export function parseBackupJson(json: string): MobileBackup {
  if (utf8ByteLength(json) > BACKUP_MAX_BYTES) {
    throw new Error('ملف النسخة الاحتياطية أكبر من الحد المسموح (100 ميغابايت).');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('الملف ليس JSON صالحاً. لم يتم تغيير أي بيانات.');
  }
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['format', 'version', 'createdAt', 'poems', 'playlists', 'settings', 'audioFiles']) ||
    value.format !== 'diwan-mobile-backup' ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 64 ||
    !Array.isArray(value.poems) ||
    value.poems.length > MAX_POEMS ||
    !value.poems.every(validatePoem) ||
    !Array.isArray(value.playlists) ||
    value.playlists.length > MAX_PLAYLISTS ||
    !value.playlists.every(validatePlaylist) ||
    !validateSettings(value.settings) ||
    value.poems.reduce((sum: number, poem: Poem) => sum + poem.verses.length, 0) >
      MAX_TOTAL_VERSES ||
    !haveUniqueIds(value.poems as Poem[]) ||
    !haveUniqueIds(value.playlists as Playlist[]) ||
    (value.version === 2 && !Array.isArray(value.audioFiles))
  ) {
    throw new Error('بنية النسخة الاحتياطية غير صالحة أو غير مدعومة. لم يتم تغيير أي بيانات.');
  }
  if (value.version === 2) {
    const audioFiles = value.audioFiles as unknown[];
    const recordings = new Set((value.poems as Poem[]).flatMap((poem) =>
      poemRecordings(poem).map((r) => `${poem.id}:${r.id}`)));
    const allRecordingIds = (value.poems as Poem[]).flatMap((poem) =>
      poemRecordings(poem).map((r) => r.id));
    if (new Set(allRecordingIds).size !== allRecordingIds.length) {
      throw new Error('معرّفات التسجيلات مكررة في النسخة الاحتياطية.');
    }
    const audioIds = new Set<string>();
    if (audioFiles.length > MAX_POEMS * 50 || !audioFiles.every((entry) => {
      if (!isObject(entry) || !hasOnlyKeys(entry, ['poemId', 'recordingId', 'base64']) ||
          !validId(entry.poemId) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(entry.recordingId)) ||
          typeof entry.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.base64)) return false;
      const key = `${entry.poemId}:${entry.recordingId}`;
      if (!recordings.has(key) || audioIds.has(key)) return false;
      audioIds.add(key);
      return true;
    })) throw new Error('ملفات الصوت في النسخة غير صالحة.');
  }
  return value as unknown as MobileBackup;
}

async function parseArchive(uri: string): Promise<PickedBackup> {
  const file = new File(uri);
  const reader = file.open(FileMode.ReadOnly);
  try {
    if (reader.size === null || reader.size < HEADER_SIZE) throw new Error('ملف النسخة الاحتياطية غير مكتمل.');
    const prefix = readExact(reader, HEADER_SIZE);
    if (Array.from(prefix.slice(0, 8), (byte) => String.fromCharCode(byte)).join('') !== ARCHIVE_MAGIC) {
      throw new Error('صيغة الأرشيف غير مدعومة.');
    }
    const length = new DataView(prefix.buffer, prefix.byteOffset, HEADER_SIZE).getUint32(8, false);
    if (length === 0 || length > MAX_MANIFEST_BYTES || length > reader.size - HEADER_SIZE) {
      throw new Error('بيانات الأرشيف غير صالحة.');
    }
    let manifest: unknown;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExact(reader, length))); }
    catch { throw new Error('بيانات الأرشيف غير قابلة للقراءة.'); }
    if (!isObject(manifest) ||
        !hasOnlyKeys(manifest, ['format', 'version', 'createdAt', 'poems', 'playlists', 'settings', 'audioEntries']) ||
        manifest.version !== 3 || !Array.isArray(manifest.audioEntries)) {
      throw new Error('بنية الأرشيف غير مدعومة.');
    }
    const backup = parseBackupJson(JSON.stringify({
      format: manifest.format, version: 2, createdAt: manifest.createdAt,
      poems: manifest.poems, playlists: manifest.playlists, settings: manifest.settings, audioFiles: [],
    }));
    const recordings = new Set(backup.poems.flatMap((poem) =>
      poemRecordings(poem).map((r) => `${poem.id}:${r.id}`)));
    const ids = backup.poems.flatMap((poem) => poemRecordings(poem).map((r) => r.id));
    if (new Set(ids).size !== ids.length || manifest.audioEntries.length > MAX_POEMS * 50) {
      throw new Error('معرّفات التسجيلات مكررة أو كثيرة جداً.');
    }
    const seen = new Set<string>();
    const entries: (AudioEntry & { offset: number })[] = [];
    let offset = HEADER_SIZE + length;
    for (const raw of manifest.audioEntries) {
      if (!isObject(raw) || !hasOnlyKeys(raw, ['poemId', 'recordingId', 'extension', 'size', 'crc32']) ||
          !validId(raw.poemId) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(raw.recordingId)) ||
          typeof raw.extension !== 'string' || !AUDIO_EXT.test(raw.extension) ||
          !Number.isSafeInteger(raw.size) || (raw.size as number) <= 0 ||
          !Number.isInteger(raw.crc32) || (raw.crc32 as number) < 0 || (raw.crc32 as number) > 0xffffffff) {
        throw new Error('ملفات الصوت في الأرشيف غير صالحة.');
      }
      const key = `${raw.poemId}:${raw.recordingId}`;
      if (!recordings.has(key) || seen.has(key)) throw new Error('ملفات الصوت في الأرشيف غير صالحة.');
      seen.add(key);
      const size = raw.size as number;
      if (size > reader.size - offset) throw new Error('ملف النسخة الاحتياطية غير مكتمل.');
      entries.push({ poemId: raw.poemId, recordingId: raw.recordingId as string, extension: raw.extension, size, crc32: raw.crc32 as number, offset });
      offset += size;
    }
    if (offset !== reader.size) throw new Error('يحتوي الأرشيف بيانات غير متوقعة.');
    // Verify all audio before presenting the confirmation prompt or changing storage.
    for (const entry of entries) {
      reader.offset = entry.offset;
      if (await transfer(reader, null, entry.size) !== entry.crc32) throw new Error('ملف صوت تالف في الأرشيف.');
    }
    return { kind: 'archive', backup, uri, entries };
  } finally { reader.close(); }
}
/** Restore new poems one at a time; skipped and uncommitted audio is removed. */
export async function restoreBackupAudio(
  backup: MobileBackup,
  existingPoemIds: Set<string>,
  archiveOrSave?: Extract<PickedBackup, { kind: 'archive' }> | ((poem: Poem) => Promise<boolean | void>),
  savePoem?: (poem: Poem) => Promise<boolean | void>,
): Promise<Poem[]> {
  const archive = typeof archiveOrSave === 'function' ? undefined : archiveOrSave;
  const persist = typeof archiveOrSave === 'function' ? archiveOrSave : savePoem;
  const files = backup.audioFiles ?? [];
  const restored: Poem[] = [];
  let createdUris: string[] = [];
  try {
    for (const poem of backup.poems) {
      if (existingPoemIds.has(poem.id)) continue;
      const next = { ...poem };
      const recordings = poemRecordings(poem);
      const updated: Recording[] = [];
      for (const recording of recordings) {
        const file = files.find((item) => item.poemId === poem.id && item.recordingId === recording.id);
        const entry = archive?.entries.find((item) => item.poemId === poem.id && item.recordingId === recording.id);
        if (!file && !entry && recording.audioUrl.startsWith('file:') && !recording.serverAudioUrl) {
          throw new Error(`النسخة لا تحتوي ملف الصوت المحلي للتسجيل ${recording.id}.`);
        }
        const extension = extensionFor(recording);
        let uri = file ? await restoreOfflineRecordingAudio(recording.id, file.base64, extension) : undefined;
        if (entry && archive) {
          const target = await prepareOfflineRecordingAudio(recording.id, entry.extension);
          createdUris.push(target.uri);
          const reader = new File(archive.uri).open(FileMode.ReadOnly);
          try {
            const writer = target.open(FileMode.WriteOnly);
            try {
              reader.offset = entry.offset;
              if (await transfer(reader, writer, entry.size) !== entry.crc32) throw new Error('ملف صوت تالف في الأرشيف.');
            } finally { writer.close(); }
          } finally { reader.close(); }
          uri = target.uri;
        }
        if (uri && !entry) createdUris.push(uri);
        updated.push(uri ? { ...recording, audioUrl: uri } :
          recording.audioUrl.startsWith('file:') && recording.serverAudioUrl
            ? { ...recording, audioUrl: recording.serverAudioUrl } : recording);
      }
      next.recordings = updated;
      next.recording = updated.find((item) => item.id === poem.recording?.id);
      if (persist) {
        const inserted = await persist(next);
        if (inserted === false) {
          await Promise.all(createdUris.map((uri) =>
            FileSystem.deleteAsync(uri, { idempotent: true })));
          createdUris = [];
          continue;
        }
        createdUris = [];
      }
      restored.push(next);
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(createdUris.map((uri) =>
      FileSystem.deleteAsync(uri, { idempotent: true })));
    const notDeleted = createdUris.filter((_, index) => cleanup[index].status === 'rejected');
    if (notDeleted.length > 0) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${originalMessage}\nتعذر حذف ملفات الصوت الجديدة التالية بعد فشل الاستعادة: ${notDeleted.join('، ')}. قد تبقى هذه الملفات على الجهاز وتحتاج إلى حذف يدوي.`,
      );
    }
    throw error;
  }
  return restored;
}

export async function pickBackupJson(): Promise<string | null> {
  const DocumentPicker = await import('expo-document-picker');
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/json', 'text/plain'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error('لم يتم العثور على ملف محدد.');
  if (typeof asset.size === 'number' && asset.size > BACKUP_MAX_BYTES) {
    throw new Error('الملف أكبر من الحد المسموح (100 ميغابايت).');
  }
  const FileSystem = await import('expo-file-system/legacy');
  const info = await FileSystem.getInfoAsync(asset.uri);
  if (info.exists && typeof info.size === 'number' && info.size > BACKUP_MAX_BYTES) {
    throw new Error('الملف أكبر من الحد المسموح (100 ميغابايت).');
  }
  const json = await FileSystem.readAsStringAsync(asset.uri);
  if (utf8ByteLength(json) > BACKUP_MAX_BYTES) {
    throw new Error('الملف أكبر من الحد المسموح (100 ميغابايت).');
  }
  return json;
}

export async function shareBackup(json: string): Promise<void> {
  const FileSystem = await import('expo-file-system/legacy');
  const Sharing = await import('expo-sharing');
  const directory = FileSystem.cacheDirectory;
  if (!directory) throw new Error('مساحة الملفات المؤقتة غير متاحة على هذا الجهاز.');
  const uri = `${directory}diwan-backup-${Date.now()}.json`;
  await FileSystem.writeAsStringAsync(uri, json, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('مشاركة الملفات غير متاحة على هذا الجهاز.');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    dialogTitle: 'تصدير نسخة ديوان الاحتياطية',
    UTI: 'public.json',
  });
}

export async function shareBackupArchive(uri: string): Promise<void> {
  try {
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) throw new Error('مشاركة الملفات غير متاحة على هذا الجهاز.');
    await Sharing.shareAsync(uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: 'تصدير نسخة ديوان الاحتياطية',
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}

async function transfer(source: FileHandle, destination: FileHandle | null, length: number): Promise<number> {
  let crc = 0;
  for (let remaining = length; remaining > 0;) {
    const bytes = readExact(source, Math.min(remaining, CHUNK_SIZE));
    crc = checksum(bytes, crc);
    destination?.writeBytes(bytes);
    remaining -= bytes.length;
    // Native handles operate synchronously; let the UI render between chunks.
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return crc;
}

const CHUNK_SIZE = 256 * 1024;

const HEADER_SIZE = 12;

function header(length: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_SIZE);
  for (let i = 0; i < ARCHIVE_MAGIC.length; i++) bytes[i] = ARCHIVE_MAGIC.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(8, length, false);
  return bytes;
}

export async function discardPickedBackup(picked: PickedBackup): Promise<void> {
  if (picked.kind === 'archive') {
    await FileSystem.deleteAsync(picked.uri, { idempotent: true }).catch(() => undefined);
  }
}

const AUDIO_EXT = /^(mp3|m4a|wav|aac|ogg|flac)$/i;

export async function pickBackup(): Promise<PickedBackup | null> {
  const DocumentPicker = await import('expo-document-picker');
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/json', 'text/plain', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error('لم يتم العثور على ملف محدد.');
  if (asset.name.toLowerCase().endsWith('.json')) {
    const info = await FileSystem.getInfoAsync(asset.uri);
    if ((asset.size ?? (info.exists ? info.size : 0) ?? 0) > BACKUP_MAX_BYTES ||
        (info.exists && (info.size ?? 0) > BACKUP_MAX_BYTES)) {
      throw new Error('ملف JSON أكبر من الحد المسموح (100 ميغابايت).');
    }
    return { kind: 'json', backup: parseBackupJson(await FileSystem.readAsStringAsync(asset.uri)) };
  }
  try {
    return await parseArchive(asset.uri);
  } catch (error) {
    if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) {
      await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined);
    }
    throw error;
  }
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function checksum(bytes: Uint8Array, initial = 0): number {
  let crc = initial ^ 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extensionFor(recording: Recording): string {
  return recording.audioUrl.match(/\.(mp3|m4a|wav|aac|ogg|flac)$/i)?.[1]?.toLowerCase() ?? 'mp3';
}

function readExact(handle: FileHandle, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const bytes = handle.readBytes(length - offset);
    if (!bytes.length) throw new Error('ملف النسخة الاحتياطية غير مكتمل.');
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}

export type PickedBackup =
  | { kind: 'json'; backup: MobileBackup }
  | { kind: 'archive'; backup: MobileBackup; uri: string; entries: (AudioEntry & { offset: number })[] };

type AudioEntry = { poemId: string; recordingId: string; extension: string; size: number; crc32: number };

type ArchiveManifest = Omit<MobileBackup, 'audioFiles' | 'version'> & {
  version: 3;
  audioEntries: AudioEntry[];
};
