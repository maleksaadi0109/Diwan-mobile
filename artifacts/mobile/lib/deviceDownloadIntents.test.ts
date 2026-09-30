import { describe, expect, it, vi } from 'vitest';
import { createDeviceDownloadManager, createDeviceIntentStore, type DeviceDownloadIntent } from './deviceDownloadIntents';
import type { DeviceYoutubeOperation } from './deviceYoutube';
import type { Poem, Recording } from './types';

const poem: Poem = { id: 'poem', title: 'قصيدة', poetName: 'شاعر', createdAt: 1,
  verses: [{ id: 'verse', orderIndex: 0, text: 'نص' }] };
const intent: DeviceDownloadIntent = { id: 'old', url: 'https://youtube.com/watch?v=abcdefghijk', poem };
const recording = (id: string): Recording => ({ id, audioUrl: `file:///${id}.mp3`, durationMs: 1000 });
const completion = (id = 'old'): DeviceYoutubeOperation => ({
  recordingId: id, url: intent.url, state: 'completed', progress: 1, ...recording(id),
});
function setup() {
  let raw: string | null = null;
  let poems: Poem[] = [];
  let operations: DeviceYoutubeOperation[] = [];
  let active = true;
  let sequence = 0;
  const storage = {
    getItem: vi.fn(async () => raw),
    setItem: vi.fn(async (_key: string, value: string) => { raw = value; }),
  };
  const store = createDeviceIntentStore(storage);
  const deps = {
    store, createId: () => `new-${++sequence}`, active: () => active,
    poems: () => poems,
    updatePoems: vi.fn(async (updater: (items: Poem[]) => Poem[]) => { poems = updater(poems); }),
    list: vi.fn(async () => operations),
    download: vi.fn(async (_url: string, options: { recordingId: string; resumeOnly: boolean }) => {
      const id = options.recordingId;
      operations = [completion(id)];
      return recording(id);
    }),
    cancel: vi.fn(async (id: string) => {
      operations = operations.map((item) => item.recordingId === id ? { ...item, state: 'cancelled' } : item);
    }),
    acknowledge: vi.fn(async (id: string) => { operations = operations.filter((item) => item.recordingId !== id); }),
    discard: vi.fn(async (value: Recording) => { operations = operations.filter((item) => item.recordingId !== value.id); }),
    status: vi.fn(),
  };
  return {
    deps, store, storage, manager: createDeviceDownloadManager(deps),
    setPoems: (items: Poem[]) => { poems = items; },
    setOperations: (items: DeviceYoutubeOperation[]) => { operations = items; },
    setActive: (value: boolean) => { active = value; },
  };
}
async function seed(test: ReturnType<typeof setup>, value = intent) {
  await test.store.change(() => [value]);
}

describe('durable device download adoption', () => {
  it('serializes read/modify/write transactions and continues after failed writes', async () => {
    const test = setup();
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      test.store.change((items) => [...items, { ...intent, id: String(index) }])));
    expect(await test.store.list()).toHaveLength(12);
    test.storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(test.store.change(() => [])).rejects.toThrow('disk full');
    expect(await test.store.list()).toHaveLength(12);
  });

  it('persists the draft and id before starting native work', async () => {
    const test = setup();
    test.deps.download.mockImplementationOnce(async (_url, options) => {
      expect(await test.store.list()).toMatchObject([{ id: options.recordingId, poem }]);
      expect(options.resumeOnly).toBe(false);
      return recording(options.recordingId);
    });
    const result = await test.manager.start({ url: intent.url, poem });
    expect(result.poemId).toBe(poem.id);
    expect(test.deps.poems()[0].recording?.id).toBe(result.recording.id);
    expect(test.deps.acknowledge).toHaveBeenCalledWith(result.recording.id);
    expect(await test.store.list()).toEqual([]);
  });

  it('does not start a transfer when durable intent storage fails', async () => {
    const test = setup();
    test.storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(test.manager.start({ url: intent.url, poem })).rejects.toThrow();
    expect(test.deps.download).not.toHaveBeenCalled();
  });

  it('adopts a process-death completion using its original id without starting again', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([completion()]);
    await test.manager.recover();
    expect(test.deps.download).toHaveBeenCalledWith(intent.url, expect.objectContaining({
      recordingId: 'old', resumeOnly: true,
    }));
    expect(test.deps.poems()[0].recording?.id).toBe('old');
    await test.manager.recover();
    expect(test.deps.download).toHaveBeenCalledTimes(1);
  });

  it('retains completion on failed library save and retries same id', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([completion()]);
    test.deps.updatePoems.mockRejectedValueOnce(new Error('library full'));
    await test.manager.recover();
    expect(await test.store.list()).toHaveLength(1);
    expect(test.deps.discard).not.toHaveBeenCalled();
    expect(test.deps.acknowledge).not.toHaveBeenCalled();
    await test.manager.retry('old');
    expect(test.deps.poems()[0].recording?.id).toBe('old');
    expect(test.deps.download.mock.calls.every((call) => call[1].recordingId === 'old')).toBe(true);
  });

  it('after failed ACK a restarted manager only ACKs the saved id, even after poem deletion', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([completion()]);
    test.deps.acknowledge.mockRejectedValueOnce(new Error('native busy'));
    await test.manager.recover();
    expect(await test.store.list()).toMatchObject([{ adopted: true }]);
    test.setPoems([]);
    await createDeviceDownloadManager(test.deps).recover();
    expect(test.deps.download).toHaveBeenCalledTimes(1);
    expect(test.deps.discard).not.toHaveBeenCalled();
    expect(test.deps.poems()).toEqual([]);
    expect(await test.store.list()).toEqual([]);
  });

  it('recognizes a saved reference if intent adoption-marker storage failed', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([completion()]);
    test.storage.setItem.mockRejectedValueOnce(new Error('intent write failed'));
    await test.manager.recover();
    await createDeviceDownloadManager(test.deps).recover();
    expect(test.deps.download).toHaveBeenCalledTimes(1);
    expect(test.deps.discard).not.toHaveBeenCalled();
    expect(await test.store.list()).toEqual([]);
  });

  it.each(['recording', 'deleted', 'edited'] as const)('does not overwrite/resurrect an existing poem: %s', async (change) => {
    const test = setup();
    await seed(test, { ...intent, existingPoemId: poem.id, catalogId: 'sample' });
    test.setPoems(change === 'deleted' ? [] : [{
      ...poem, ...(change === 'recording' ? { recording: recording('personal') } : { title: 'edited' }),
    }]);
    test.setOperations([completion()]);
    await test.manager.recover();
    expect(test.deps.discard).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    expect(test.deps.poems().some((item) => item.recording?.id === 'old')).toBe(false);
    expect(await test.store.list()).toMatchObject([{ cleanup: true, message: expect.any(String) }]);
    await test.manager.dismiss('old');
    expect(await test.store.list()).toEqual([]);
    expect(test.deps.status.mock.calls.at(-1)?.[1]).toBe(null);
  });

  it.each(['interrupted', 'missing'] as const)('does not auto restart %s; concurrent manual retries create one fresh id', async (state) => {
    const test = setup();
    await seed(test);
    test.setOperations(state === 'missing' ? [] : [{ ...completion(), state }]);
    await test.manager.recover();
    expect(test.deps.download).not.toHaveBeenCalled();
    await Promise.all([test.manager.retry('old'), test.manager.retry('old')]);
    expect(test.deps.download).toHaveBeenCalledTimes(1);
    expect(test.deps.download.mock.calls[0][1]).toMatchObject({ recordingId: 'new-1', resumeOnly: false });
  });

  it('refuses new background transfers but recovers existing completions in background', async () => {
    const test = setup();
    test.setActive(false);
    await expect(test.manager.start({ url: intent.url, poem })).rejects.toThrow('افتح التطبيق');
    expect(test.deps.download).not.toHaveBeenCalled();
    await seed(test);
    test.setOperations([completion()]);
    await test.manager.recover();
    expect(test.deps.poems()[0].recording?.id).toBe('old');
  });

  it('explicit cancellation requires confirmed terminal state and removes the intent', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([{ ...completion(), state: 'running' }]);
    await test.manager.cancel('old');
    expect(test.deps.cancel).toHaveBeenCalledWith('old');
    expect(test.deps.acknowledge).toHaveBeenCalledWith('old');
    expect(await test.store.list()).toEqual([]);
  });

  it('retains a cleanup intent when native cancellation has not yet become terminal', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([{ ...completion(), state: 'running' }]);
    test.deps.cancel.mockImplementation(async () => {});
    await expect(test.manager.cancel('old')).rejects.toThrow('جارٍ إلغاء');
    expect(await test.store.list()).toMatchObject([{ cleanup: true }]);
    expect(test.deps.acknowledge).not.toHaveBeenCalled();
  });

  it('dismissal of an already-saved recording never discards its audio', async () => {
    const test = setup();
    await seed(test);
    test.setOperations([completion()]);
    test.setPoems([{ ...poem, recordings: [recording('old')] }]);
    await test.manager.dismiss('old');
    expect(test.deps.discard).not.toHaveBeenCalled();
    expect(test.deps.cancel).not.toHaveBeenCalled();
    expect(await test.store.list()).toEqual([]);
  });

  it('shares a live transfer with root recovery rather than downloading twice', async () => {
    const test = setup();
    let complete!: (value: Recording) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    test.deps.download.mockImplementationOnce((_url, options) => {
      test.setOperations([{ ...completion(options.recordingId), state: 'running' }]);
      started();
      return new Promise<Recording>((resolve) => { complete = resolve; });
    });
    const live = test.manager.start({ url: intent.url, poem });
    await ready;
    const recovery = test.manager.recover();
    complete(recording('new-1'));
    await Promise.all([live, recovery]);
    expect(test.deps.download).toHaveBeenCalledTimes(1);
    expect(test.deps.updatePoems).toHaveBeenCalledTimes(1);
  });

  it.each(['native', 'storage'] as const)('a failed %s cancellation cannot allow a live completion to save', async (failure) => {
    const test = setup();
    let complete!: (value: Recording) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    test.deps.download.mockImplementationOnce((_url, options) => {
      test.setOperations([{ ...completion(options.recordingId), state: 'running' }]);
      started();
      return new Promise<Recording>((resolve) => { complete = resolve; });
    });
    const live = test.manager.start({ url: intent.url, poem });
    const rejected = expect(live).rejects.toThrow('إلغاء');
    await ready;
    if (failure === 'native') test.deps.cancel.mockRejectedValueOnce(new Error('native unavailable'));
    else test.storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(test.manager.cancel('new-1')).rejects.toThrow('unavailable');
    test.setOperations([completion('new-1')]);
    complete(recording('new-1'));
    await rejected;
    expect(test.deps.poems()).toEqual([]);
    expect(test.deps.discard).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-1' }));
  });

  it('an explicit abort signal cancels native work without handing file deletion to the wrapper', async () => {
    const test = setup();
    const controller = new AbortController();
    let complete!: (value: Recording) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    test.deps.download.mockImplementationOnce((_url, options) => {
      expect(options).not.toHaveProperty('signal');
      test.setOperations([{ ...completion(options.recordingId), state: 'running' }]);
      started();
      return new Promise<Recording>((resolve) => { complete = resolve; });
    });
    const live = test.manager.start({ url: intent.url, poem, signal: controller.signal });
    const rejected = expect(live).rejects.toThrow('إلغاء');
    await ready;
    controller.abort();
    complete(recording('new-1'));
    await rejected;
    // Drain the cancel controller's queued cleanup.
    await test.manager.cancel('new-1');
    expect(test.deps.poems()).toEqual([]);
    expect(await test.store.list()).toEqual([]);
    expect(test.deps.status.mock.calls.at(-1)?.[1]).toBe(null);
  });
});