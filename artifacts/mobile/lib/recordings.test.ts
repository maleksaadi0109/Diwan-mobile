import { describe, expect, it } from 'vitest';
import type { Poem, Recording } from './types';
import { addPoemRecording, poemRecordings, selectedRecording, selectPoemRecording, validVerseTiming } from './recordings';

const first: Recording = { id: 'first', audioUrl: 'https://example.com/first.mp3', durationMs: 1000 };
const second: Recording = { id: 'second', audioUrl: 'https://example.com/second.mp3', durationMs: 2000 };
const alignment = (startMs: number, endMs: number) => ({ startMs, endMs, confidence: 0.8 });
const poem = (): Poem => ({
  id: 'poem', title: 'قصيدة', poetName: 'شاعر', createdAt: 1,
  recording: first,
  verses: [
    { id: 'one', orderIndex: 0, text: 'بيت أول', alignment: alignment(100, 200) },
    { id: 'two', orderIndex: 1, text: 'بيت ثان', alignment: alignment(200, 300) },
  ],
});

describe('recording selection', () => {
  it('recognizes a legacy single-recording poem without modifying it', () => {
    const legacy = poem();
    expect(poemRecordings(legacy)).toEqual([first]);
    expect(selectedRecording(legacy)).toEqual(first);
    expect(legacy.recordings).toBeUndefined();
    expect(legacy.verses[0].alignment).toEqual(alignment(100, 200));
  });

  it('keeps independent verse timings when adding and repeatedly switching recordings', () => {
    const original = poem();
    const added = addPoemRecording(original, second);
    expect(added.recording).toEqual(second);
    expect(added.verses.map((v) => v.alignment)).toEqual([undefined, undefined]);
    expect(added.verses[0].recordingAlignments?.first).toEqual(alignment(100, 200));
    const timedSecond: Poem = {
      ...added,
      verses: added.verses.map((v, i) => ({
        ...v, alignment: alignment(400 + i * 100, 500 + i * 100),
      })),
    };
    const back = selectPoemRecording(timedSecond, first.id);
    expect(back.verses.map((v) => v.alignment)).toEqual([
      alignment(100, 200), alignment(200, 300),
    ]);
    const again = selectPoemRecording(back, second.id);
    expect(again.verses.map((v) => v.alignment)).toEqual([
      alignment(400, 500), alignment(500, 600),
    ]);
    expect(again.verses[1].recordingAlignments?.first).toEqual(alignment(200, 300));
    expect(original.verses[0].recordingAlignments).toBeUndefined();
    expect(() => addPoemRecording(again, second)).toThrow('already exists');
    expect(() => selectPoemRecording(again, 'missing')).toThrow('not found');
  });
});

describe('timing boundaries used by the poem editor', () => {
  const previous = alignment(100, 200);
  const next = alignment(400, 500);
  it('allows exact adjacency and the recording endpoint', () => {
    expect(validVerseTiming('200', '400', 400, previous, next)).toBe(true);
  });
  it.each([
    ['-1', '300', 1000], ['1.5', '300', 1000], ['', '300', 1000],
    ['200', '200', 1000], ['300', '200', 1000], ['199', '300', 1000],
    ['200', '401', 1000], ['200', '1001', 1000],
    ['9007199254740993', '9007199254740994', 0],
  ])('rejects invalid interval %s–%s', (start, end, duration) => {
    expect(validVerseTiming(start, end, duration, previous, next)).toBe(false);
  });
});