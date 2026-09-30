import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSamplePoems } from './samplePoems';
import type { Poem, Recording } from './types';
import { attachDeviceSampleAudio } from './localSampleAudio';

const CATALOG_ID = 'catalog-taraneem-2';
const SAMPLE_POEM_ID = `sample-${CATALOG_ID}`;
const RECORDING: Recording = {
  id: 'yt-local-1234-a1b2c3',
  audioUrl: 'file:///documents/recording-audio/yt-local-1234-a1b2c3.mp3',
  durationMs: 24_000,
};

function setup() {
  let poem: Poem | undefined = createSamplePoems(123).find((item) => item.id === SAMPLE_POEM_ID);
  const download = vi.fn(async () => RECORDING);
  const discard = vi.fn(async () => {});
  const updatePoem = vi.fn(async (_id: string, updater: (current: Poem) => Poem) => {
    if (poem) poem = updater(poem);
  });
  const deps = {
    getPoem: () => poem,
    download,
    discard,
    updatePoem,
  };
  return {
    deps,
    download,
    discard,
    updatePoem,
    getPoem: () => poem,
    setPoem: (value: Poem | undefined) => { poem = value; },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('device sample audio attachment', () => {
  it('attaches the downloaded recording and retains it without discarding', async () => {
    const test = setup();

    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).resolves.toBe('attached');
    expect(test.download).toHaveBeenCalledWith(expect.stringContaining('youtu'));
    expect(test.updatePoem).toHaveBeenCalledWith(SAMPLE_POEM_ID, expect.any(Function));
    expect(test.getPoem()?.recording).toMatchObject({
      ...RECORDING,
      reciter: expect.any(String),
    });
    expect(test.discard).not.toHaveBeenCalled();
  });

  it.each([
    ['poem deleted', (test: ReturnType<typeof setup>) => test.setPoem(undefined)],
    ['poem changed', (test: ReturnType<typeof setup>) => test.setPoem({ ...test.getPoem()!, externalId: 'changed-poem' })],
  ])('skips and discards its downloaded file if the %s while downloading', async (_case, changePoem) => {
    const test = setup();
    test.download.mockImplementationOnce(async () => {
      changePoem(test);
      return RECORDING;
    });

    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).resolves.toBe('skipped');
    expect(test.updatePoem).not.toHaveBeenCalled();
    expect(test.discard).toHaveBeenCalledWith(RECORDING);
    expect(test.getPoem()?.recording).toBeUndefined();
  });

  it('does not overwrite existing audio added while downloading', async () => {
    const test = setup();
    const personalRecording: Recording = {
      id: 'personal',
      audioUrl: 'file:///personal.mp3',
      durationMs: 1000,
    };
    test.download.mockImplementationOnce(async () => {
      test.setPoem({ ...test.getPoem()!, recording: personalRecording });
      return RECORDING;
    });

    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).resolves.toBe('skipped');
    expect(test.getPoem()?.recording).toEqual(personalRecording);
    expect(test.discard).toHaveBeenCalledWith(RECORDING);
  });

  it('discards the downloaded file if saving the poem fails', async () => {
    const test = setup();
    test.updatePoem.mockRejectedValueOnce(new Error('save failed'));

    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).rejects.toThrow('save failed');
    expect(test.getPoem()?.recording).toBeUndefined();
    expect(test.discard).toHaveBeenCalledWith(RECORDING);
  });

  it('keeps the file if the poem is saved before the update reports an error', async () => {
    const test = setup();
    test.updatePoem.mockImplementationOnce(async (_id, updater) => {
      test.setPoem(updater(test.getPoem()!));
      throw new Error('post-save failure');
    });

    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).rejects.toThrow('post-save failure');
    expect(test.getPoem()?.recording?.id).toBe(RECORDING.id);
    expect(test.discard).not.toHaveBeenCalled();
  });

  it('skips an already-aborted request before downloading', async () => {
    const test = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(attachDeviceSampleAudio(CATALOG_ID, { ...test.deps, signal: controller.signal }))
      .resolves.toBe('skipped');
    expect(test.download).not.toHaveBeenCalled();
    expect(test.discard).not.toHaveBeenCalled();
  });

  it('discards the result when aborted while the download is in flight', async () => {
    let resolveDownload!: (recording: Recording) => void;
    const test = setup();
    test.download.mockImplementationOnce(() => new Promise((resolve) => { resolveDownload = resolve; }));
    const controller = new AbortController();
    const result = attachDeviceSampleAudio(CATALOG_ID, { ...test.deps, signal: controller.signal });
    controller.abort();
    resolveDownload(RECORDING);

    await expect(result).resolves.toBe('skipped');
    expect(test.updatePoem).not.toHaveBeenCalled();
    expect(test.discard).toHaveBeenCalledWith(RECORDING);
    expect(test.getPoem()?.recording).toBeUndefined();
  });

  it('skips invalid catalog IDs and poems that already contain audio', async () => {
    const test = setup();
    await expect(attachDeviceSampleAudio('not-a-sample', test.deps)).rejects.toThrow('قصائد التجربة');
    test.setPoem({
      ...test.getPoem()!,
      recordings: [{ id: 'personal', audioUrl: 'file:///personal.mp3', durationMs: 1000 }],
    });
    await expect(attachDeviceSampleAudio(CATALOG_ID, test.deps)).resolves.toBe('skipped');
    expect(test.download).not.toHaveBeenCalled();
  });
});