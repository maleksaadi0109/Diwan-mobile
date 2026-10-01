import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import type { Recording } from './types';
import {
  isCanonicalDeviceAudioToken,
  isOwnedDeviceRecordingId,
  validateDeviceAudioUri,
} from './sharedDeviceAudioPaths';

export type DeviceYoutubeOperation = {
  recordingId: string;
  url: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  audioUrl?: string;
  storageVersion?: number;
  token?: string;
  durationMs?: number;
  errorCode?: string;
};

interface DeviceDownloader {
  start(url: string, recordingId: string): Promise<void>;
  list(): Promise<DeviceYoutubeOperation[]>;
  cancel(recordingId: string): Promise<void>;
  acknowledge(recordingId: string): Promise<void>;
  discard(recordingId: string): Promise<void>;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const POLL_MS = 750;
const TERMINAL_RELEASE_TIMEOUT_MS = 10_000;
const STORAGE_STAGES = [
  'STORE_INIT', 'JOURNAL_READ', 'JOURNAL_WRITE', 'JOURNAL_SYNC', 'JOURNAL_DELETE',
  'PROGRESS_SAVE', 'STAGE_CREATE', 'AUDIO_EXISTS', 'WITNESS_CREATE', 'WITNESS_COPY',
  'WITNESS_VERIFY', 'WITNESS_STAT', 'WITNESS_SYNC', 'PUBLICATION_LINK',
  'PUBLICATION_JOURNAL', 'COMPLETION_JOURNAL', 'ENGINE_INSTALL_SYNC',
] as const;
const STORAGE_ERRNOS = [
  'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EEXIST', 'ENOENT',
  'EXDEV', 'EOPNOTSUPP', 'EIO', 'ENOTDIR', 'UNKNOWN',
] as const;
const STORAGE_DIAGNOSTIC = new RegExp(
  `^E_STORAGE_STAGE_ERRNO:(${STORAGE_STAGES.join('|')}):(${STORAGE_ERRNOS.join('|')})$`,
);

/** Android never silently falls back to the cloud if this native module is absent. */
export const usesDeviceYoutubeDownloads = () => Platform.OS === 'android';

export function normalizeYoutubeVideoUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('رابط يوتيوب غير صالح.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('أدخل رابط فيديو يوتيوب كاملًا.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('رابط يوتيوب غير صالح.');
  }
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error('اختر رابط فيديو يوتيوب واحد، وليس قناة أو قائمة تشغيل.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function getYoutubeThumbnail(input: string): string {
  const id = new URL(normalizeYoutubeVideoUrl(input)).searchParams.get('v')!;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function createDeviceYoutubeRecordingId(): string {
  return `yt-local-${Date.now()}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function localUri(id: string): string {
  if (!isOwnedDeviceRecordingId(id) || !FileSystem.documentDirectory) throw new Error('مسار التسجيل المحلي غير صالح.');
  return `${FileSystem.documentDirectory}recording-audio/${id}.mp3`;
}

function requireDownloader(): DeviceDownloader {
  if (!usesDeviceYoutubeDownloads()) throw new Error('التنزيل المباشر على الجهاز متاح لأندرويد فقط.');
  const native = requireOptionalNativeModule<DeviceDownloader>('DiwanDownloader');
  if (!hasServiceApi(native)) throw new Error('هذه النسخة لا تحتوي محرك تنزيل الصوت. ثبّت APK جديدًا مبنيًا بعد إضافة الميزة؛ Expo Go لا يدعمها.');
  return native;
}

function hasServiceApi(native: DeviceDownloader | null): native is DeviceDownloader {
  return !!native && ['start', 'list', 'cancel', 'acknowledge', 'discard']
    .every((method) => typeof native[method as keyof DeviceDownloader] === 'function');
}

/** Passive recovery must work on iOS and old APKs without requiring the module. */
export async function listDeviceYoutubeOperations(): Promise<DeviceYoutubeOperation[]> {
  if (!usesDeviceYoutubeDownloads()) return [];
  const native = requireOptionalNativeModule<DeviceDownloader>('DiwanDownloader');
  return hasServiceApi(native) ? native.list() : [];
}

export async function cancelDeviceYoutubeOperation(id: string): Promise<void> {
  localUri(id);
  await requireDownloader().cancel(id);
}

/** Call only after the recording has been durably saved; acknowledgement retains its file. */
export async function acknowledgeDeviceYoutubeRecording(id: string): Promise<void> {
  localUri(id);
  const native = requireDownloader();
  await retryTerminalRelease(() => native.acknowledge(id));
}

/** Native owns the journal and alone decides whether a completed file is still discardable. */
export async function deleteDeviceYoutubeRecording(recording: Recording): Promise<void> {
  localUri(recording.id);
  const documentDirectory = FileSystem.documentDirectory;
  const recordingPath = documentDirectory
    ? validateDeviceAudioUri(documentDirectory, recording.id, recording.audioUrl)
    : null;
  if (!recordingPath) throw new Error('لا يمكن حذف تسجيل خارج مجلد التنزيل أو بمسار غير مملوك.');
  const native = requireDownloader();
  const operation = (await native.list()).find((entry) => entry.recordingId === recording.id);
  const operationPath = operation?.audioUrl && documentDirectory
    ? validatedOperationAudioPath(operation, documentDirectory)
    : null;
  if (!operation || operation.state !== 'completed' || !operationPath ||
      operation.audioUrl !== recording.audioUrl || operationPath.uri !== recordingPath.uri ||
      operationPath.storageVersion !== recordingPath.storageVersion ||
      (operationPath.storageVersion === 2 && recordingPath.storageVersion === 2 &&
        operationPath.token !== recordingPath.token)) {
    throw new Error('لا يمكن تنظيف ملف تنزيل محفوظ أو غير مملوك لعملية مكتملة.');
  }
  try {
    await retryTerminalRelease(() => native.discard(recording.id));
  } catch {
    throw new Error('تعذر تنظيف ملف التنزيل غير المحفوظ؛ قد يظل الملف يشغل مساحة على الجهاز.');
  }
}

/** Native can publish a terminal journal before its worker releases ownership. */
async function retryTerminalRelease(action: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + TERMINAL_RELEASE_TIMEOUT_MS;
  while (true) {
    try {
      await action();
      return;
    } catch (error) {
      if (nativeErrorCode(error) !== 'E_BUSY' || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - Date.now())));
    }
  }
}

function abortError(): Error {
  const error = new Error('تم إلغاء تنزيل الصوت.');
  error.name = 'AbortError';
  return error;
}

function nativeErrorCode(error: unknown): string {
  try {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  } catch {
    return '';
  }
}

function downloadError(error: unknown): Error {
  const code = nativeErrorCode(error);
  const storageDiagnostic = STORAGE_DIAGNOSTIC.exec(code);
  if (storageDiagnostic && storageDiagnostic[0] === code) {
    const message = storageDiagnostic[2] === 'ENOSPC' || storageDiagnostic[2] === 'EDQUOT'
      ? 'تعذر حفظ الصوت على الجهاز بسبب نفاد المساحة أو الحصة التخزينية.'
      : 'تعذر حفظ الصوت على الجهاز.';
    return new Error(`${message} رمز التشخيص: ${code}.`);
  }
  const messages: Record<string, string> = {
    E_ENGINE_UPDATE: 'تعذر تجهيز أحدث محرك لتنزيل يوتيوب. أرسل رمز التشخيص إلى الدعم: E_ENGINE_UPDATE.',
    E_DOWNLOADER_INIT: 'تعذرت تهيئة محمّل yt-dlp على الجهاز. أرسل رمز التشخيص إلى الدعم: E_DOWNLOADER_INIT.',
    E_CONVERTER_INIT: 'تعذرت تهيئة محوّل الصوت FFmpeg على الجهاز. أرسل رمز التشخيص إلى الدعم: E_CONVERTER_INIT.',
    E_ENGINE_INSTALL: 'تعذر تثبيت محرك yt-dlp الموثوق المضمّن في التطبيق. أرسل رمز التشخيص إلى الدعم: E_ENGINE_INSTALL.',
    E_ENGINE_UPDATE_NETWORK: 'تعذر الاتصال لتنزيل تحديث محرك يوتيوب. تحقق من اتصال الإنترنت ثم أعد المحاولة. رمز التشخيص: E_ENGINE_UPDATE_NETWORK.',
    E_ENGINE_PACKAGE_INVALID: 'حزمة محرك yt-dlp المضمّنة في التطبيق غير صالحة. أرسل رمز التشخيص إلى الدعم: E_ENGINE_PACKAGE_INVALID.',
    E_ENGINE_PREFERENCE_WRITE: 'تعذر حفظ حالة التحقق من تحديث محرك يوتيوب على الجهاز. أرسل رمز التشخيص إلى الدعم: E_ENGINE_PREFERENCE_WRITE.',
    E_LOGIN_REQUIRED: 'يوتيوب يطلب تسجيل الدخول لهذا المقطع. اختر مقطعًا عامًا آخر؛ لن تُرسل بيانات حسابك إلى أي خادم.',
    E_CANCELLED: 'تم إلغاء تنزيل الصوت.',
    E_BUSY: 'يوجد تنزيل صوت آخر قيد التنفيذ. انتظر اكتماله أو ألغِه ثم أعد المحاولة.',
    E_INVALID_URL: 'رابط فيديو يوتيوب غير صالح.',
    E_STORAGE: 'تعذر حفظ الصوت على الجهاز. رمز التشخيص: E_STORAGE.',
    E_DOWNLOAD_FAILED: 'تعذر تنزيل الصوت من يوتيوب على الجهاز. تحقق من الإنترنت؛ قد يكون المقطع غير متاح أو غير مدعوم.',
    E_FOREGROUND_REQUIRED: 'افتح التطبيق لبدء تنزيل الصوت؛ لا يمكن بدء تنزيل جديد في الخلفية.',
    E_INTERRUPTED: 'انقطع تنزيل الصوت. أعد المحاولة يدويًا بمعرّف تنزيل جديد.',
    E_TIMEOUT: 'انتهت مهلة تنزيل الصوت على الجهاز. تحقق من الاتصال وأعد المحاولة يدويًا.',
    E_CLEANUP: 'تعذر تنظيف ملفات التنزيل المؤقتة على الجهاز. أرسل رمز التشخيص إلى الدعم: E_CLEANUP.',
    E_PROVENANCE: 'تعذر التحقق من ملكية ملف الصوت المحفوظ، لذلك لم يُستخدم أو يُحذف. أرسل رمز التشخيص إلى الدعم: E_PROVENANCE.',
    E_NOTIFICATION: 'تعذر عرض إشعار تنزيل الصوت. تحقق من إعدادات إشعارات التطبيق وأعد المحاولة.',
  };
  if (code === 'E_CANCELLED') return abortError();
  if (Object.prototype.hasOwnProperty.call(messages, code)) return new Error(messages[code]);
  return new Error('تعذر تنزيل الصوت على الجهاز. تحقق من الإنترنت ثم أعد المحاولة.');
}

function operationError(operation: DeviceYoutubeOperation): Error {
  if (operation.state === 'interrupted') {
    return new Error('انقطع تنزيل الصوت بعد إغلاق التطبيق أو إعادة تشغيل الجهاز. أعد المحاولة يدويًا بمعرّف تنزيل جديد.');
  }
  if (operation.state === 'cancelled') return abortError();
  return downloadError({ code: operation.errorCode });
}

async function completedRecording(operation: DeviceYoutubeOperation): Promise<Recording> {
  localUri(operation.recordingId);
  const documentDirectory = FileSystem.documentDirectory;
  const validatedPath = documentDirectory
    ? validatedOperationAudioPath(operation, documentDirectory)
    : null;
  if (!validatedPath || typeof operation.audioUrl !== 'string' ||
      typeof operation.durationMs !== 'number' ||
      !Number.isFinite(operation.durationMs) || operation.durationMs <= 0 ||
      operation.durationMs > 2 * 60 * 60 * 1000) {
    throw new Error('ملف الصوت الذي أنتجه محرك التنزيل غير صالح؛ لم تتم إضافته إلى المكتبة.');
  }
  const audioUrl = validatedPath.uri;
  const info = await FileSystem.getInfoAsync(audioUrl);
  if (!info.exists || !info.size) {
    throw new Error('ملف الصوت الذي أنتجه محرك التنزيل غير صالح؛ لم تتم إضافته إلى المكتبة.');
  }
  return { id: operation.recordingId, audioUrl, durationMs: operation.durationMs };
}

function validatedOperationAudioPath(
  operation: DeviceYoutubeOperation,
  documentDirectory: string,
) {
  const hasVersion = Object.prototype.hasOwnProperty.call(operation, 'storageVersion');
  const hasToken = Object.prototype.hasOwnProperty.call(operation, 'token');
  if (typeof operation.audioUrl !== 'string') return null;
  const path = validateDeviceAudioUri(documentDirectory, operation.recordingId, operation.audioUrl);
  if (!path) return null;
  if (!hasVersion && !hasToken) {
    return path.storageVersion === 1 ? path : null;
  }
  if (hasVersion && hasToken && operation.storageVersion === 2 &&
      typeof operation.token === 'string' && isCanonicalDeviceAudioToken(operation.token) &&
      path.storageVersion === 2 && path.token === operation.token) {
    return path;
  }
  return null;
}

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription.remove();
      resolve();
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') finish();
    });
    const timer = setTimeout(finish, POLL_MS);
  });
}

async function requestNotificationPermission(): Promise<void> {
  if (Number(Platform.Version) < 33) return;
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      console.warn('إشعارات تنزيل الصوت معطّلة؛ فعّل إشعارات التطبيق من إعدادات أندرويد لمتابعة التقدّم في الخلفية.');
    }
  } catch {
    console.warn('تعذر طلب إذن الإشعارات؛ يمكنك تفعيل إشعارات التطبيق من إعدادات أندرويد. سيستمر التنزيل.');
  }
}

export async function downloadYoutubeAudioOnDevice(
  input: string,
  options: { recordingId?: string; resumeOnly?: boolean; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<Recording> {
  const url = normalizeYoutubeVideoUrl(input);
  const native = requireDownloader();
  const id = options.recordingId ?? createDeviceYoutubeRecordingId();
  localUri(id);
  if (options.signal?.aborted) throw abortError();

  let cancelFailure: unknown;
  const cancel = () => {
    void native.cancel(id).catch((error: unknown) => { cancelFailure = error; });
  };
  let started = false;
  try {
    const existing = (await native.list()).find((entry) => entry.recordingId === id);
    if (existing && existing.url !== url) throw new Error('معرّف التنزيل مرتبط برابط فيديو آخر؛ استخدم معرّفًا جديدًا.');
    if (options.signal?.aborted && !existing) throw abortError();
    if (!existing) {
      if (options.resumeOnly) throw new Error('لم تعد عملية التنزيل موجودة على الجهاز؛ لا يمكن استعادتها تلقائيًا. أعد المحاولة يدويًا بمعرّف تنزيل جديد.');
      if (AppState.currentState !== 'active') {
        throw new Error('افتح التطبيق لبدء تنزيل الصوت؛ ستستمر العمليات الموجودة في الخلفية.');
      }
      await requestNotificationPermission();
      if (options.signal?.aborted) throw abortError();
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted && existing) cancel();
    if (!existing) {
      try {
        await native.start(url, id);
        started = true;
      } catch (error) {
        if (!options.signal?.aborted) throw downloadError(error);
        // Start may have committed before cancellation; recover its terminal journal.
      }
    }
    while (true) {
      const operation = (await native.list()).find((entry) => entry.recordingId === id);
      if (!operation) {
        if (options.signal?.aborted) throw abortError();
        throw new Error(started ? 'اختفت عملية تنزيل الصوت من سجل الجهاز.' : 'لم يعثر الجهاز على عملية التنزيل المطلوبة.');
      }
      if (operation.url !== url) throw new Error('معرّف التنزيل مرتبط برابط فيديو آخر؛ استخدم معرّفًا جديدًا.');
      if (options.signal?.aborted && (operation.state === 'queued' || operation.state === 'running')) cancel();
      if (operation.state === 'completed') {
        if (options.signal?.aborted) {
          await retryTerminalRelease(() => native.discard(id));
          throw abortError();
        }
        const recording = await completedRecording(operation);
        if (options.signal?.aborted) {
          await retryTerminalRelease(() => native.discard(id));
          throw abortError();
        }
        return recording;
      }
      if (operation.state === 'failed' || operation.state === 'cancelled' || operation.state === 'interrupted') {
        throw options.signal?.aborted ? abortError() : operationError(operation);
      }
      if (cancelFailure) throw new Error('تعذر إلغاء تنزيل الصوت على الجهاز؛ تحقق من حالة التنزيل وأعد محاولة الإلغاء.');
      if (!options.signal?.aborted && Number.isFinite(operation.progress)) {
        options.onProgress?.(Math.max(0, Math.min(1, operation.progress)));
      }
      await waitForPoll();
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}