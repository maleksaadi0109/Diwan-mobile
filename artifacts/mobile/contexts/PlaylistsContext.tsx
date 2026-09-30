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
import { makeLocalId } from '@/lib/api';
import { withoutPoemIds } from '@/lib/poemDeletion';
import type { Playlist } from '@/lib/types';

const STORAGE_KEY = 'diwan.mobile.playlists.v1';

interface PlaylistsContextValue {
  playlists: Playlist[];
  isLoading: boolean;
  getPlaylist: (id: string) => Playlist | undefined;
  createPlaylist: (name: string, poemIds?: string[]) => Promise<Playlist>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addPoemToPlaylist: (playlistId: string, poemId: string) => Promise<void>;
  addPoemsToPlaylist: (playlistId: string, poemIds: string[]) => Promise<void>;
  removePoemFromPlaylist: (playlistId: string, poemId: string) => Promise<void>;
  removePoemIdsFromPlaylists: (poemIds: string[]) => Promise<void>;
  mergeImportedPlaylists: (
    imported: Playlist[],
    availablePoemIds: string[],
  ) => Promise<{ added: number; skipped: number }>;
}

const PlaylistsContext = createContext<PlaylistsContextValue | undefined>(
  undefined,
);

export function PlaylistsProvider({ children }: { children: React.ReactNode }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const playlistsRef = useRef<Playlist[]>([]);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const initialLoad = useRef<Promise<void> | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    initialLoad.current = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        if (raw) {
          try {
            const stored = JSON.parse(raw) as Playlist[];
            playlistsRef.current = stored;
            setPlaylists(stored);
          } catch {
            setPlaylists([]);
          }
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

  const updatePlaylists = useCallback(
    (updater: (current: Playlist[]) => Playlist[]) => {
      const write = writeQueue.current.then(async () => {
        const next = updater(playlistsRef.current);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        playlistsRef.current = next;
        setPlaylists(next);
      });
      // A failed operation rejects its caller, but does not poison the queue.
      writeQueue.current = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },
    [],
  );

  const getPlaylist = useCallback(
    (id: string) => playlists.find((p) => p.id === id),
    [playlists],
  );

  const createPlaylist = useCallback(
    async (name: string, poemIds: string[] = []) => {
      const playlist: Playlist = {
        id: makeLocalId('playlist'),
        name,
        poemIds: Array.from(new Set(poemIds)),
        createdAt: Date.now(),
      };
      await updatePlaylists((current) => [playlist, ...current]);
      return playlist;
    },
    [updatePlaylists],
  );

  const renamePlaylist = useCallback(
    async (id: string, name: string) => {
      await updatePlaylists((current) =>
        current.map((p) => (p.id === id ? { ...p, name } : p)),
      );
    },
    [updatePlaylists],
  );

  const deletePlaylist = useCallback(
    async (id: string) => {
      await updatePlaylists((current) => current.filter((p) => p.id !== id));
    },
    [updatePlaylists],
  );

  const addPoemToPlaylist = useCallback(
    async (playlistId: string, poemId: string) => {
      await updatePlaylists((current) =>
        current.map((p) =>
          p.id === playlistId && !p.poemIds.includes(poemId)
            ? { ...p, poemIds: [...p.poemIds, poemId] }
            : p,
        ),
      );
    },
    [updatePlaylists],
  );

  const addPoemsToPlaylist = useCallback(
    async (playlistId: string, poemIds: string[]) => {
      const requestedIds = new Set(poemIds);
      await updatePlaylists((current) =>
        current.map((p) =>
          p.id === playlistId
            ? { ...p, poemIds: Array.from(new Set([...p.poemIds, ...requestedIds])) }
            : p,
        ),
      );
    },
    [updatePlaylists],
  );

  const removePoemFromPlaylist = useCallback(
    async (playlistId: string, poemId: string) => {
      await updatePlaylists((current) =>
        current.map((p) =>
          p.id === playlistId
            ? { ...p, poemIds: p.poemIds.filter((id) => id !== poemId) }
            : p,
        ),
      );
    },
    [updatePlaylists],
  );

  const removePoemIdsFromPlaylists = useCallback(
    async (poemIds: string[]) => {
      // Deletion can be requested while playlists are still loading. Never
      // overwrite persisted playlists based on an empty initial state.
      if (!initialLoad.current) throw new Error('قوائم التشغيل لم تُحمّل بعد.');
      await initialLoad.current;
      const ids = new Set(poemIds);
      await updatePlaylists((current) => withoutPoemIds(current, ids));
    },
    [updatePlaylists],
  );

  const mergeImportedPlaylists = useCallback(
    async (imported: Playlist[], availablePoemIds: string[]) => {
      if (!Array.isArray(imported) || imported.length > 500) {
        throw new Error('قوائم التشغيل المستوردة غير صالحة.');
      }
      const availableIds = new Set(availablePoemIds);
      const incomingIds = new Set<string>();
      for (const playlist of imported) {
        if (
          !playlist ||
          typeof playlist !== 'object' ||
          Object.keys(playlist).some(
            (key) => !['id', 'name', 'poemIds', 'createdAt'].includes(key),
          ) ||
          typeof playlist.id !== 'string' ||
          playlist.id.length === 0 ||
          playlist.id.length > 128 ||
          /\s/.test(playlist.id) ||
          typeof playlist.name !== 'string' ||
          playlist.name.length === 0 ||
          playlist.name.length > 500 ||
          !Array.isArray(playlist.poemIds) ||
          playlist.poemIds.length > 1_000 ||
          !Number.isSafeInteger(playlist.createdAt) ||
          playlist.createdAt < 0 ||
          incomingIds.has(playlist.id)
        ) {
          throw new Error('قوائم التشغيل المستوردة تحتوي على بيانات غير صالحة.');
        }
        incomingIds.add(playlist.id);
        const referencedIds = new Set<string>();
        for (const poemId of playlist.poemIds) {
          if (
            typeof poemId !== 'string' ||
            poemId.length === 0 ||
            poemId.length > 128 ||
            /\s/.test(poemId) ||
            !availableIds.has(poemId) ||
            referencedIds.has(poemId)
          ) {
            throw new Error(
              `القائمة "${playlist.name}" تشير إلى قصيدة غير موجودة أو تحتوي على معرّف غير صالح.`,
            );
          }
          referencedIds.add(poemId);
        }
      }

      const write = writeQueue.current.then(async () => {
        const current = playlistsRef.current;
        const existingIds = new Set<string>();
        for (const playlist of current) {
          if (
            !playlist ||
            typeof playlist.id !== 'string' ||
            existingIds.has(playlist.id) ||
            !Array.isArray(playlist.poemIds)
          ) {
            throw new Error('قوائم التشغيل الحالية غير صالحة؛ لم يتم استبدالها.');
          }
          existingIds.add(playlist.id);
        }
        const additions = imported.filter(
          (playlist) => !existingIds.has(playlist.id),
        );
        if (additions.length > 0) {
          const next = [...additions, ...current];
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          playlistsRef.current = next;
          setPlaylists(next);
        }
        return {
          added: additions.length,
          skipped: imported.length - additions.length,
        };
      });
      writeQueue.current = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },
    [],
  );

  const value = useMemo(
    () => ({
      playlists,
      isLoading,
      getPlaylist,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addPoemToPlaylist,
      addPoemsToPlaylist,
      removePoemFromPlaylist,
      removePoemIdsFromPlaylists,
      mergeImportedPlaylists,
    }),
    [
      playlists,
      isLoading,
      getPlaylist,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addPoemToPlaylist,
      addPoemsToPlaylist,
      removePoemFromPlaylist,
      removePoemIdsFromPlaylists,
      mergeImportedPlaylists,
    ],
  );

  return (
    <PlaylistsContext.Provider value={value}>
      {children}
    </PlaylistsContext.Provider>
  );
}

export function usePlaylists() {
  const ctx = useContext(PlaylistsContext);
  if (!ctx) throw new Error('usePlaylists must be used within PlaylistsProvider');
  return ctx;
}
