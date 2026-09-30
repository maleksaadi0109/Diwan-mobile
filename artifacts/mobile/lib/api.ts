/**
 * Helpers for talking to the shared artifacts/api-server YouTube import
 * pipeline (download -> align). See lib/api-spec/openapi.yaml for the
 * documented contract.
 */

import { Platform } from 'react-native';

export function apiDomain(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) {
    throw new Error('خدمة المعالجة والمزامنة تحتاج عنوان خادم منشورًا في إعدادات هذه النسخة. تنزيل يوتيوب المباشر على أندرويد لا يحتاجه.');
  }
  return domain;
}

/**
 * The download endpoint returns paths like "/api-worker/youtube/audio/<job>/playback.mp3".
 * The API server route lives under "/api". Convert to a fetchable absolute URL.
 */
export function toPlayableAudioUrl(rawPath: string): string {
  const serverPath = rawPath.replace(/^\/api-worker\//, '/api/');
  return `https://${apiDomain()}${serverPath}`;
}

export interface UploadedAudioJob {
  job_id: string;
  playback_audio_path: string;
  processing_audio_path: string;
  duration_ms?: number;
}

export interface AlignmentResult {
  alignments: { verse_id: string; start_ms: number; end_ms: number; confidence: number }[];
}

export interface AlignmentJobStatus {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  result?: AlignmentResult;
  error_message?: string;
}

const ALIGN_POLL_MS = 1500;
const ALIGN_WAIT_MS = 8 * 60 * 1000;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'لم تعد عملية المزامنة موجودة بعد إعادة تشغيل الخادم أو انتهاء صلاحيتها. احذف المسودة وابدأ استيرادًا جديدًا.'
        : body && typeof body.error_message === 'string'
        ? body.error_message
        : `تعذر الاتصال بالخادم (HTTP ${response.status})`,
    );
  }
  return body as T;
}

function isAlignmentResult(value: unknown): value is AlignmentResult {
  if (!value || typeof value !== 'object') return false;
  const alignments = (value as { alignments?: unknown }).alignments;
  return Array.isArray(alignments) && alignments.every(
    (entry) =>
      entry &&
      typeof entry.verse_id === 'string' &&
      entry.verse_id.length > 0 &&
      Number.isFinite(entry.start_ms) &&
      Number.isFinite(entry.end_ms) &&
      Number.isFinite(entry.confidence),
  );
}

function validateAlignmentRequest(data: {
  audio_path: string;
  verses: { id: string; text: string }[];
  poem_id: string;
  recording_id: string;
}): void {
  const validLocalId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);
  if (
    typeof data.audio_path !== 'string' ||
    data.audio_path.length > 2000 ||
    !/^\/(?:api|api-worker)\//.test(data.audio_path) ||
    !validLocalId(data.poem_id) ||
    !validLocalId(data.recording_id) ||
    !Array.isArray(data.verses) ||
    data.verses.length < 1 ||
    data.verses.length > 1000
  ) {
    throw new Error('بيانات طلب مزامنة الأبيات غير صالحة');
  }
  const verseIds = new Set<string>();
  for (const verse of data.verses) {
    if (
      !verse ||
      !validLocalId(verse.id) ||
      typeof verse.text !== 'string' ||
      !verse.text.trim() ||
      verse.text.length > 20_000 ||
      verseIds.has(verse.id)
    ) {
      throw new Error('تحتوي بيانات الأبيات على رقم أو نص غير صالح');
    }
    verseIds.add(verse.id);
  }
}

/**
 * Alignment runs in a bounded Python worker job rather than an HTTP request
 * held open for minutes. Unfinished jobs are temporary and may be lost if
 * the server restarts; completed native imports keep their audio on the phone.
 */
export async function alignPoemInBackground(
  data: {
    audio_path: string;
    verses: { id: string; text: string }[];
    poem_id: string;
    recording_id: string;
  },
  onProgress?: (progress: number | undefined) => void,
  onCreated?: (jobId: string) => Promise<void>,
): Promise<AlignmentResult> {
  validateAlignmentRequest(data);
  const base = `https://${apiDomain()}/api/jobs`;
  const created = await readApiResponse<{ job_id: string }>(
    await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => {
        throw new Error('تعذر إنشاء عملية المزامنة. تحقق من اتصال الإنترنت وحاول الاستيراد مجددًا.');
      }),
  );
  if (!created || typeof created.job_id !== 'string' || !JOB_ID_PATTERN.test(created.job_id)) {
    throw new Error('أعاد الخادم رقم عملية غير صالح');
  }
  await onCreated?.(created.job_id);

  return pollAlignmentJob(created.job_id, onProgress);
}

/** Resume polling a previously-created job without submitting a duplicate POST. */
export async function pollAlignmentJob(
  jobId: string,
  onProgress?: (progress: number | undefined) => void,
): Promise<AlignmentResult> {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error('رقم عملية المزامنة غير صالح');
  }
  const base = `https://${apiDomain()}/api/jobs`;
  const deadline = Date.now() + ALIGN_WAIT_MS;
  while (Date.now() < deadline) {
    const job = await readApiResponse<AlignmentJobStatus>(
      await fetch(`${base}/${encodeURIComponent(jobId)}`).catch(() => {
        throw new Error('تعذر الاتصال بالخادم أثناء متابعة المزامنة. تحقق من الإنترنت ثم اضغط استئناف.');
      }),
    );
    if (
      !job ||
      typeof job !== 'object' ||
      job.job_id !== jobId ||
      !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)
    ) {
      throw new Error('أعاد الخادم حالة عملية مزامنة غير صالحة');
    }
    onProgress?.(job.progress);
    if (job.status === 'succeeded') {
      if (!isAlignmentResult(job.result)) {
        throw new Error('أعاد الخادم نتيجة مزامنة غير صالحة');
      }
      return job.result;
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error_message || 'تعذرت مزامنة الأبيات، حاول مرة أخرى');
    }
    await new Promise((resolve) => setTimeout(resolve, ALIGN_POLL_MS));
  }
  throw new Error('انتهت مهلة انتظار المزامنة. بقيت العملية محفوظة؛ اضغط استئناف للمتابعة أو تحقق من اتصال الإنترنت.');
}

export async function downloadYoutubeCover(
  youtubeUrl: string,
  cookiesContent?: string,
): Promise<string | null> {
  try {
    const infoResponse = await fetch(`https://${apiDomain()}/api/youtube/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: youtubeUrl,
        cookies_content: cookiesContent?.trim() || undefined,
      }),
    });
    const info = (await infoResponse.json().catch(() => ({}))) as { thumbnail?: string };
    if (!infoResponse.ok || !info.thumbnail) return null;

    const thumbnailResponse = await fetch(
      `https://${apiDomain()}/api/youtube/thumbnail`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: info.thumbnail }),
      },
    );
    const thumbnail = (await thumbnailResponse.json().catch(() => ({}))) as {
      data_url?: string;
    };
    return thumbnailResponse.ok && thumbnail.data_url
      ? thumbnail.data_url
      : info.thumbnail;
  } catch {
    return null;
  }
}

/**
 * Uploads a locally-picked or freshly-recorded audio file to the shared
 * api-server, which converts it into the same processing/playback pair
 * produced by the YouTube download pipeline. This lets "upload a file" and
 * "record yourself" reuse the exact same /align step as YouTube imports.
 */
export async function uploadAudioFile(params: {
  uri: string;
  fileName: string;
  mimeType: string;
}): Promise<UploadedAudioJob> {
  const endpoint = `https://${apiDomain()}/api/audio/upload`;
  const formData = new FormData();

  if (Platform.OS === 'web') {
    const blob = await (await fetch(params.uri)).blob();
    formData.append('audio', blob, params.fileName);
  } else {
    formData.append(
      'audio',
      {
        uri: params.uri,
        name: params.fileName,
        type: params.mimeType || 'audio/mpeg',
      } as unknown as Blob,
    );
  }

  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', body: formData });
  } catch {
    throw new Error('تعذر رفع الملف الصوتي، تحقق من الإنترنت');
  }

  if (!response.ok) {
    let message = `فشل رفع الملف الصوتي (HTTP ${response.status})`;
    try {
      const errBody = (await response.json()) as { error_message?: string };
      if (errBody?.error_message) message = errBody.error_message;
    } catch {
      // ignore — fall back to the generic message above
    }
    throw new Error(message);
  }

  return (await response.json()) as UploadedAudioJob;
}

export function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const maybe = error as {
      error_message?: string;
      message?: string;
    };
    if (typeof maybe.error_message === 'string' && maybe.error_message) {
      return maybe.error_message;
    }
    if (typeof maybe.message === 'string' && maybe.message) {
      return maybe.message;
    }
  }
  return fallback;
}

/**
 * Error codes returned by the YouTube worker that mean "this video needs a logged-in
 * YouTube session" — the app should show a cookie-paste box and retry.
 */
const COOKIE_UNLOCK_CODES = new Set(['LOGIN_REQUIRED', 'COOKIES_INVALID']);

export function extractErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const code = (error as { error_code?: string }).error_code;
    if (typeof code === 'string' && code) return code;
  }
  return null;
}

export function needsCookieUnlock(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code !== null && COOKIE_UNLOCK_CODES.has(code);
}
