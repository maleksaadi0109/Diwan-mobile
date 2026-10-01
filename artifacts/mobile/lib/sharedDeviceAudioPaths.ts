const OWNED_RECORDING_ID = /^yt-local-\d+-[a-z0-9]+$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ValidatedDeviceAudioPath =
  | { storageVersion: 1; uri: string }
  | { storageVersion: 2; uri: string; token: string };

function withTrailingSlash(directory: string): string {
  return directory.endsWith('/') ? directory : `${directory}/`;
}

export function isOwnedDeviceRecordingId(id: string): boolean {
  return typeof id === 'string' && OWNED_RECORDING_ID.exec(id)?.[0] === id;
}

export function isCanonicalDeviceAudioToken(token: string): boolean {
  return typeof token === 'string' && CANONICAL_UUID.exec(token)?.[0] === token;
}

export function legacyDeviceAudioUri(documentDirectory: string, recordingId: string): string | null {
  if (!documentDirectory || !isOwnedDeviceRecordingId(recordingId)) return null;
  return `${withTrailingSlash(documentDirectory)}recording-audio/${recordingId}.mp3`;
}

export function nestedDeviceAudioUri(
  documentDirectory: string,
  recordingId: string,
  token: string,
): string | null {
  if (!documentDirectory || !isOwnedDeviceRecordingId(recordingId) || !isCanonicalDeviceAudioToken(token)) {
    return null;
  }
  return `${withTrailingSlash(documentDirectory)}recording-audio/.diwan-v2/${recordingId}/${token}/audio.mp3`;
}

/** Recognize only the exact flat legacy URI or canonical UUID-owned v2 bundle URI. */
export function validateDeviceAudioUri(
  documentDirectory: string,
  recordingId: string,
  uri: string,
): ValidatedDeviceAudioPath | null {
  if (typeof uri !== 'string' || !documentDirectory || !isOwnedDeviceRecordingId(recordingId)) return null;
  const legacy = legacyDeviceAudioUri(documentDirectory, recordingId);
  if (uri === legacy) return { storageVersion: 1, uri };

  const prefix = `${withTrailingSlash(documentDirectory)}recording-audio/.diwan-v2/${recordingId}/`;
  const suffix = '/audio.mp3';
  if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) return null;
  const token = uri.slice(prefix.length, -suffix.length);
  if (!isCanonicalDeviceAudioToken(token) || nestedDeviceAudioUri(documentDirectory, recordingId, token) !== uri) {
    return null;
  }
  return { storageVersion: 2, uri, token };
}

/** Identify this reserved subtree even when its URI is malformed, so it cannot
 * be mistaken for a flat cache file or used as a generic output target. */
export function isReservedDeviceAudioUri(documentDirectory: string, uri: string): boolean {
  if (!documentDirectory || typeof uri !== 'string') return false;
  const namespace = `${withTrailingSlash(documentDirectory)}recording-audio/.diwan-v2`;
  return uri.startsWith(namespace);
}