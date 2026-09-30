export interface VerseAlignment {
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface Verse {
  id: string;
  orderIndex: number;
  text: string;
  alignment?: VerseAlignment;
  /** Timings for recordings not currently selected. Legacy verses have only alignment. */
  recordingAlignments?: Record<string, VerseAlignment>;
  /** Provider-side verse ID, used for verified Mizan explanation lookups. */
  externalId?: string;
}

export interface Recording {
  id: string;
  audioUrl: string;
  /** The original remote URL when audioUrl points to a persistent local cache. */
  serverAudioUrl?: string;
  durationMs: number;
  title?: string;
  reciter?: string;
}

export interface Poem {
  id: string;
  title: string;
  poetName: string;
  /** Era supplied by a source or entered manually; never inferred. */
  era?: string;
  /** Poetic meter (Bahr) supplied by a source or entered manually. */
  meter?: string;
  verses: Verse[];
  recording?: Recording;
  recordings?: Recording[];
  selectedRecordingId?: string;
  coverImageUrl?: string;
  createdAt: number;
  sourceUrl?: string;
  /** Set when imported from a curated provider (e.g. "mizan_al_arab") so a
   * catalog entry can detect it was already imported and avoid duplicates. */
  externalProvider?: string;
  externalId?: string;
}

export interface Playlist {
  id: string;
  name: string;
  poemIds: string[];
  createdAt: number;
}
