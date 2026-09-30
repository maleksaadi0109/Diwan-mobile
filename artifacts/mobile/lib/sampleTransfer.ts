import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { toPlayableAudioUrl } from './api';
import type { Recording } from './types';

type TransferState = { jobId: string; url: string; playbackPath?: string; durationMs?: number; caching?: boolean };
const key = (id: string) => `diwan.mobile.sample-transfer.${id}.v1`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const validJob = (id: string) => /^yt-sample-[a-zA-Z0-9_-]{1,64}$/.test(id);
const validPath = (path: string) => /^\/api(?:-worker)?\/youtube\/audio\/yt-sample-[a-zA-Z0-9_-]{1,64}\/playback\.mp3$/.test(path);

export class AudioServerBusyError extends Error {
  constructor(status: number, retryAfter: string | null) {
    const seconds = Number(retryAfter);
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` بعد ${Math.ceil(seconds / 60)} دقيقة` : ' لاحقاً';
    super(`خادم الصوت مشغول (HTTP ${status})؛ حاول مرة أخرى${wait}.`);
    this.name = 'AudioServerBusyError';
  }
}

export async function readSampleTransfer(id: string): Promise<TransferState | null> {
  const raw = await AsyncStorage.getItem(key(id));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as TransferState;
    return validJob(state.jobId) && typeof state.url === 'string' &&
      (!state.playbackPath || validPath(state.playbackPath)) ? state : null;
  } catch {
    return null;
  }
}

export async function clearSampleTransfer(id: string): Promise<void> {
  await AsyncStorage.removeItem(key(id));
}

export async function markSampleCaching(id: string): Promise<void> {
  const state = await readSampleTransfer(id);
  if (!state) throw new Error('لم تُحفظ حالة تنزيل الصوت.');
  await AsyncStorage.setItem(key(id), JSON.stringify({ ...state, caching: true }));
}

/**
 * Persist the job ID BEFORE starting the server request. The server worker
 * continues after a suspended client and can be found on the next launch.
 */
export async function prepareSampleTransfer(
  id: string,
  url: string,
  start: (url: string, jobId: string) => Promise<{ playback_audio_path: string; duration_ms?: number }>,
  onResume: () => void,
): Promise<{ playback_audio_path: string; duration_ms?: number; jobId: string }> {
  let state = await readSampleTransfer(id);
  if (state?.url !== url) state = null;
  if (state) onResume();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state) {
      state = { jobId: `yt-sample-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, url };
      await AsyncStorage.setItem(key(id), JSON.stringify(state));
    }
    const statusUrl = toPlayableAudioUrl(`/api-worker/youtube/download/${state.jobId}/status`);
    let status: Response;
    try {
      status = await fetch(statusUrl);
    } catch (error) {
      throw new Error('انقطع الاتصال أثناء إعداد الصوت؛ ستُستأنف المحاولة عند عودة الاتصال.', { cause: error });
    }
    if (status.status === 200) {
      const body = await status.json();
      if (body.status === 'ready' && validPath(body.playback_audio_path)) {
        const playbackPath: string = body.playback_audio_path;
        state.playbackPath = playbackPath;
        state.durationMs = body.duration_ms;
        await AsyncStorage.setItem(key(id), JSON.stringify(state));
        return { playback_audio_path: playbackPath, duration_ms: state.durationMs, jobId: state.jobId };
      }
      throw new Error('حالة تنزيل الصوت غير صالحة.');
    }
    // The temporary server file can expire after 24 hours while the phone is
    // offline. Never reuse its saved playback URL after the server removes it.
    if (state.playbackPath && (status.status === 404 || status.status === 409)) {
      state = null;
      continue;
    }
    if (status.status === 409) {
      state = null; // Worker stopped; retry with a new ID, never reuse a partial job.
      continue;
    }
    if (status.status === 404) {
      // The ID was saved but the request never reached the server.
      try {
        const result = await start(url, state.jobId);
        if (!validPath(result.playback_audio_path)) throw new Error('مسار الصوت الذي أعاده الخادم غير صالح.');
        state.playbackPath = result.playback_audio_path;
        state.durationMs = result.duration_ms;
        await AsyncStorage.setItem(key(id), JSON.stringify(state));
        return { ...result, jobId: state.jobId };
      } catch (error) {
        if (error instanceof AudioServerBusyError) throw error;
        // A suspended request may still be processing; check it rather than
        // immediately starting a duplicate job.
      }
    } else if (status.status !== 202) {
      throw new Error(`تعذر التحقق من تنزيل الصوت (HTTP ${status.status}).`);
    }
    for (let poll = 0; poll < 120; poll++) {
      await sleep(3000);
      const response = await fetch(statusUrl);
      if (response.status === 202) continue;
      if (response.status === 200) {
        const body = await response.json();
        if (body.status !== 'ready' || !validPath(body.playback_audio_path)) throw new Error('حالة تنزيل الصوت غير صالحة.');
        const playbackPath: string = body.playback_audio_path;
        state.playbackPath = playbackPath;
        state.durationMs = body.duration_ms;
        await AsyncStorage.setItem(key(id), JSON.stringify(state));
        return { playback_audio_path: playbackPath, duration_ms: state.durationMs, jobId: state.jobId };
      }
      throw new Error('توقف الخادم قبل اكتمال إعداد الصوت؛ أعد المحاولة.');
    }
    throw new Error('إعداد الصوت ما زال جارياً على الخادم؛ أعد فتح التطبيق لاحقاً.');
  }
  throw new Error('توقفت عملية تنزيل الصوت؛ أعد المحاولة.');
}

/** Only the sample's own staging file is used; final files are never overwritten. */
export async function cacheSampleTransfer(
  recording: Recording,
  onProgress: (fraction: number) => void,
): Promise<Recording> {
  if (Platform.OS === 'web' || !FileSystem.documentDirectory ||
      !/^sample-audio-catalog-[a-zA-Z0-9_-]+-yt-sample-[a-zA-Z0-9_-]+$/.test(recording.id)) {
    throw new Error('تعذر حفظ صوت التجربة على هذا الجهاز.');
  }
  const directory = `${FileSystem.documentDirectory}recording-audio/`;
  const target = `${directory}${recording.id}.mp3`;
  const staging = `${directory}.${recording.id}.part.mp3`;
  const remote = recording.audioUrl;
  const existing = await FileSystem.getInfoAsync(target);
  if (existing.exists) {
    if (!existing.size) throw new Error('ملف الصوت المحفوظ فارغ؛ لا يمكن استبداله.');
    return { ...recording, audioUrl: target, serverAudioUrl: remote };
  }
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  // A prior process may have died mid-transfer. Do not treat a partial file
  // as complete or append to it without valid native resume data.
  await FileSystem.deleteAsync(staging, { idempotent: true });
  const task = FileSystem.createDownloadResumable(remote, staging, {
    sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
  }, ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
    if (totalBytesExpectedToWrite > 0) onProgress(totalBytesWritten / totalBytesExpectedToWrite);
  });
  const result = await task.downloadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(staging, { idempotent: true });
    throw new Error(`تعذر حفظ الصوت (HTTP ${result?.status ?? 'unknown'}).`);
  }
  const info = await FileSystem.getInfoAsync(staging);
  if (!info.exists || !info.size) throw new Error('اكتمل التنزيل لكن ملف الصوت فارغ.');
  if ((await FileSystem.getInfoAsync(target)).exists) throw new Error('ملف الصوت موجود بالفعل؛ لن يُستبدل.');
  await FileSystem.moveAsync({ from: staging, to: target });
  return { ...recording, audioUrl: target, serverAudioUrl: remote };
}