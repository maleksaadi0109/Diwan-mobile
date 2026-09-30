import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import type { Recording } from '@/lib/types';

const CACHE_DIRECTORY_NAME = 'recording-audio';
const RECORDING_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIO_EXTENSION_PATTERN = /^(mp3|m4a|wav|aac|ogg|flac)$/i;

function isSafeRecordingId(id: string): boolean {
  return RECORDING_ID_PATTERN.test(id);
}

function cacheDirectoryUri(): string | null {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) return null;
  return `${documentDirectory}${CACHE_DIRECTORY_NAME}/`;
}

function recordingCacheUri(recordingId: string, extension = 'mp3'): string | null {
  if (!isSafeRecordingId(recordingId)) return null;
  if (!AUDIO_EXTENSION_PATTERN.test(extension)) return null;
  const directory = cacheDirectoryUri();
  return directory ? `${directory}${recordingId}.${extension.toLowerCase()}` : null;
}

function recordingLocalUri(recording: Recording): string | null {
  const directory = cacheDirectoryUri();
  if (directory && isSafeRecordingId(recording.id) &&
      recording.audioUrl.startsWith(`${directory}${recording.id}.`)) {
    const extension = recording.audioUrl.slice(`${directory}${recording.id}.`.length);
    if (AUDIO_EXTENSION_PATTERN.test(extension)) return recording.audioUrl;
  }
  return recordingCacheUri(recording.id);
}

function isRemoteAudioUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Returns the canonical persistent cache URI when this recording's cache exists.
 * Invalid IDs, web, missing files, and filesystem errors all return null.
 */
export async function getCachedRecordingAudioUri(
  recording: Recording,
): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const uri = recordingLocalUri(recording);
  if (!uri) return null;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' && info.size > 0 ? uri : null;
  } catch {
    return null;
  }
}

/** True only when a non-empty local cache file exists for this recording. */
export async function isRecordingAudioCached(recording: Recording): Promise<boolean> {
  return (await getCachedRecordingAudioUri(recording)) !== null;
}

/**
 * Downloads a remote recording into persistent app storage and returns a copy
 * whose audioUrl is the local file URI and whose serverAudioUrl preserves the
 * original remote URL. Download and filesystem failures are thrown so callers
 * can retain the remote recording and show a cache warning.
 *
 * On web, file-system caching is unsupported: this resolves without throwing
 * and returns the remote URL in both audioUrl and serverAudioUrl for playback.
 */
export async function cacheRecordingAudio(recording: Recording): Promise<Recording> {
  const remoteAudioUrl = recording.serverAudioUrl ?? recording.audioUrl;
  if (Platform.OS === 'web') {
    // Browsers play the remote URL directly; local-cache URIs cannot be cached
    // or reliably persisted by this native-file-system helper.
    return isRemoteAudioUrl(remoteAudioUrl)
      ? { ...recording, audioUrl: remoteAudioUrl, serverAudioUrl: remoteAudioUrl }
      : recording;
  }

  if (!isSafeRecordingId(recording.id)) {
    throw new Error('Cannot cache recording: invalid recording ID.');
  }

  if (!isRemoteAudioUrl(remoteAudioUrl)) {
    throw new Error('Cannot cache recording: a valid HTTP(S) audio URL is required.');
  }

  const targetUri = recordingCacheUri(recording.id);
  const directoryUri = cacheDirectoryUri();
  if (!targetUri || !directoryUri) {
    throw new Error('Cannot cache recording: persistent app storage is unavailable.');
  }

  const cachedUri = await getCachedRecordingAudioUri(recording);
  if (cachedUri) {
    return { ...recording, audioUrl: cachedUri, serverAudioUrl: remoteAudioUrl };
  }

  try {
    await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
    const result = await FileSystem.downloadAsync(remoteAudioUrl, targetUri);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Audio download failed with HTTP status ${result.status}.`);
    }

    const info = await FileSystem.getInfoAsync(targetUri);
    if (!info.exists || !info.size) {
      throw new Error('Audio download completed but the cached file is empty.');
    }

    return { ...recording, audioUrl: targetUri, serverAudioUrl: remoteAudioUrl };
  } catch (error) {
    await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
    throw error instanceof Error
      ? error
      : new Error('Audio download failed for an unknown reason.');
  }
}

/** Persist an imported audio file independently of the document picker's temporary URI. */
export async function storeLocalRecordingAudio(recordingId: string, sourceUri: string, fileName: string): Promise<string> {
  if (Platform.OS === 'web') throw new Error('Local audio import requires the mobile app.');
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const target = recordingCacheUri(recordingId, extension);
  const directory = cacheDirectoryUri();
  if (!target || !directory) throw new Error('Unsupported audio format or unavailable storage.');
  const source = await FileSystem.getInfoAsync(sourceUri);
  if (!source.exists || !source.size) throw new Error('The selected audio file is empty.');
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.copyAsync({ from: sourceUri, to: target });
  return target;
}

export async function readOfflineRecordingAudio(recording: Recording): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const uri = await getCachedRecordingAudioUri(recording);
  if (!uri) return null;
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

export async function getOfflineRecordingFile(recording: Recording): Promise<File | null> {
  const uri = await getCachedRecordingAudioUri(recording);
  return uri ? new File(uri) : null;
}
/** The archive uses bounded chunks; never convert the whole recording to base64. */
export async function prepareOfflineRecordingAudio(id: string, extension: string): Promise<File> {
  const uri = recordingCacheUri(id, extension);
  const directory = cacheDirectoryUri();
  if (!uri || !directory) throw new Error('Invalid audio recording ID or extension.');
  // A different extension with the same recording ID is also an existing file.
  for (const ext of ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac']) {
    const candidate = recordingCacheUri(id, ext)!;
    if ((await FileSystem.getInfoAsync(candidate)).exists) {
      throw new Error('An audio file with this recording ID already exists.');
    }
  }
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const file = new File(uri);
  file.create();
  return file;
}

export async function restoreOfflineRecordingAudio(id: string, base64: string, extension = 'mp3'): Promise<string> {
  const file = await prepareOfflineRecordingAudio(id, extension);
  try {
    await FileSystem.writeAsStringAsync(file.uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  } catch (error) {
    try {
      await FileSystem.deleteAsync(file.uri, { idempotent: true });
    } catch (cleanupError) {
      const writeMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(
        `${writeMessage}\nتعذر حذف ملف الصوت الجديد ${file.uri} بعد فشل كتابته: ${cleanupMessage}. قد يبقى ملف جزئي على الجهاز ويحتاج إلى حذف يدوي.`,
        { cause: error },
      );
    }
    throw error;
  }
  return file.uri;
}
