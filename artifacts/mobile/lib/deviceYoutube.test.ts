import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recording } from './types';
import type { DeviceYoutubeOperation } from './deviceYoutube';
import {
  isCanonicalDeviceAudioToken,
  isOwnedDeviceRecordingId,
} from './sharedDeviceAudioPaths';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android', Version: 34 },
  appState: { currentState: 'active', addEventListener: vi.fn() },
  permissions: { PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' }, request: vi.fn() },
  requireOptionalNativeModule: vi.fn(),
  getInfoAsync: vi.fn(),
  deleteAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform, AppState: mocks.appState, PermissionsAndroid: mocks.permissions,
}));
vi.mock('expo', () => ({ requireOptionalNativeModule: mocks.requireOptionalNativeModule }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: mocks.getInfoAsync,
  deleteAsync: mocks.deleteAsync,
}));

import {
  acknowledgeDeviceYoutubeRecording,
  cancelDeviceYoutubeOperation,
  createDeviceYoutubeRecordingId,
  deleteDeviceYoutubeRecording,
  downloadYoutubeAudioOnDevice,
  getYoutubeThumbnail,
  listDeviceYoutubeOperations,
  normalizeYoutubeVideoUrl,
  usesDeviceYoutubeDownloads,
} from './deviceYoutube';

const VIDEO_ID = 'abcdefghijk';
const URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const ID = 'yt-local-1234-abc123';
const TOKEN = '01234567-89ab-cdef-0123-456789abcdef';
const ENGINE_DIAGNOSTIC_CODES = [
  'E_ENGINE_UPDATE',
  'E_DOWNLOADER_INIT',
  'E_CONVERTER_INIT',
  'E_ENGINE_UPDATE_NETWORK',
  'E_ENGINE_PACKAGE_INVALID',
  'E_ENGINE_PREFERENCE_WRITE',
  'E_ENGINE_INSTALL',
];
const uri = (id = ID) => `file:///documents/recording-audio/${id}.mp3`;
const nestedUri = (id = ID, token = TOKEN) =>
  `file:///documents/recording-audio/.diwan-v2/${id}/${token}/audio.mp3`;
const entry = (state: DeviceYoutubeOperation['state'], overrides: Partial<DeviceYoutubeOperation> = {}): DeviceYoutubeOperation => ({
  recordingId: ID, url: URL, state, progress: 0.5, ...overrides,
});
const completed = (overrides: Partial<DeviceYoutubeOperation> = {}) =>
  entry('completed', { progress: 1, audioUrl: uri(), durationMs: 12000, ...overrides });
const completedV2 = (overrides: Partial<DeviceYoutubeOperation> = {}) =>
  entry('completed', {
    progress: 1, audioUrl: nestedUri(), durationMs: 12000, storageVersion: 2, token: TOKEN, ...overrides,
  });

function nativeWith(operations: DeviceYoutubeOperation[] = []) {
  const journal = operations;
  const native = {
    start: vi.fn(async (url: string, id: string) => { journal.push(entry('queued', { url, recordingId: id })); }),
    list: vi.fn(async () => journal.map((op) => ({ ...op }))),
    cancel: vi.fn(async (id: string) => {
      const op = journal.find((item) => item.recordingId === id);
      if (op && (op.state === 'running' || op.state === 'queued')) op.state = 'cancelled';
    }),
    acknowledge: vi.fn(async (id: string) => {
      const index = journal.findIndex((op) => op.recordingId === id);
      if (index >= 0) journal.splice(index, 1);
    }),
    discard: vi.fn(async (id: string) => {
      const index = journal.findIndex((op) => op.recordingId === id && op.state === 'completed');
      if (index < 0) throw new Error('not owned');
      journal.splice(index, 1);
    }),
  };
  mocks.requireOptionalNativeModule.mockReturnValue(native);
  return { native, journal };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.platform.OS = 'android';
  mocks.platform.Version = 34;
  mocks.appState.currentState = 'active';
  mocks.appState.addEventListener.mockReset().mockReturnValue({ remove: vi.fn() });
  mocks.permissions.request.mockReset().mockResolvedValue('granted');
  mocks.requireOptionalNativeModule.mockReset();
  mocks.getInfoAsync.mockReset().mockResolvedValue({ exists: true, size: 42 });
  mocks.deleteAsync.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('video URLs', () => {
  it.each([
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    ` https://youtu.be/${VIDEO_ID}?si=share-token `,
    `https://m.youtube.com/shorts/${VIDEO_ID}`,
    `https://music.youtube.com/embed/${VIDEO_ID}/`,
    `http://youtube.com/live/${VIDEO_ID}`,
    `https://youtube.com/watch?v=%61bcdefghijk`,
  ])('normalizes %s', (input) => expect(normalizeYoutubeVideoUrl(input)).toBe(URL));
  it('produces the thumbnail and strips playlist parameters', () => {
    expect(getYoutubeThumbnail(URL)).toBe(`https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`);
    expect(normalizeYoutubeVideoUrl(`${URL}&list=PL123&index=4`)).toBe(URL);
  });
  it.each([
    'https://youtube.com/watch?list=PL123',
    `https://youtube.com.evil.test/watch?v=${VIDEO_ID}`,
    `https://evil.youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:password@youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com:444/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}extra`,
  ])('rejects unsafe or non-video %s', (input) => expect(() => normalizeYoutubeVideoUrl(input)).toThrow());
  it('generates owned identifiers', () => expect(createDeviceYoutubeRecordingId()).toMatch(/^yt-local-\d+-[a-z0-9]+$/));
});

describe('durable device operations', () => {
  it.each(['\n', '\r', '\r\n'])('rejects terminal line endings in owned IDs and UUID tokens: %j', (ending) => {
    expect(isOwnedDeviceRecordingId(`${ID}${ending}`)).toBe(false);
    expect(isCanonicalDeviceAudioToken(`${TOKEN}${ending}`)).toBe(false);
  });

  it('passively recovers nothing without native support, but refuses downloads without APK or server fallback', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue(null);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(usesDeviceYoutubeDownloads()).toBe(true);
    expect(await listDeviceYoutubeOperations()).toEqual([]);
    await expect(downloadYoutubeAudioOnDevice(URL)).rejects.toThrow(/APK/);
    expect(fetcher).not.toHaveBeenCalled();
    mocks.platform.OS = 'ios';
    expect(usesDeviceYoutubeDownloads()).toBe(false);
    expect(await listDeviceYoutubeOperations()).toEqual([]);
    await expect(downloadYoutubeAudioOnDevice(URL)).rejects.toThrow('أندرويد فقط');
  });

  it('treats old event-based APK modules as unsupported for passive recovery and active downloads', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({ download: vi.fn(), cancel: vi.fn(), addListener: vi.fn() });
    expect(await listDeviceYoutubeOperations()).toEqual([]);
    await expect(downloadYoutubeAudioOnDevice(URL)).rejects.toThrow(/APK/);
  });

  it('resumeOnly never starts a missing operation, even in the foreground', async () => {
    const { native } = nativeWith();
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID, resumeOnly: true }))
      .rejects.toThrow('لا يمكن استعادتها تلقائيًا');
    expect(native.start).not.toHaveBeenCalled();
    expect(mocks.permissions.request).not.toHaveBeenCalled();
  });

  it('reattaches matching operations without starting or requesting permissions, including while backgrounded', async () => {
    mocks.appState.currentState = 'background';
    const { native, journal } = nativeWith([entry('running')]);
    const progress = vi.fn();
    const result = downloadYoutubeAudioOnDevice(`https://youtu.be/${VIDEO_ID}`, { recordingId: ID, onProgress: progress });
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(0.5));
    journal[0] = completed();
    await vi.advanceTimersByTimeAsync(750);
    expect(await result).toEqual({ id: ID, audioUrl: uri(), durationMs: 12000 });
    expect(native.start).not.toHaveBeenCalled();
    expect(mocks.permissions.request).not.toHaveBeenCalled();
    expect(native.acknowledge).not.toHaveBeenCalled();
    expect(await listDeviceYoutubeOperations()).toEqual([completed()]);
  });

  it('accepts canonical v2 completion and returns its actual token-owned URI', async () => {
    const { native } = nativeWith([completedV2()]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).resolves.toEqual({
      id: ID, audioUrl: nestedUri(), durationMs: 12000,
    });
    expect(mocks.getInfoAsync).toHaveBeenCalledWith(nestedUri());
    expect(native.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign recording ID', { audioUrl: nestedUri('yt-local-1235-other') }],
    ['uppercase token', { audioUrl: nestedUri(ID, TOKEN.toUpperCase()) }],
    ['foreign token metadata', { token: 'fedcba98-7654-3210-fedc-ba9876543210' }],
    ['encoded traversal', { audioUrl: `file:///documents/recording-audio/.diwan-v2/${ID}/../${TOKEN}/audio.mp3` }],
    ['encoded traversal segment', { audioUrl: `file:///documents/recording-audio/.diwan-v2/${ID}/%2e%2e/${TOKEN}/audio.mp3` }],
    ['encoded slash', { audioUrl: nestedUri().replace(ID, `${ID}%2fother`) }],
    ['encoded token character', { audioUrl: nestedUri().replace(TOKEN, TOKEN.replace('-', '%2d')) }],
    ['URI token with terminal LF', { audioUrl: nestedUri(ID, `${TOKEN}\n`) }],
    ['URI token with terminal CR', { audioUrl: nestedUri(ID, `${TOKEN}\r`) }],
    ['URI token with terminal CRLF', { audioUrl: nestedUri(ID, `${TOKEN}\r\n`) }],
    ['operation token with terminal LF', { token: `${TOKEN}\n` }],
    ['operation token with terminal CR', { token: `${TOKEN}\r` }],
    ['operation token with terminal CRLF', { token: `${TOKEN}\r\n` }],
    ['extra query', { audioUrl: `${nestedUri()}?download=1` }],
    ['extra hash', { audioUrl: `${nestedUri()}#fragment` }],
    ['non-directory prefix', { audioUrl: nestedUri().replace('/recording-audio/', '/recording-audio-evil/') }],
    ['missing version', { storageVersion: undefined }],
    ['unsupported version', { storageVersion: 1 }],
    ['legacy URI with v2 metadata', { audioUrl: uri() }],
  ])('rejects malformed v2 completion with %s', async (_label, changes) => {
    const { native } = nativeWith([completedV2(changes)]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('غير صالح');
    expect(native.discard).not.toHaveBeenCalled();
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('never reuses an ID for another URL', async () => {
    const { native } = nativeWith([entry('running', { url: `https://www.youtube.com/watch?v=zzzzzzzzzzz` })]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('رابط فيديو آخر');
    expect(native.start).not.toHaveBeenCalled();
  });

  it('only starts new work in foreground; permission denial warns but does not prevent foreground service start', async () => {
    const { native, journal } = nativeWith();
    mocks.appState.currentState = 'background';
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('افتح التطبيق');
    expect(native.start).not.toHaveBeenCalled();
    expect(mocks.permissions.request).not.toHaveBeenCalled();
    mocks.appState.currentState = 'active';
    mocks.permissions.request.mockResolvedValue('denied');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledWith(URL, ID));
    expect(mocks.permissions.request).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('إعدادات أندرويد'));
    journal[0] = completed();
    await vi.advanceTimersByTimeAsync(750);
    expect(await result).toEqual({ id: ID, audioUrl: uri(), durationMs: 12000 });
  });

  it('does not ask for notifications below Android 13', async () => {
    mocks.platform.Version = 32;
    const { native, journal } = nativeWith();
    const result = downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    await vi.waitFor(() => expect(native.start).toHaveBeenCalled());
    journal[0] = completed();
    await vi.advanceTimersByTimeAsync(750);
    await result;
    expect(mocks.permissions.request).not.toHaveBeenCalled();
  });

  it('reports an interrupted journal as a manual retry with a NEW ID, never starts again', async () => {
    const { native } = nativeWith([entry('interrupted')]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('بمعرّف تنزيل جديد');
    expect(native.start).not.toHaveBeenCalled();
    expect(await native.list()).toEqual([entry('interrupted')]);
  });

  it.each([
    ['wrong URI', { audioUrl: 'file:///other.mp3' }, { exists: true, size: 42 }],
    ['zero duration', { durationMs: 0 }, { exists: true, size: 42 }],
    ['excess duration', { durationMs: 7200001 }, { exists: true, size: 42 }],
    ['missing file', {}, { exists: false, size: 42 }],
    ['empty file', {}, { exists: true, size: 0 }],
  ])('rejects %s without deleting an unverified path', async (_label, changes, info) => {
    const { native } = nativeWith([completed(changes)]);
    mocks.getInfoAsync.mockResolvedValue(info);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('غير صالح');
    expect(native.discard).not.toHaveBeenCalled();
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('abort cancels native work and waits for a terminal state', async () => {
    const { native, journal } = nativeWith([entry('running')]);
    const controller = new AbortController();
    const result = downloadYoutubeAudioOnDevice(URL, { recordingId: ID, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.list).toHaveBeenCalledTimes(2));
    controller.abort();
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
    expect(native.cancel).toHaveBeenCalledWith(ID);
    expect(journal[0].state).toBe('cancelled');
    expect(native.discard).not.toHaveBeenCalled();
  });

  it('abort racing completion discards only native-owned unacknowledged result', async () => {
    const { native, journal } = nativeWith([entry('running')]);
    const controller = new AbortController();
    const result = downloadYoutubeAudioOnDevice(URL, { recordingId: ID, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.list).toHaveBeenCalledTimes(2));
    journal[0] = completed();
    controller.abort();
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
    expect(native.discard).toHaveBeenCalledWith(ID);
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('acknowledges saved results without deleting their file; discard cannot delete after ack', async () => {
    const { native } = nativeWith([completed()]);
    await acknowledgeDeviceYoutubeRecording(ID);
    expect(native.acknowledge).toHaveBeenCalledWith(ID);
    await expect(deleteDeviceYoutubeRecording({ id: ID, audioUrl: uri(), durationMs: 12000 }))
      .rejects.toThrow('محفوظ');
    expect(native.discard).not.toHaveBeenCalled();
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('discards a v2 result only through the matching completed native operation', async () => {
    const { native } = nativeWith([completedV2()]);
    await deleteDeviceYoutubeRecording({ id: ID, audioUrl: nestedUri(), durationMs: 12000 });
    expect(native.discard).toHaveBeenCalledWith(ID);
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
  });

  it('does not compare v2 deletion against a synthesized legacy URI', async () => {
    const { native } = nativeWith([completedV2()]);
    await expect(deleteDeviceYoutubeRecording({ id: ID, audioUrl: uri(), durationMs: 12000 }))
      .rejects.toThrow('محفوظ');
    expect(native.discard).not.toHaveBeenCalled();
    await expect(deleteDeviceYoutubeRecording({
      id: ID, audioUrl: nestedUri(ID, 'fedcba98-7654-3210-fedc-ba9876543210'), durationMs: 12000,
    })).rejects.toThrow('مملوك');
    expect(native.discard).not.toHaveBeenCalled();
  });

  it('retries terminal E_BUSY for acknowledge and discard while native worker releases resources', async () => {
    const { native } = nativeWith([completed()]);
    native.acknowledge.mockRejectedValueOnce({ code: 'E_BUSY' });
    const ack = acknowledgeDeviceYoutubeRecording(ID);
    await vi.advanceTimersByTimeAsync(750);
    await ack;
    expect(native.acknowledge).toHaveBeenCalledTimes(2);
    const { native: second } = nativeWith([completed()]);
    second.discard.mockRejectedValueOnce({ code: 'E_BUSY' });
    const discard = deleteDeviceYoutubeRecording({ id: ID, audioUrl: uri(), durationMs: 12000 });
    await vi.advanceTimersByTimeAsync(750);
    await discard;
    expect(second.discard).toHaveBeenCalledTimes(2);
  });

  it('stops retrying E_BUSY after a bounded release window and keeps journal intact', async () => {
    const { native } = nativeWith([completed()]);
    native.acknowledge.mockRejectedValue({ code: 'E_BUSY' });
    const result = acknowledgeDeviceYoutubeRecording(ID);
    const failure = expect(result).rejects.toMatchObject({ code: 'E_BUSY' });
    await vi.advanceTimersByTimeAsync(10_001);
    await failure;
    expect(native.acknowledge.mock.calls.length).toBeLessThan(20);
    expect(await native.list()).toHaveLength(1);
  });

  it.each([
    ['E_FOREGROUND_REQUIRED', 'افتح التطبيق'],
    ['E_TIMEOUT', 'مهلة'],
    ['E_NOTIFICATION', 'إشعارات'],
    ['E_INTERRUPTED', 'بمعرّف تنزيل جديد'],
  ])('maps %s to an actionable message', async (code, text) => {
    nativeWith([entry('failed', { errorCode: code })]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow(text);
  });

  it.each(ENGINE_DIAGNOSTIC_CODES)('maps terminal journal diagnostic %s to a fixed Arabic message', async (code) => {
    const { native } = nativeWith([entry('failed', { errorCode: code })]);
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(code);
    expect(native.start).not.toHaveBeenCalled();
  });

  it.each(ENGINE_DIAGNOSTIC_CODES)('maps immediate native.start exception %s through the same diagnostic mapping', async (code) => {
    const { native } = nativeWith();
    native.start.mockRejectedValue({ code, message: 'sensitive native exception text' });
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(code);
    expect((failure as Error).message).not.toContain('sensitive native exception text');
    expect(native.start).toHaveBeenCalledOnce();
  });

  it('retains the failed 99% journal and exposes its fixed progress-save storage diagnostic', async () => {
    const code = 'E_STORAGE_STAGE_ERRNO:PROGRESS_SAVE:ENOSPC';
    const operation = entry('failed', { progress: 0.99, errorCode: code });
    const { native } = nativeWith([operation]);
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message)
      .toBe(`تعذر حفظ الصوت على الجهاز بسبب نفاد المساحة أو الحصة التخزينية. رمز التشخيص: ${code}.`);
    expect(native.start).not.toHaveBeenCalled();
    expect(native.acknowledge).not.toHaveBeenCalled();
    expect(native.discard).not.toHaveBeenCalled();
    expect((await native.list())[0].progress).toBe(0.99);
  });

  it.each([
    ['ENOSPC', true],
    ['EDQUOT', true],
    ['EACCES', false],
    ['EPERM', false],
    ['EXDEV', false],
    ['EEXIST', false],
  ])('reports low storage only for allowlisted capacity errno %s', async (errno, lowStorage) => {
    const code = `E_STORAGE_STAGE_ERRNO:PUBLICATION_LINK:${errno}`;
    nativeWith([entry('failed', { progress: 0.99, errorCode: code })]);
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    const message = (failure as Error).message;
    expect(message).toContain(code);
    expect(message.includes('نفاد المساحة')).toBe(lowStorage);
  });

  it.each([
    'E_STORAGE_STAGE_ERRNO:UNKNOWN_STAGE:ENOSPC',
    'E_STORAGE_STAGE_ERRNO:PROGRESS_SAVE:ENO_PRIVATE',
    'E_STORAGE_STAGE_ERRNO:PUBLICATION_LINK:EPERM\n',
    'E_STORAGE_STAGE_ERRNO:PROGRESS_SAVE:ENOSPC\nsensitive path',
    'E_STORAGE_STAGE_ERRNO:PROGRESS_SAVE:ENOSPC sensitive message',
  ])('does not expose malformed or injected storage diagnostic %s', async (code) => {
    nativeWith([entry('failed', { errorCode: code })]);
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(code);
    expect((failure as Error).message).not.toContain('sensitive');
    expect((failure as Error).message).not.toContain('UNKNOWN_STAGE');
  });

  it('maps legacy E_STORAGE to neutral text without implying low space', async () => {
    nativeWith([entry('failed', { errorCode: 'E_STORAGE' })]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID }))
      .rejects.toThrow('تعذر حفظ الصوت على الجهاز. رمز التشخيص: E_STORAGE.');
  });

  it('describes bundled engine installation failures without suggesting an updater network request', async () => {
    const { native } = nativeWith([entry('failed', { errorCode: 'E_ENGINE_INSTALL' })]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID }))
      .rejects.toThrow(/محرك yt-dlp الموثوق المضمّن.*E_ENGINE_INSTALL/);
    expect(native.start).not.toHaveBeenCalled();
  });

  it.each(['E_PRIVATE_DETAIL', 'toString', 'constructor'])('does not expose arbitrary native code %s in user-facing errors', async (code) => {
    const { native } = nativeWith([entry('failed', { errorCode: code })]);
    let failure: unknown;
    try {
      await downloadYoutubeAudioOnDevice(URL, { recordingId: ID });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(code);
    expect((failure as Error).message).not.toContain('sensitive');
  });

  it('validates ownership before native discard and provides explicit cancel API', async () => {
    const { native } = nativeWith([completed()]);
    const recording: Recording = { id: ID, audioUrl: uri(), durationMs: 12000 };
    await expect(deleteDeviceYoutubeRecording({ ...recording, audioUrl: 'file:///other.mp3' }))
      .rejects.toThrow('خارج مجلد التنزيل');
    await expect(deleteDeviceYoutubeRecording({ ...recording, id: 'user-recording' })).rejects.toThrow('غير صالح');
    await deleteDeviceYoutubeRecording(recording);
    expect(native.discard).toHaveBeenCalledWith(ID);
    expect(mocks.deleteAsync).not.toHaveBeenCalled();
    await cancelDeviceYoutubeOperation(ID);
    expect(native.cancel).toHaveBeenCalledWith(ID);
  });

  it('keeps failed journal available for caller to acknowledge explicitly', async () => {
    const { native } = nativeWith([entry('failed', { errorCode: 'E_LOGIN_REQUIRED' })]);
    await expect(downloadYoutubeAudioOnDevice(URL, { recordingId: ID })).rejects.toThrow('تسجيل الدخول');
    expect(await native.list()).toHaveLength(1);
    expect(native.acknowledge).not.toHaveBeenCalled();
  });
});