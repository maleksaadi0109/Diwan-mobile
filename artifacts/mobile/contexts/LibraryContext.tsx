import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createPoemRemoval } from '@/lib/poemDeletion';
import { SAMPLE_CATALOG_IDS, seedSamplePoems } from '@/lib/samplePoems';
import { attachSampleAudio, hasPoemAudio, isSampleCatalogId, type SampleAudioStatus } from '@/lib/sampleAudio';
import { AudioServerBusyError, cacheSampleTransfer, clearSampleTransfer, markSampleCaching, prepareSampleTransfer, readSampleTransfer } from '@/lib/sampleTransfer';
import { extractErrorMessage, toPlayableAudioUrl } from '@/lib/api';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import type { Poem } from '@/lib/types';

const STORAGE_KEY = 'diwan.mobile.poems.v1';

interface LibraryContextValue {
  poems: Poem[];
  isLoading: boolean;
  addPoem: (poem: Poem) => Promise<{ inserted: boolean; poemId: string }>;
  removePoem: (id: string) => Promise<void>;
  removePoems: (ids: string[]) => Promise<void>;
  getPoem: (id: string) => Poem | undefined;
  updatePoem: (id: string, updater: (poem: Poem) => Poem) => Promise<void>;
  sampleAudioStatus: Record<string, SampleAudioStatus>;
  retrySampleAudio: (catalogId: string, manual?: boolean) => Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | undefined>(
  undefined,
);

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const { removePoemIdsFromPlaylists } = usePlaylists();
  const [poems, setPoems] = useState<Poem[]>([]);
  const poemsRef = useRef<Poem[]>([]);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const initialLoad = useRef<Promise<void> | null>(null);
  const initialReadSucceeded = useRef(false);
  const sampleSeedStarted = useRef(false);
  const autoAudioStarted = useRef(false);
  const audioRunning = useRef(new Set<string>());
  const [isLoading, setIsLoading] = useState(true);
  const [samplesSeeded, setSamplesSeeded] = useState(false);
  const [sampleAudioStatus, setSampleAudioStatus] = useState<Record<string, SampleAudioStatus>>({});

  useEffect(() => {
    let mounted = true;
    initialLoad.current = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Poem[];
            if (!Array.isArray(parsed)) throw new Error('Invalid saved library');
            poemsRef.current = parsed;
            setPoems(parsed);
            initialReadSucceeded.current = true;
          } catch {
            setPoems([]);
          }
        } else {
          initialReadSucceeded.current = true;
        }
      });
    void initialLoad.current.then(
      () => { if (mounted) setIsLoading(false); },
      () => { if (mounted) setIsLoading(false); },
    );
    return () => {
      mounted = false;
    };
  }, []);

  const updatePoems = useCallback(
    (updater: (current: Poem[]) => Poem[]) => {
      const write = writeQueue.current.then(async () => {
        const next = updater(poemsRef.current);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        poemsRef.current = next;
        setPoems(next);
      });
      // Keep later writes runnable even when this caller's storage write fails.
      writeQueue.current = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },
    [],
  );

  const addPoem = useCallback(
    async (poem: Poem) => {
      let inserted = false;
      let poemId = poem.id;
      await updatePoems((current) => {
        const alreadySaved = current.find(
          (existing) =>
            existing.id === poem.id ||
            (poem.externalProvider !== undefined &&
              poem.externalId !== undefined &&
              existing.externalProvider === poem.externalProvider &&
              existing.externalId === poem.externalId),
        );
        if (alreadySaved) {
          poemId = alreadySaved.id;
          return current;
        }
        inserted = true;
        return [poem, ...current];
      });
      return { inserted, poemId };
    },
    [updatePoems],
  );

  const { removePoem, removePoems } = useMemo(
    () => createPoemRemoval(removePoemIdsFromPlaylists, async (updater) => {
      if (!initialLoad.current) throw new Error('المكتبة لم تُحمّل بعد.');
      await initialLoad.current;
      await updatePoems(updater);
    }),
    [removePoemIdsFromPlaylists, updatePoems],
  );

  const getPoem = useCallback(
    (id: string) => poems.find((p) => p.id === id),
    [poems],
  );

  const updatePoem = useCallback(
    async (id: string, updater: (poem: Poem) => Poem) => {
      await updatePoems((current) =>
        current.map((poem) => (poem.id === id ? updater(poem) : poem)),
      );
    },
    [updatePoems],
  );

  const retrySampleAudio = useCallback(async (catalogId: string, manual = true) => {
    if (!isSampleCatalogId(catalogId) || audioRunning.current.has(catalogId)) return;
    // The web preview cannot persist audio files. Never save a temporary
    // server URL there as if it were an offline phone recording.
    if (Platform.OS === 'web') return;
    const getCurrentPoem = () => poemsRef.current.find((poem) => poem.id === `sample-${catalogId}`);
    const current = getCurrentPoem();
    if (!current || hasPoemAudio(current)) return;
    audioRunning.current.add(catalogId);
    try {
      const previous = await readSampleTransfer(catalogId);
      let locallyCompleted = false;
      // An iOS background task may still own its staging file after process
      // death. Do not automatically start another transfer over it.
      if (previous?.caching) {
        const finalUri = `${FileSystem.documentDirectory}recording-audio/sample-audio-${catalogId}-${previous.jobId}.mp3`;
        const info = await FileSystem.getInfoAsync(finalUri);
        locallyCompleted = Boolean(info.exists && info.size);
        if (!manual && !locallyCompleted) {
          setSampleAudioStatus((prev) => ({ ...prev, [catalogId]: {
            phase: 'interrupted', message: 'انقطع حفظ الملف في الخلفية؛ أعد المحاولة إذا لم يكتمل.',
          } }));
          return;
        }
      }
      const result = await attachSampleAudio(catalogId, {
        getPoem: getCurrentPoem,
        download: (url) => locallyCompleted && previous?.playbackPath
          ? Promise.resolve({ playback_audio_path: previous.playbackPath, duration_ms: previous.durationMs, jobId: previous.jobId })
          : prepareSampleTransfer(catalogId, url, async (youtubeUrl, jobId) => {
          const response = await fetch(toPlayableAudioUrl('/api-worker/youtube/download'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Diwan-Temporary-Audio': '1' },
            body: JSON.stringify({ url: youtubeUrl, job_id: jobId }),
          });
          if (response.status === 429 || response.status === 503) {
            throw new AudioServerBusyError(response.status, response.headers.get('Retry-After'));
          }
          if (!response.ok) throw new Error(`تعذر تنزيل الصوت (HTTP ${response.status}).`);
          return response.json();
        }, () => setSampleAudioStatus((prev) => ({
          ...prev, [catalogId]: { phase: 'resuming' },
        }))),
        playableUrl: toPlayableAudioUrl,
        cache: async (recording) => {
          await markSampleCaching(catalogId);
          return cacheSampleTransfer(recording, (progress) => {
          setSampleAudioStatus((prev) => ({
            ...prev, [catalogId]: { phase: 'saving', progress },
          }));
          });
        },
        updatePoem,
        onPhase: (phase) => setSampleAudioStatus((prev) => ({
          ...prev,
          [catalogId]: { phase },
        })),
      });
      await clearSampleTransfer(catalogId);
      setSampleAudioStatus((prev) => {
        const next = { ...prev };
        if (result === 'attached' || getCurrentPoem()?.recording) {
          next[catalogId] = { phase: 'ready' };
        } else {
          delete next[catalogId];
        }
        return next;
      });
    } catch (error) {
      const persisted = await readSampleTransfer(catalogId).catch(() => null);
      setSampleAudioStatus((prev) => ({
        ...prev,
        [catalogId]: {
          phase: persisted ? 'interrupted' : 'error',
          message: extractErrorMessage(error, 'تعذر تنزيل الصوت؛ حاول مجددًا عند توفر الاتصال.'),
        },
      }));
    } finally {
      audioRunning.current.delete(catalogId);
    }
  }, [updatePoem]);

  useEffect(() => {
    if (isLoading || !initialReadSucceeded.current || sampleSeedStarted.current) return;
    sampleSeedStarted.current = true;
    void seedSamplePoems(AsyncStorage, addPoem).then(
      () => setSamplesSeeded(true),
      (error) => {
        sampleSeedStarted.current = false;
        console.error('تعذر إضافة القصائد التجريبية إلى المكتبة', error);
      },
    );
  }, [isLoading, addPoem]);

  useEffect(() => {
    if (!samplesSeeded || autoAudioStarted.current) return;
    autoAudioStarted.current = true;
    if (Platform.OS === 'web') return;
    // One at a time keeps bandwidth and storage use bounded. Each successful
    // recording is independently saved, so an interruption does not restart it.
    void (async () => {
      for (const catalogId of SAMPLE_CATALOG_IDS) {
        await retrySampleAudio(catalogId, false);
      }
    })();
  }, [samplesSeeded, retrySampleAudio]);

  const value = useMemo(
    () => ({ poems, isLoading, addPoem, removePoem, removePoems, getPoem, updatePoem, sampleAudioStatus, retrySampleAudio }),
    [poems, isLoading, addPoem, removePoem, removePoems, getPoem, updatePoem, sampleAudioStatus, retrySampleAudio],
  );

  return (
    <LibraryContext.Provider value={value}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider');
  return ctx;
}
