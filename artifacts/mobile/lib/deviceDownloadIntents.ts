import type { Poem, Recording } from './types';
import type { DeviceYoutubeOperation } from './deviceYoutube';

const KEY = 'diwan.mobile.device-download-intents.v1';
export interface DeviceDownloadIntent {
  id: string;
  url: string;
  poem: Poem;
  existingPoemId?: string;
  reciter?: string;
  catalogId?: string;
  cleanup?: boolean;
  adopted?: boolean;
  message?: string;
}
export interface DeviceDownloadRecovery {
  id: string;
  title: string;
  state: 'running' | 'error';
  progress?: number;
  message?: string;
}
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

/** All read/modify/write transactions share a queue, including reads after failures. */
export function createDeviceIntentStore(storage: Storage) {
  let queue: Promise<unknown> = Promise.resolve();
  function transaction<T>(work: (items: DeviceDownloadIntent[]) => Promise<T>) {
    const result = queue.then(async () => {
      const raw = await storage.getItem(KEY);
      const items: DeviceDownloadIntent[] = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(items) || items.some((item) => !item?.id || !item.url || !item.poem?.id)) {
        throw new Error('تعذر قراءة سجل تنزيلات الصوت؛ لم يُحذف أي تنزيل.');
      }
      return work(items);
    });
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    list: () => transaction(async (items) => items),
    change: (updater: (items: DeviceDownloadIntent[]) => DeviceDownloadIntent[]) =>
      transaction(async (items) => {
        const next = updater(items);
        await storage.setItem(KEY, JSON.stringify(next));
        return next;
      }),
  };
}

export type DeviceImportParams = {
  url: string; poem: Poem; existingPoemId?: string; reciter?: string;
  signal?: AbortSignal; onProgress?: (progress: number) => void;
};
type Result = { poemId: string; recording: Recording };
const hasAudio = (poem: Poem) => Boolean(poem.recording || poem.recordings?.length);
const reference = (poems: Poem[], id: string) => poems.find((poem) =>
  poem.recording?.id === id || poem.recordings?.some((recording) => recording.id === id));
const textIdentity = (poem: Poem) => JSON.stringify([
  poem.title, poem.poetName, poem.externalProvider, poem.externalId,
  poem.verses.map((verse) => [verse.id, verse.text]),
]);
class AdoptionConflict extends Error {}

export function createDeviceDownloadManager(deps: {
  store: ReturnType<typeof createDeviceIntentStore>;
  createId(): string;
  active(): boolean;
  poems(): Poem[];
  updatePoems(updater: (poems: Poem[]) => Poem[]): Promise<void>;
  list(): Promise<DeviceYoutubeOperation[]>;
  download(url: string, options: { recordingId: string; resumeOnly: boolean; onProgress?: (p: number) => void }): Promise<Recording>;
  cancel(id: string): Promise<void>;
  acknowledge(id: string): Promise<void>;
  discard(recording: Recording): Promise<void>;
  status(intent: DeviceDownloadIntent, status: DeviceDownloadRecovery | null): void;
}) {
  const locks = new Map<string, Promise<Result>>();
  const cancelling = new Set<string>();
  const adopted = new Set<string>();
  const removed = new Set<string>();
  const replacements = new Map<string, string>();
  let retryQueue: Promise<unknown> = Promise.resolve();
  const patch = (id: string, values: Partial<DeviceDownloadIntent>) =>
    deps.store.change((items) => items.map((item) => item.id === id ? { ...item, ...values } : item));
  const remove = async (intent: DeviceDownloadIntent) => {
    await deps.store.change((items) => items.filter((item) => item.id !== intent.id));
    removed.add(intent.id);
    deps.status(intent, null);
  };
  const report = (intent: DeviceDownloadIntent, error: unknown) => {
    if (removed.has(intent.id)) return;
    deps.status(intent, { id: intent.id, title: intent.poem.title, state: 'error',
      message: error instanceof Error ? error.message : 'تعذر استعادة تنزيل الصوت؛ أعد المحاولة.' });
  };
  async function finishSaved(intent: DeviceDownloadIntent) {
    // Mark adoption before ACK. A failed ACK must never turn into a discard.
    adopted.add(intent.id);
    await patch(intent.id, { adopted: true });
    await deps.acknowledge(intent.id);
    await remove(intent);
  }
  async function cleanup(intent: DeviceDownloadIntent, removeIntent = true) {
    if (intent.adopted || adopted.has(intent.id) || reference(deps.poems(), intent.id)) {
      await finishSaved(intent);
      return;
    }
    const operation = (await deps.list()).find((item) => item.recordingId === intent.id);
    if (operation?.state === 'running' || operation?.state === 'queued') {
      await deps.cancel(intent.id);
      throw new Error('جارٍ إلغاء التنزيل. انتظر تأكيد الجهاز ثم أعد محاولة الإلغاء.');
    }
    if (operation?.state === 'completed') {
      // Recheck references immediately before cleanup; never delete saved audio.
      if (reference(deps.poems(), intent.id) || adopted.has(intent.id)) {
        await finishSaved(intent);
        return;
      }
      if (!operation.audioUrl) throw new Error('تعذر تنظيف ملف الصوت؛ مسار الملف غير موجود.');
      await deps.discard({ id: intent.id, audioUrl: operation.audioUrl, durationMs: operation.durationMs ?? 0 });
    } else if (operation) {
      await deps.acknowledge(intent.id);
    }
    if (removeIntent) await remove(intent);
  }
  function run(intent: DeviceDownloadIntent, allowStart = false, onProgress?: (p: number) => void): Promise<Result> {
    const existing = locks.get(intent.id);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const saved = reference(deps.poems(), intent.id);
        if (saved || intent.adopted || adopted.has(intent.id)) {
          await finishSaved(intent);
          const recording = saved?.recording?.id === intent.id ? saved.recording :
            saved?.recordings?.find((item) => item.id === intent.id);
          if (!recording) throw new Error('تم حفظ التسجيل سابقًا؛ لم يُعَد إنشاء القصيدة المحذوفة.');
          return { poemId: saved!.id, recording };
        }
        if (intent.cleanup || cancelling.has(intent.id)) {
          if (intent.message && !cancelling.has(intent.id)) throw new Error(intent.message);
          await cleanup(intent);
          throw new Error('تم إلغاء تنزيل الصوت.');
        }
        const operation = (await deps.list()).find((item) => item.recordingId === intent.id);
        if (!operation && !allowStart) throw new Error('انقطع التنزيل أو فُقد سجلّه؛ أعد المحاولة يدويًا.');
        if (!operation && !deps.active()) throw new Error('افتح التطبيق لبدء تنزيل الصوت.');
        if (operation && !['queued', 'running', 'completed'].includes(operation.state)) {
          throw new Error('انقطع تنزيل الصوت أو فشل؛ أعد المحاولة يدويًا.');
        }
        deps.status(intent, { id: intent.id, title: intent.poem.title, state: 'running', progress: operation?.progress ?? 0 });
        const recording = { ...await deps.download(intent.url, {
          recordingId: intent.id,
          resumeOnly: !allowStart,
          onProgress: (progress) => {
            deps.status(intent, { id: intent.id, title: intent.poem.title, state: 'running', progress });
            onProgress?.(progress);
          },
        }), reciter: intent.reciter };
        let poemId = intent.existingPoemId ?? intent.poem.id;
        await deps.updatePoems((poems) => {
          if (cancelling.has(intent.id)) throw new AdoptionConflict('تم إلغاء تنزيل الصوت.');
          const already = reference(poems, intent.id);
          if (already) { poemId = already.id; return poems; }
          const current = poems.find((poem) => poem.id === poemId ||
            (!intent.existingPoemId && intent.poem.externalProvider && intent.poem.externalId &&
              poem.externalProvider === intent.poem.externalProvider && poem.externalId === intent.poem.externalId));
          if (intent.existingPoemId && !current) throw new AdoptionConflict('حُذفت القصيدة أثناء التنزيل؛ لم تُعَد إضافتها.');
          if (current && (hasAudio(current) || textIdentity(current) !== textIdentity(intent.poem))) {
            throw new AdoptionConflict('تغيّرت القصيدة أو أُضيف تسجيل آخر؛ لم يُستبدل أي تسجيل.');
          }
          if (current) {
            poemId = current.id;
            return poems.map((poem) => poem.id === current.id ? { ...poem, recording } : poem);
          }
          return [{ ...intent.poem, recording }, ...poems];
        });
        await finishSaved(intent);
        return { poemId, recording };
      } catch (error) {
        if (error instanceof AdoptionConflict) {
          // Persist cleanup ownership first; if this fails retain the completion.
          await patch(intent.id, { cleanup: true, message: error.message });
          await cleanup({ ...intent, cleanup: true }, false);
        } else if (cancelling.has(intent.id)) {
          await cleanup({ ...intent, cleanup: true });
        }
        report(intent, error);
        throw error;
      } finally {
        locks.delete(intent.id);
      }
    })().catch((error) => {
      // Cleanup/storage failures thrown inside the main catch must also be
      // visible rather than leaving a permanently "running" recovery row.
      report(intent, error);
      throw error;
    });
    locks.set(intent.id, promise);
    return promise;
  }
  async function recover() {
    const intents = await deps.store.list();
    // Do not block one recovered operation behind another's transfer.
    await Promise.all(intents.map((intent) => run(intent).catch((error) => report(intent, error))));
  }
  async function cancel(id: string) {
    while (replacements.has(id)) id = replacements.get(id)!;
    cancelling.add(id);
    const intent = (await deps.store.list()).find((item) => item.id === id);
    if (!intent) { cancelling.delete(id); return; }
    try {
      try {
        await patch(id, { cleanup: true });
      } catch (error) {
        // Even if JS storage is unavailable, ask the native journal to record
        // cancellation. Keep the intent and report the storage failure.
        if (!intent.adopted && !adopted.has(id) && !reference(deps.poems(), id)) {
          await deps.cancel(id);
        }
        throw error;
      }
      if (!intent.adopted && !adopted.has(id) && !reference(deps.poems(), id)) await deps.cancel(id);
      await locks.get(id)?.catch(() => undefined);
      await cleanup({ ...intent, cleanup: true });
      cancelling.delete(id);
    } catch (error) {
      // Keep the in-memory cancellation guard even if persisting cleanup or
      // native cancellation failed. A still-running transfer must not save.
      report(intent, error);
      throw error;
    }
  }
  async function start(params: DeviceImportParams, catalogId?: string): Promise<Result> {
    if (params.signal?.aborted) throw new Error('تم إلغاء تنزيل الصوت.');
    if (!deps.active()) throw new Error('افتح التطبيق لبدء تنزيل الصوت.');
    let intent: DeviceDownloadIntent | undefined;
    let created = false;
    await deps.store.change((items) => {
      const target = params.existingPoemId ?? params.poem.id;
      intent = items.find((item) => (item.existingPoemId ?? item.poem.id) === target);
      if (intent) return items;
      intent = { id: deps.createId(), url: params.url, poem: params.poem,
        existingPoemId: params.existingPoemId, reciter: params.reciter, catalogId };
      created = true;
      return [...items, intent];
    });
    const selected = intent!;
    // The native wrapper must not own cancellation/discard: only this layer
    // knows whether a recording has already been saved in the library.
    const abort = () => { void cancel(selected.id).catch((error) => report(selected, error)); };
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) {
      params.signal.removeEventListener('abort', abort);
      await cancel(selected.id);
      throw new Error('تم إلغاء تنزيل الصوت.');
    }
    try { return await run(selected, created, params.onProgress); }
    finally { params.signal?.removeEventListener('abort', abort); }
  }
  async function retryOnce(id: string) {
    const intent = (await deps.store.list()).find((item) => item.id === id);
    if (!intent) return;
    if (locks.has(id)) { await locks.get(id); return; }
    const operation = (await deps.list()).find((item) => item.recordingId === id);
    if (intent.cleanup) { await cancel(id); return; }
    if (intent.adopted || reference(deps.poems(), id) ||
        (operation && ['completed', 'running', 'queued'].includes(operation.state))) {
      await run(intent);
      return;
    }
    if (!deps.active()) throw new Error('افتح التطبيق لإعادة تنزيل الصوت.');
    if (operation) await deps.acknowledge(id);
    const latest = (await deps.store.list()).find((item) => item.id === id);
    if (!latest || latest.cleanup || cancelling.has(id)) return;
    const next = { ...intent, id: deps.createId(), message: undefined };
    replacements.set(id, next.id);
    try {
      await deps.store.change((items) => items.map((item) => item.id === id ? next : item));
    } catch (error) {
      replacements.delete(id);
      throw error;
    }
    deps.status(intent, null);
    await run(next, true);
  }
  function retry(id: string): Promise<void> {
    // Include list/terminal ACK/id replacement, not just the new transfer, in
    // the lock. Repeated clicks must never create competing replacement IDs.
    const result = retryQueue.then(() => retryOnce(id));
    retryQueue = result.catch(() => undefined);
    return result;
  }
  return { start, recover, retry, cancel, dismiss: cancel, intents: deps.store.list };
}