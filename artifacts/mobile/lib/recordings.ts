import type { Poem, Recording, VerseAlignment } from './types';

export function poemRecordings(poem: Poem): Recording[] {
  const recordings = poem.recordings ?? [];
  return poem.recording && !recordings.some((item) => item.id === poem.recording!.id)
    ? [poem.recording, ...recordings]
    : recordings;
}

export function selectedRecording(poem: Poem): Recording | undefined {
  const recordings = poemRecordings(poem);
  return recordings.find((item) => item.id === poem.selectedRecordingId) ??
    recordings.find((item) => item.id === poem.recording?.id) ?? recordings[0];
}

export function selectPoemRecording(poem: Poem, recordingId: string): Poem {
  const recordings = poemRecordings(poem);
  const next = recordings.find((item) => item.id === recordingId);
  if (!next) throw new Error('Recording not found.');
  const previous = selectedRecording(poem);
  return {
    ...poem,
    recordings,
    selectedRecordingId: recordingId,
    recording: next,
    verses: poem.verses.map((verse) => {
      const alignments = { ...verse.recordingAlignments };
      if (previous && verse.alignment) alignments[previous.id] = verse.alignment;
      const alignment = alignments[recordingId];
      const { alignment: _old, ...rest } = verse;
      return { ...rest, recordingAlignments: alignments, ...(alignment ? { alignment } : {}) };
    }),
  };
}

export function addPoemRecording(poem: Poem, recording: Recording): Poem {
  const recordings = poemRecordings(poem);
  if (recordings.some((item) => item.id === recording.id)) throw new Error('Recording already exists.');
  return selectPoemRecording({ ...poem, recordings: [...recordings, recording] }, recording.id);
}

/** Validate the timing entered for the selected recording before changing a verse. */
export function validVerseTiming(
  startInput: string,
  endInput: string,
  durationMs: number,
  previous?: VerseAlignment,
  next?: VerseAlignment,
): boolean {
  if (!/^\d+$/.test(startInput) || !/^\d+$/.test(endInput)) return false;
  const start = Number(startInput);
  const end = Number(endInput);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    end > start && (durationMs <= 0 || end <= durationMs) &&
    (!previous || start >= previous.endMs) &&
    (!next || end <= next.startMs);
}