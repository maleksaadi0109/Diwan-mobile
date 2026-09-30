import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import type { Poem } from '@/lib/types';
import { getCachedRecordingAudioUri } from '@/lib/offlineAudio';

interface AudioPlayerContextValue {
  player: AudioPlayer;
  status: AudioStatus;
  activePoem: Poem | null;
  loadPoem: (poem: Poem) => Promise<void>;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function AudioPlayerProvider({ children }: { children: React.ReactNode }) {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [activePoem, setActivePoem] = useState<Poem | null>(null);
  const loadRequestId = useRef(0);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    });
  }, []);

  const loadPoem = useCallback(
    async (poem: Poem) => {
      if (!poem.recording) return;

      if (activePoem?.id !== poem.id || activePoem.recording?.id !== poem.recording.id ||
          activePoem.recording?.audioUrl !== poem.recording.audioUrl) {
        const requestId = ++loadRequestId.current;
        const cachedUri = await getCachedRecordingAudioUri(poem.recording);
        if (requestId !== loadRequestId.current) return;
        player.replace(
          cachedUri ?? poem.recording.serverAudioUrl ?? poem.recording.audioUrl,
        );
        setActivePoem(poem);
      }

      player.setActiveForLockScreen(true, {
        title: poem.title,
        artist: poem.poetName,
        albumTitle: 'ديوان',
      });
    },
    [activePoem?.id, activePoem?.recording?.id, activePoem?.recording?.audioUrl, player],
  );

  const value = useMemo(
    () => ({ player, status, activePoem, loadPoem }),
    [player, status, activePoem, loadPoem],
  );

  return <AudioPlayerContext.Provider value={value}>{children}</AudioPlayerContext.Provider>;
}

export function useGlobalAudioPlayer() {
  const context = useContext(AudioPlayerContext);
  if (!context) {
    throw new Error('useGlobalAudioPlayer must be used inside AudioPlayerProvider');
  }
  return context;
}