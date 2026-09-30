import React, { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useGlobalAudioPlayer } from '@/contexts/AudioPlayerContext';
import { ProgressBar } from '@/components/ProgressBar';
import { VerseShareModal } from '@/components/VerseShareModal';
import { formatDuration } from '@/lib/api';
import { splitHemistichs } from '@/lib/utils';
import type { Verse } from '@/lib/types';
import { fetchMizanExplanations, isSafeMizanVerseId, type MizanExplanation } from '@/lib/mizan';
import { hasSynchronizedAudio, sharePoemExport, type PoemExportFormat } from '@/lib/poemExport';
import { addPoemRecording, poemRecordings, selectPoemRecording, validVerseTiming } from '@/lib/recordings';
import { storeLocalRecordingAudio } from '@/lib/offlineAudio';
import { getReadyEntryForMobilePoem, getReciterForMobilePoem } from '@/lib/readyCatalog';
import { getBundledSampleThumbnailSource, getPoemCoverSource } from '@/lib/sampleThumbnails';
import { ReciterPortrait } from '@/components/ReciterPortrait';

export default function PoemPlayerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { getPoem, removePoem, updatePoem, sampleAudioStatus, retrySampleAudio, cancelSampleAudio } = useLibrary();
  const { playlists, createPlaylist, addPoemToPlaylist, removePoemFromPlaylist } =
    usePlaylists();
  const { fontSize, setFontSize } = useSettings();
  const [focusModeVisible, setFocusModeVisible] = useState(false);
  const focusScrollRef = React.useRef<ScrollView>(null);
  const focusVerseOffsets = React.useRef<Record<string, number>>({});
  const [editingVerseId, setEditingVerseId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [past, setPast] = useState<Verse[][]>([]);
  const [future, setFuture] = useState<Verse[][]>([]);
  const [playlistModalVisible, setPlaylistModalVisible] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [shareVerseIndex, setShareVerseIndex] = useState<number | null>(null);
  const [playerExpanded, setPlayerExpanded] = useState(true);
  const [pendingVerseSeekMs, setPendingVerseSeekMs] = useState<number | null>(null);
  const [infoVerseId, setInfoVerseId] = useState<string | null>(null);
  const [infoStatus, setInfoStatus] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [infoItems, setInfoItems] = useState<MizanExplanation[]>([]);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const infoRequestRef = React.useRef(0);
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<PoemExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftPoet, setDraftPoet] = useState('');
  const [draftEra, setDraftEra] = useState('');
  const [draftMeter, setDraftMeter] = useState('');
  const [recordingsVisible, setRecordingsVisible] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingTitle, setRecordingTitle] = useState('');
  const [recordingReciter, setRecordingReciter] = useState('');
  const [timingVerseId, setTimingVerseId] = useState<string | null>(null);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  const poem = getPoem(id);
  const coverSource = poem ? getPoemCoverSource(poem) : undefined;
  const bundledCover = Boolean(poem && coverSource && coverSource === getBundledSampleThumbnailSource(poem));
  const reciter = poem ? getReciterForMobilePoem(poem) : undefined;
  const readerName = reciter?.name ?? poem?.recording?.reciter;
  const readyEntry = poem && !poem.recording ? getReadyEntryForMobilePoem(poem) : undefined;
  const sampleAudioPhase = readyEntry && poem?.id === `sample-${readyEntry.id}`
    ? sampleAudioStatus[readyEntry.id]?.phase
    : undefined;
  const sampleAudioBusy = sampleAudioPhase === 'downloading' || sampleAudioPhase === 'saving' || sampleAudioPhase === 'resuming';
  const canCancelSample = sampleAudioBusy && Platform.OS === 'android';
  const timingVerse = poem?.verses.find((v) => v.id === timingVerseId);
  const infoVerse = poem?.verses.find((verse) => verse.id === infoVerseId) ?? null;
  const hasMizanVerseId = (verse: Verse) =>
    poem?.externalProvider === 'mizan_al_arab' && isSafeMizanVerseId(verse.externalId);

  const loadVerseInformation = async (verse: Verse) => {
    const requestId = ++infoRequestRef.current;
    setSelectedWord(null);
    setInfoItems([]);
    setInfoError(null);
    const externalId = verse.externalId;
    if (poem?.externalProvider !== 'mizan_al_arab' || !isSafeMizanVerseId(externalId)) {
      setInfoStatus('empty');
      return;
    }
    setInfoStatus('loading');
    try {
      const items = await fetchMizanExplanations(externalId);
      if (requestId !== infoRequestRef.current) return;
      setInfoItems(items);
      setInfoStatus(items.length ? 'loaded' : 'empty');
    } catch (error) {
      if (requestId !== infoRequestRef.current) return;
      setInfoError(error instanceof Error ? error.message : 'تعذر جلب شرح البيت');
      setInfoStatus('error');
    }
  };

  const openVerseInformation = (verse: Verse) => {
    setInfoVerseId(verse.id);
    void loadVerseInformation(verse);
  };

  const closeVerseInformation = () => {
    infoRequestRef.current++;
    setInfoVerseId(null);
    setSelectedWord(null);
    setInfoStatus('idle');
  };

  // Applies a verse-array mutation while recording an undo entry. Undo/redo
  // history here is scoped to this poem screen only (mirrors desktop's
  // per-poem undo scope, but as local component state instead of a global
  // context, since only verse edits/deletes/boundary marks happen here).
  const applyVerseChange = async (nextVerses: Verse[]) => {
    if (!poem) return;
    setPast((prev) => [...prev, poem.verses]);
    setFuture([]);
    await updatePoem(poem.id, (p) => ({ ...p, verses: nextVerses }));
  };

  const undo = async () => {
    if (!poem || past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [poem.verses, ...prev]);
    await updatePoem(poem.id, (p) => ({ ...p, verses: previous }));
  };

  const redo = async () => {
    if (!poem || future.length === 0) return;
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, poem.verses]);
    await updatePoem(poem.id, (p) => ({ ...p, verses: next }));
  };

  const { player, status, loadPoem } = useGlobalAudioPlayer();

  React.useEffect(() => {
    if (poem?.recording) loadPoem(poem);
  }, [poem, loadPoem]);

  React.useEffect(() => {
    if (pendingVerseSeekMs === null || !status.isLoaded) return;
    const targetMs = pendingVerseSeekMs;
    setPendingVerseSeekMs(null);
    void player.seekTo(targetMs / 1000).then(() => player.play());
  }, [pendingVerseSeekMs, player, status.isLoaded]);

  const currentMs = (status.currentTime ?? 0) * 1000;
  const durationMs =
    poem?.recording?.durationMs || (status.duration ?? 0) * 1000;
  const progress = durationMs > 0 ? currentMs / durationMs : 0;

  const activeVerseId = useMemo(() => {
    if (!poem) return null;
    const active = poem.verses.find(
      (v) =>
        v.alignment &&
        currentMs >= v.alignment.startMs &&
        currentMs < v.alignment.endMs,
    );
    return active?.id ?? null;
  }, [poem, currentMs]);

  const timedVerses = useMemo(
    () => poem?.verses.filter((verse) => verse.alignment) ?? [],
    [poem],
  );

  const verseNavigationIndex = useMemo(() => {
    if (timedVerses.length === 0) return -1;
    const activeIndex = timedVerses.findIndex((verse) => verse.id === activeVerseId);
    if (activeIndex >= 0) return activeIndex;
    const nextIndex = timedVerses.findIndex(
      (verse) => (verse.alignment?.startMs ?? 0) > currentMs,
    );
    return nextIndex < 0 ? timedVerses.length - 1 : Math.max(0, nextIndex - 1);
  }, [activeVerseId, currentMs, timedVerses]);

  React.useEffect(() => {
    if (!focusModeVisible || !activeVerseId) return;
    const offset = focusVerseOffsets.current[activeVerseId];
    if (offset != null) {
      focusScrollRef.current?.scrollTo({ y: Math.max(0, offset - 160), animated: true });
    }
  }, [activeVerseId, focusModeVisible]);

  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  if (!poem) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.topBar, { paddingTop: topInset + 8 }]}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Feather name="arrow-right" size={22} color={colors.foreground} />
          </Pressable>
        </View>
        <View style={styles.centerFill}>
          <Text style={{ color: colors.mutedForeground, fontFamily: 'Cairo_400Regular' }}>
            القصيدة غير موجودة
          </Text>
        </View>
      </View>
    );
  }

  const togglePlay = () => {
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  const seekBy = (deltaSeconds: number) => {
    const next = Math.max(0, (status.currentTime ?? 0) + deltaSeconds);
    player.seekTo(next);
  };

  const seekToRatio = (ratio: number) => {
    if (!durationMs) return;
    player.seekTo((ratio * durationMs) / 1000);
  };

  const seekToVerse = async (startMs: number) => {
    if (!status.isLoaded) {
      setPendingVerseSeekMs(startMs);
      loadPoem(poem);
      return;
    }
    await player.seekTo(startMs / 1000);
    player.play();
  };

  const seekToAdjacentVerse = async (direction: -1 | 1) => {
    const target = timedVerses[verseNavigationIndex + direction];
    if (target?.alignment) await seekToVerse(target.alignment.startMs);
  };

  const handleDelete = () => {
    Alert.alert('حذف القصيدة', `هل تريد حذف "${poem.title}" من مكتبتك؟`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف',
        style: 'destructive',
        onPress: async () => {
          try {
            await removePoem(poem.id);
            router.back();
          } catch {
            Alert.alert('خطأ', 'تعذر حذف القصيدة. تحقق من مساحة التخزين وحاول مجددًا.');
          }
        },
      },
    ]);
  };

  const handlePoemExport = async (format: PoemExportFormat) => {
    if (exportingFormat) return;
    setExportingFormat(format);
    setExportError(null);
    try {
      await sharePoemExport(poem, format);
      setExportModalVisible(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'تعذر تصدير الملف.');
    } finally {
      setExportingFormat(null);
    }
  };

  const startEditVerse = (verse: Verse) => {
    setEditingVerseId(verse.id);
    setEditingText(verse.text);
  };

  const cancelEditVerse = () => {
    setEditingVerseId(null);
    setEditingText('');
  };

  const saveEditVerse = async () => {
    const trimmed = editingText.trim();
    if (!editingVerseId || !trimmed) {
      cancelEditVerse();
      return;
    }
    await applyVerseChange(
      poem.verses.map((v) =>
        v.id === editingVerseId ? { ...v, text: trimmed } : v,
      ),
    );
    cancelEditVerse();
  };

  const handleDeleteVerse = (verse: Verse) => {
    Alert.alert('حذف البيت', 'هل تريد حذف هذا البيت من القصيدة؟', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف',
        style: 'destructive',
        onPress: async () => {
          await applyVerseChange(
            poem.verses
              .filter((v) => v.id !== verse.id)
              .map((v, index) => ({ ...v, orderIndex: index })),
          );
        },
      },
    ]);
  };

  // Touch equivalent of desktop's "press B during playback" boundary edit:
  // marks the split point between the active verse and the next one at the
  // current playback position.
  const markBoundaryHere = async () => {
    if (!activeVerseId) return;
    const activeIndex = poem.verses.findIndex((v) => v.id === activeVerseId);
    const nextVerse = poem.verses[activeIndex + 1];
    if (activeIndex === -1 || !nextVerse?.alignment) return;
    const activeVerse = poem.verses[activeIndex];
    if (!activeVerse.alignment) return;
    const boundaryMs = Math.round(currentMs);
    if (boundaryMs <= activeVerse.alignment.startMs ||
        boundaryMs >= nextVerse.alignment.endMs) {
      Alert.alert('وقت غير صالح', 'يجب أن يقع الحد بين بداية البيت الحالي ونهاية البيت التالي.');
      return;
    }
    await applyVerseChange(
      poem.verses.map((v, index) => {
        if (index === activeIndex) {
          return { ...v, alignment: { ...v.alignment!, endMs: boundaryMs } };
        }
        if (index === activeIndex + 1) {
          return { ...v, alignment: { ...v.alignment!, startMs: boundaryMs } };
        }
        return v;
      }),
    );
  };

  const openDetails = () => {
    setDraftTitle(poem.title);
    setDraftPoet(poem.poetName);
    setDraftEra(poem.era ?? '');
    setDraftMeter(poem.meter ?? '');
    setDetailsVisible(true);
  };

  const saveDetails = async () => {
    if (!draftTitle.trim() || !draftPoet.trim()) {
      Alert.alert('بيانات ناقصة', 'العنوان واسم الشاعر مطلوبان.');
      return;
    }
    await updatePoem(poem.id, (p) => ({
      ...p, title: draftTitle.trim(), poetName: draftPoet.trim(),
      era: draftEra.trim() || undefined, meter: draftMeter.trim() || undefined,
    }));
    setDetailsVisible(false);
  };

  const addRecording = async () => {
    if (recordingBusy) return;
    setRecordingBusy(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*', copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const uri = await storeLocalRecordingAudio(recordingId, asset.uri, asset.name);
      await updatePoem(poem.id, (p) => addPoemRecording(p, {
        id: recordingId, audioUrl: uri, durationMs: 0, title: asset.name,
      }));
      setRecordingsVisible(false);
    } catch (error) {
      Alert.alert('تعذر إضافة التسجيل', error instanceof Error ? error.message : 'حدث خطأ.');
    } finally {
      setRecordingBusy(false);
    }
  };

  const openRecordings = () => {
    setRecordingTitle(poem.recording?.title ?? '');
    setRecordingReciter(poem.recording?.reciter ?? '');
    setRecordingsVisible(true);
  };

  const saveRecordingDetails = async () => {
    if (!poem.recording) return;
    const id = poem.recording.id;
    await updatePoem(poem.id, (p) => {
      const recordings = poemRecordings(p).map((r) => r.id === id
        ? { ...r, title: recordingTitle.trim() || undefined, reciter: recordingReciter.trim() || undefined }
        : r);
      return { ...p, recordings, recording: recordings.find((r) => r.id === id) };
    });
  };

  const saveTiming = async () => {
    if (!timingVerse) return;
    const start = Number(startInput);
    const end = Number(endInput);
    const index = poem.verses.findIndex((v) => v.id === timingVerse.id);
    const previous = poem.verses[index - 1]?.alignment;
    const next = poem.verses[index + 1]?.alignment;
    if (!validVerseTiming(startInput, endInput, durationMs, previous, next)) {
      Alert.alert('توقيت غير صالح', 'أدخل أرقاماً صحيحة بالمللي ثانية؛ النهاية بعد البداية وضمن مدة التسجيل ودون تداخل.');
      return;
    }
    await applyVerseChange(poem.verses.map((v) => v.id === timingVerse.id
      ? { ...v, alignment: { startMs: start, endMs: end, confidence: v.alignment?.confidence ?? 1 } }
      : v));
    setTimingVerseId(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topInset + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} testID="player-back-button">
          <Feather name="arrow-right" size={22} color={colors.foreground} />
        </Pressable>
        <View style={styles.topBarActions}>
          <Pressable
            onPress={undo}
            disabled={past.length === 0}
            hitSlop={12}
            testID="player-undo-button"
          >
            <Feather
              name="rotate-ccw"
              size={19}
              color={past.length === 0 ? colors.border : colors.mutedForeground}
            />
          </Pressable>
          <Pressable
            onPress={redo}
            disabled={future.length === 0}
            hitSlop={12}
            testID="player-redo-button"
          >
            <Feather
              name="rotate-cw"
              size={19}
              color={future.length === 0 ? colors.border : colors.mutedForeground}
            />
          </Pressable>
          <Pressable
            onPress={openDetails}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="تعديل بيانات القصيدة"
            testID="player-edit-metadata"
          >
            <Feather name="edit" size={19} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={() => setPlaylistModalVisible(true)}
            hitSlop={12}
            testID="player-add-to-playlist-button"
          >
            <Feather name="list" size={19} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={() => {
              setExportError(null);
              setExportModalVisible(true);
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="تصدير القصيدة"
            testID="player-export-button"
          >
            <Feather name="download" size={19} color={colors.mutedForeground} />
          </Pressable>
          {poem.recording ? (
            <Pressable
              onPress={() => setFocusModeVisible(true)}
              hitSlop={12}
              testID="player-focus-mode-button"
            >
              <Feather name="maximize" size={19} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          <Pressable onPress={handleDelete} hitSlop={12} testID="player-delete-button">
            <Feather name="trash-2" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </View>

      <View style={styles.headerText}>
        {coverSource && !bundledCover ? (
          <Image
            source={coverSource}
            style={styles.coverImage}
            contentFit="cover"
            transition={180}
            accessibilityLabel={`الصورة المصغّرة لقصيدة ${poem.title}`}
          />
        ) : null}
        <Text style={[styles.title, { color: colors.foreground }]}>
          {poem.title}
        </Text>
        <Text style={[styles.poet, { color: colors.primary }]}>
          {poem.poetName}
        </Text>
        {poem.era || poem.meter ? (
          <Text style={[styles.poet, { color: colors.mutedForeground }]}>
            {[poem.era, poem.meter].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        {readerName ? (
          <View style={styles.readerRow}>
            <ReciterPortrait reciterId={reciter?.id} name={readerName} size={38} />
            <View style={styles.readerCopy}>
              <Text style={[styles.readerEyebrow, { color: colors.mutedForeground }]}>القارئ</Text>
              <Text style={[styles.readerName, { color: colors.foreground }]} numberOfLines={1}>
                {readerName}
              </Text>
            </View>
          </View>
        ) : null}
        {readyEntry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={canCancelSample ? 'إلغاء تنزيل صوت القارئ' : sampleAudioBusy ? 'جارٍ تنزيل صوت القارئ' : 'تنزيل صوت القارئ'}
            accessibilityState={{ disabled: sampleAudioBusy && !canCancelSample }}
            disabled={sampleAudioBusy && !canCancelSample}
            testID="player-download-reader-audio"
            onPress={() => {
              if (canCancelSample) {
                cancelSampleAudio(readyEntry.id);
              } else if ((sampleAudioPhase === 'error' || sampleAudioPhase === 'interrupted') && Platform.OS !== 'web') {
                void retrySampleAudio(readyEntry.id);
              } else {
                router.push({
                  pathname: '/(tabs)/import',
                  params: { catalogId: readyEntry.id, requestId: `${Date.now()}` },
                });
              }
            }}
            style={({ pressed }) => [styles.downloadAudio, {
              backgroundColor: colors.secondary,
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            }]}
          >
            <Feather name={canCancelSample ? 'x' : sampleAudioBusy ? 'clock' : sampleAudioPhase === 'error' ? 'rotate-cw' : 'download'} size={16} color={colors.primary} />
            <Text style={[styles.downloadAudioText, { color: colors.primary }]}>
              {canCancelSample ? `إلغاء التنزيل ${Math.round((sampleAudioStatus[readyEntry.id]?.progress ?? 0) * 100)}٪` : sampleAudioBusy ? 'جارٍ تنزيل صوت القارئ' : sampleAudioPhase === 'error' ? 'إعادة تنزيل الصوت' : 'تنزيل صوت القارئ'}
            </Text>
          </Pressable>
        ) : null}
         {readyEntry && (sampleAudioPhase === 'error' || sampleAudioPhase === 'interrupted') ? (
           <Text style={{ color: colors.mutedForeground, fontFamily: 'Cairo_400Regular', textAlign: 'right' }}>
             {sampleAudioStatus[readyEntry.id]?.message}
           </Text>
         ) : null}
        <Pressable onPress={openRecordings} accessibilityRole="button"
          accessibilityLabel="اختيار وإضافة التسجيلات" testID="player-recordings"
          style={{ padding: 8 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Cairo_600SemiBold' }}>
            {poem.recording ? `التسجيل: ${poem.recording.title ?? poem.recording.reciter ?? poem.recording.id} · ` : ''}
            التسجيلات ({poemRecordings(poem).length}) ▾
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.versesScroll}
        contentContainerStyle={{ paddingBottom: poem.recording ? 24 : 24 + bottomInset }}
      >
        {poem.verses.map((verse) => {
          const isActive = verse.id === activeVerseId;
          const isEditing = verse.id === editingVerseId;

          if (isEditing) {
            return (
              <View
                key={verse.id}
                style={[styles.verseEditRow, { borderColor: colors.border }]}
              >
                <TextInput
                  value={editingText}
                  onChangeText={setEditingText}
                  multiline
                  autoFocus
                  textAlign="right"
                  style={[
                    styles.verseEditInput,
                    {
                      fontSize,
                      color: colors.foreground,
                      fontFamily: 'Amiri_400Regular',
                    },
                  ]}
                  testID={`verse-edit-input-${verse.id}`}
                />
                <View style={styles.verseEditActions}>
                  <Pressable
                    onPress={cancelEditVerse}
                    hitSlop={10}
                    testID={`verse-edit-cancel-${verse.id}`}
                  >
                    <Text style={[styles.verseEditAction, { color: colors.mutedForeground }]}>
                      إلغاء
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={saveEditVerse}
                    hitSlop={10}
                    testID={`verse-edit-save-${verse.id}`}
                  >
                    <Text style={[styles.verseEditAction, { color: colors.primary }]}>
                      حفظ
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          }

          const { first, second } = splitHemistichs(verse.text);
          const confidence = verse.alignment?.confidence;
          const confidenceColor =
            confidence === undefined
              ? colors.mutedForeground
              : confidence >= 0.8
                ? '#34d399'
                : confidence >= 0.65
                  ? '#fbbf24'
                  : colors.destructive;

          return (
            <Pressable
              key={verse.id}
              onPress={() =>
                verse.alignment ? seekToVerse(verse.alignment.startMs) : undefined
              }
              onLongPress={() => startEditVerse(verse)}
              style={[
                styles.verseCard,
                {
                  backgroundColor: colors.card,
                  borderColor: isActive ? colors.primary : colors.border,
                },
                isActive && { backgroundColor: colors.accent },
              ]}
            >
              <View style={styles.verseMetaRow}>
                <View style={styles.verseMetaBadges}>
                  <View
                    style={[
                      styles.verseNumberBadge,
                      {
                        backgroundColor: isActive ? colors.primary : colors.secondary,
                        borderColor: isActive ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.verseNumberText,
                        { color: isActive ? colors.primaryForeground : colors.mutedForeground },
                      ]}
                    >
                      {verse.orderIndex + 1}
                    </Text>
                  </View>
                  {verse.alignment ? (
                    <View style={[styles.verseTimeBadge, { borderColor: colors.border }]}>
                      <Feather name="volume-2" size={11} color={colors.mutedForeground} />
                      <Text style={[styles.verseTimeText, { color: colors.mutedForeground }]}>
                        {formatDuration(verse.alignment.startMs)}
                      </Text>
                    </View>
                  ) : null}
                  {confidence !== undefined ? (
                    <View
                      style={[
                        styles.verseTimeBadge,
                        { borderColor: confidenceColor + '40' },
                      ]}
                    >
                      <Feather name="check-circle" size={11} color={confidenceColor} />
                      <Text style={[styles.verseTimeText, { color: confidenceColor }]}>
                        {Math.round(confidence * 100)}%
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.verseActionsRow}>
                  <Pressable
                    onPress={(event) => {
                      event.stopPropagation();
                      openVerseInformation(verse);
                    }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`شرح ومعاني البيت ${verse.orderIndex + 1}`}
                    testID={`verse-info-button-${verse.id}`}
                  >
                    <Feather name="book-open" size={15} color={colors.primary} />
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      event.stopPropagation();
                      setTimingVerseId(verse.id);
                      setStartInput(String(verse.alignment?.startMs ?? Math.round(currentMs)));
                      setEndInput(String(verse.alignment?.endMs ?? Math.round(currentMs + 1000)));
                    }}
                    disabled={!poem.recording}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`ضبط توقيت البيت ${verse.orderIndex + 1}`}
                    testID={`verse-timing-button-${verse.id}`}
                  >
                    <Feather name="clock" size={15} color={poem.recording ? colors.primary : colors.border} />
                  </Pressable>
                  <Pressable
                    onPress={() => startEditVerse(verse)}
                    hitSlop={10}
                    testID={`verse-edit-button-${verse.id}`}
                  >
                    <Feather name="edit-2" size={14} color={colors.mutedForeground} />
                  </Pressable>
                  <Pressable
                    onPress={() => setShareVerseIndex(poem.verses.findIndex((v) => v.id === verse.id))}
                    hitSlop={10}
                    testID={`verse-share-button-${verse.id}`}
                  >
                    <Feather name="share-2" size={14} color={colors.mutedForeground} />
                  </Pressable>
                  <Pressable
                    onPress={() => handleDeleteVerse(verse)}
                    hitSlop={10}
                    testID={`verse-delete-button-${verse.id}`}
                  >
                    <Feather name="trash-2" size={14} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              </View>

              <View style={styles.verseHemistichBlock}>
                <Text
                  style={[
                    styles.verseText,
                    {
                      fontSize,
                      color: isActive ? colors.accentForeground : colors.foreground,
                      lineHeight: fontSize * 1.7,
                    },
                  ]}
                >
                  {first}
                </Text>
                {second ? (
                  <>
                    <View style={styles.verseDivider}>
                      <Feather name="star" size={10} color={colors.primary} />
                    </View>
                    <Text
                      style={[
                        styles.verseText,
                        {
                          fontSize,
                          color: isActive ? colors.accentForeground : colors.foreground,
                          lineHeight: fontSize * 1.7,
                        },
                      ]}
                    >
                      {second}
                    </Text>
                  </>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {poem.recording && playerExpanded ? (
        <View
          style={[
            styles.playerBar,
            { paddingBottom: bottomInset + 16, borderTopColor: colors.border },
          ]}
        >
          <Pressable
            onPress={() => setPlayerExpanded(false)}
            hitSlop={12}
            style={styles.playerCollapseButton}
            accessibilityLabel="إخفاء المشغل"
            testID="player-collapse-button"
          >
            <Feather name="chevron-down" size={22} color={colors.mutedForeground} />
          </Pressable>
          <ProgressBar progress={progress} onSeek={seekToRatio} />
          <View style={styles.timeRow}>
            <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
              {formatDuration(currentMs)}
            </Text>
            <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
              {formatDuration(durationMs)}
            </Text>
          </View>
          <View style={styles.controlsRow}>
            <Pressable onPress={() => seekBy(-10)} hitSlop={12} testID="player-back-10">
              <Feather name="rotate-ccw" size={22} color={colors.foreground} />
            </Pressable>
            <Pressable
              onPress={togglePlay}
              testID="player-play-pause"
              style={[styles.playButton, { backgroundColor: colors.primary }]}
            >
              <Feather
                name={status.playing ? 'pause' : 'play'}
                size={26}
                color={colors.primaryForeground}
              />
            </Pressable>
            <Pressable onPress={() => seekBy(10)} hitSlop={12} testID="player-forward-10">
              <Feather name="rotate-cw" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          {timedVerses.length > 0 ? (
            <View style={styles.verseNavigationRow}>
              <Pressable
                onPress={() => seekToAdjacentVerse(-1)}
                disabled={verseNavigationIndex <= 0}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.verseNavigationButton,
                  { opacity: verseNavigationIndex <= 0 ? 0.35 : pressed ? 0.65 : 1 },
                ]}
                accessibilityLabel="البيت السابق"
                testID="player-previous-verse"
              >
                <Feather name="chevron-right" size={16} color={colors.foreground} />
                <Text style={[styles.verseNavigationText, { color: colors.foreground }]}>
                  السابق
                </Text>
              </Pressable>
              <Text style={[styles.verseNavigationHint, { color: colors.mutedForeground }]}>
                التنقل بين الأبيات
              </Text>
              <Pressable
                onPress={() => seekToAdjacentVerse(1)}
                disabled={verseNavigationIndex >= timedVerses.length - 1}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.verseNavigationButton,
                  {
                    opacity:
                      verseNavigationIndex >= timedVerses.length - 1
                        ? 0.35
                        : pressed
                          ? 0.65
                          : 1,
                  },
                ]}
                accessibilityLabel="البيت التالي"
                testID="player-next-verse"
              >
                <Text style={[styles.verseNavigationText, { color: colors.foreground }]}>
                  التالي
                </Text>
                <Feather name="chevron-left" size={16} color={colors.foreground} />
              </Pressable>
            </View>
          ) : null}
          {activeVerseId ? (
            <Pressable
              onPress={markBoundaryHere}
              hitSlop={8}
              style={styles.boundaryButton}
              testID="player-mark-boundary"
            >
              <Feather name="scissors" size={13} color={colors.mutedForeground} />
              <Text style={[styles.boundaryButtonText, { color: colors.mutedForeground }]}>
                ضبط حد البيت هنا
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : poem.recording ? (
        <View
          style={[
            styles.compactPlayer,
            {
              paddingBottom: bottomInset + 8,
              backgroundColor: colors.card,
              borderTopColor: colors.border,
            },
          ]}
        >
          <Pressable
            onPress={() => setPlayerExpanded(true)}
            hitSlop={10}
            style={styles.compactPlayerExpand}
            accessibilityLabel="إظهار المشغل"
            testID="player-expand-button"
          >
            <Feather name="chevron-up" size={22} color={colors.primary} />
            <Text style={[styles.compactPlayerText, { color: colors.mutedForeground }]}>
              إظهار المشغّل
            </Text>
          </Pressable>
          <Text style={[styles.compactPlayerTime, { color: colors.mutedForeground }]}>
            {formatDuration(currentMs)}
          </Text>
          <Pressable
            onPress={togglePlay}
            hitSlop={10}
            accessibilityLabel={status.playing ? 'إيقاف مؤقت' : 'تشغيل'}
            testID="compact-player-play-pause"
          >
            <Feather
              name={status.playing ? 'pause-circle' : 'play-circle'}
              size={30}
              color={colors.primary}
            />
          </Pressable>
        </View>
      ) : null}

      {shareVerseIndex !== null ? (
        <VerseShareModal
          poem={poem}
          initialVerseIndex={shareVerseIndex}
          onClose={() => setShareVerseIndex(null)}
        />
      ) : null}

      <Modal visible={detailsVisible} transparent animationType="slide" onRequestClose={() => setDetailsVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: bottomInset + 20 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>بيانات القصيدة</Text>
            {([
              ['العنوان', draftTitle, setDraftTitle],
              ['الشاعر', draftPoet, setDraftPoet],
              ['العصر', draftEra, setDraftEra],
              ['البحر', draftMeter, setDraftMeter],
            ] as const).map(([label, value, setter]) => (
              <TextInput key={label} value={value} onChangeText={setter} placeholder={label}
                accessibilityLabel={label} placeholderTextColor={colors.mutedForeground}
                style={[styles.verseEditInput, { color: colors.foreground, borderColor: colors.border, borderWidth: 1, marginTop: 10, padding: 8 }]} />
            ))}
            <View style={styles.verseEditActions}>
              <Pressable onPress={() => setDetailsVisible(false)} accessibilityRole="button"><Text style={{ color: colors.mutedForeground }}>إلغاء</Text></Pressable>
              <Pressable onPress={() => void saveDetails()} accessibilityRole="button" testID="save-poem-metadata"><Text style={{ color: colors.primary }}>حفظ</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={recordingsVisible} transparent animationType="slide" onRequestClose={() => setRecordingsVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: bottomInset + 20 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>تسجيلات القصيدة</Text>
            <ScrollView style={{ maxHeight: 350 }}>
              {poemRecordings(poem).map((recording) => (
                <Pressable key={recording.id} accessibilityRole="radio"
                  accessibilityState={{ selected: poem.recording?.id === recording.id }}
                  testID={`select-recording-${recording.id}`}
                  onPress={async () => {
                    await updatePoem(poem.id, (p) => selectPoemRecording(p, recording.id));
                    setPast([]);
                    setFuture([]);
                    setRecordingTitle(recording.title ?? '');
                    setRecordingReciter(recording.reciter ?? '');
                  }}
                  style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Text style={{ color: colors.foreground }}>
                    {poem.recording?.id === recording.id ? '✓ ' : ''}
                    {recording.title ?? recording.reciter ?? recording.id}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {poem.recording ? (
              <>
                <TextInput value={recordingTitle} onChangeText={setRecordingTitle} placeholder="اسم التسجيل"
                  accessibilityLabel="اسم التسجيل" placeholderTextColor={colors.mutedForeground}
                  style={[styles.verseEditInput, { color: colors.foreground, borderColor: colors.border, borderWidth: 1, marginTop: 8, padding: 8 }]} />
                <TextInput value={recordingReciter} onChangeText={setRecordingReciter} placeholder="القارئ"
                  accessibilityLabel="القارئ" placeholderTextColor={colors.mutedForeground}
                  style={[styles.verseEditInput, { color: colors.foreground, borderColor: colors.border, borderWidth: 1, marginTop: 8, padding: 8 }]} />
                <Pressable onPress={() => void saveRecordingDetails()} accessibilityRole="button"
                  testID="save-recording-metadata" style={{ padding: 10 }}>
                  <Text style={{ color: colors.primary }}>حفظ بيانات التسجيل</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable onPress={() => void addRecording()} disabled={recordingBusy || Platform.OS === 'web'}
              accessibilityRole="button" testID="add-poem-recording" style={{ padding: 14 }}>
              <Text style={{ color: colors.primary }}>{recordingBusy ? 'جارٍ الإضافة…' : 'إضافة ملف صوتي'}</Text>
            </Pressable>
            <Pressable onPress={() => setRecordingsVisible(false)} accessibilityRole="button" style={{ padding: 14 }}>
              <Text style={{ color: colors.mutedForeground }}>إغلاق</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={timingVerseId !== null} transparent animationType="slide" onRequestClose={() => setTimingVerseId(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: bottomInset + 20 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>ضبط توقيت البيت {timingVerse ? timingVerse.orderIndex + 1 : ''}</Text>
            <Text style={{ color: colors.mutedForeground }}>بالمللي ثانية (1000 = ثانية واحدة)</Text>
            <TextInput value={startInput} onChangeText={setStartInput} keyboardType="number-pad"
              accessibilityLabel="بداية البيت بالمللي ثانية" placeholder="البداية"
              style={[styles.verseEditInput, { color: colors.foreground, borderColor: colors.border, borderWidth: 1, marginTop: 10, padding: 8 }]} />
            <TextInput value={endInput} onChangeText={setEndInput} keyboardType="number-pad"
              accessibilityLabel="نهاية البيت بالمللي ثانية" placeholder="النهاية"
              style={[styles.verseEditInput, { color: colors.foreground, borderColor: colors.border, borderWidth: 1, marginTop: 10, padding: 8 }]} />
            <View style={styles.verseEditActions}>
              <Pressable onPress={() => setTimingVerseId(null)} accessibilityRole="button"><Text style={{ color: colors.mutedForeground }}>إلغاء</Text></Pressable>
              <Pressable onPress={() => void saveTiming()} accessibilityRole="button" testID="save-verse-timing"><Text style={{ color: colors.primary }}>حفظ</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={exportModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setExportModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: bottomInset + 20 },
            ]}
          >
            <View style={styles.modalHeader}>
              <Pressable
                onPress={() => setExportModalVisible(false)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="إغلاق التصدير"
              >
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>تصدير القصيدة</Text>
            </View>
            <Text style={[styles.infoNotice, { color: colors.mutedForeground }]}>
              نزّل ملفات التوقيت المتزامن أو نسخة JSON من بيانات القصيدة الحالية.
            </Text>
            {!hasSynchronizedAudio(poem) ? (
              <Text
                style={[styles.infoNotice, { color: colors.mutedForeground }]}
                accessibilityLiveRegion="polite"
              >
                ملفات LRC وSRT غير متاحة: أضف تسجيلاً صوتياً ومحاذاة زمنية فعلية للأبيات أولاً. لن تُنشأ توقيتات تلقائياً.
              </Text>
            ) : null}
            {([
              ['lrc', 'ملف LRC متزامن'],
              ['srt', 'ترجمة SRT'],
              ['json', 'بيانات القصيدة JSON'],
            ] as const).map(([format, label]) => {
              const timeExportUnavailable = format !== 'json' && !hasSynchronizedAudio(poem);
              const isBusy = exportingFormat === format;
              return (
                <Pressable
                  key={format}
                  onPress={() => void handlePoemExport(format)}
                  disabled={timeExportUnavailable || exportingFormat !== null}
                  style={[
                    styles.exportOption,
                    { borderColor: colors.border, backgroundColor: colors.card },
                    (timeExportUnavailable || exportingFormat !== null) && styles.exportOptionDisabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: timeExportUnavailable || exportingFormat !== null }}
                  testID={`poem-export-${format}`}
                >
                  <Feather
                    name={isBusy ? 'loader' : format === 'json' ? 'file-text' : 'clock'}
                    size={18}
                    color={timeExportUnavailable ? colors.border : colors.primary}
                  />
                  <Text
                    style={[
                      styles.exportOptionText,
                      { color: timeExportUnavailable ? colors.mutedForeground : colors.foreground },
                    ]}
                  >
                    {isBusy ? 'جارٍ التصدير…' : label}
                  </Text>
                  <Feather name="download" size={16} color={colors.mutedForeground} />
                </Pressable>
              );
            })}
            {exportError ? (
              <Text style={[styles.infoNotice, { color: colors.destructive }]} accessibilityLiveRegion="polite">
                {exportError}
              </Text>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={infoVerseId !== null}
        animationType="slide"
        transparent
        onRequestClose={closeVerseInformation}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              styles.infoModalCard,
              { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: bottomInset + 20 },
            ]}
            accessibilityViewIsModal
          >
            <View style={styles.modalHeader}>
              <Pressable
                onPress={closeVerseInformation}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="إغلاق معلومات البيت"
              >
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                شرح البيت {infoVerse ? infoVerse.orderIndex + 1 : ''}
              </Text>
            </View>

            {infoVerse ? (
              <ScrollView
                style={styles.infoScroll}
                contentContainerStyle={styles.infoScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={[styles.infoVerseText, { color: colors.foreground }]}>{infoVerse.text}</Text>
                <Text style={[styles.infoSectionTitle, { color: colors.primary }]}>شرح من ميزان العرب</Text>
                {!hasMizanVerseId(infoVerse) ? (
                  <Text style={[styles.infoNotice, { color: colors.mutedForeground }]}>
                    لا يتوفر معرّف هذا البيت من ميزان العرب. قد تكون القصيدة محفوظة قبل إضافة دعم المعرّفات؛ لا يمكن جلب شرح موثوق لها.
                  </Text>
                ) : infoStatus === 'loading' ? (
                  <View style={styles.infoStateRow} accessibilityLiveRegion="polite">
                    <Feather name="loader" size={16} color={colors.primary} />
                    <Text style={[styles.infoNotice, { color: colors.mutedForeground }]}>جارٍ جلب الشروح من ميزان العرب…</Text>
                  </View>
                ) : infoStatus === 'error' ? (
                  <View>
                    <Text style={[styles.infoNotice, { color: colors.destructive }]} accessibilityLiveRegion="polite">
                      {infoError}
                    </Text>
                    <Pressable
                      onPress={() => void loadVerseInformation(infoVerse)}
                      style={[styles.infoRetryButton, { borderColor: colors.border }]}
                      accessibilityRole="button"
                    >
                      <Feather name="refresh-cw" size={15} color={colors.primary} />
                      <Text style={[styles.infoWordText, { color: colors.primary }]}>إعادة المحاولة</Text>
                    </Pressable>
                  </View>
                ) : infoStatus === 'empty' ? (
                  <Text style={[styles.infoNotice, { color: colors.mutedForeground }]}>
                    {infoItems.length === 0 && hasMizanVerseId(infoVerse)
                      ? 'لم يعثر ميزان العرب على شرح منشور لهذا البيت.'
                      : 'لا توجد بيانات شرح موثوقة لهذا البيت.'}
                  </Text>
                ) : (
                  infoItems.map((item, index) => (
                    <View key={`${item.type}-${index}`} style={[styles.infoItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.infoItemSource, { color: colors.primary }]}>
                        {item.sourceTitle || item.author || (item.type === 'classical' ? 'شرح كلاسيكي' : 'شرح البيت')}
                      </Text>
                      <Text style={[styles.infoItemText, { color: colors.foreground }]}>{item.text}</Text>
                      {item.authorDeathHijri ? (
                        <Text style={[styles.infoAttribution, { color: colors.mutedForeground }]}>وفاة المؤلف: {item.authorDeathHijri} هـ</Text>
                      ) : null}
                    </View>
                  ))
                )}

                <Text style={[styles.infoSectionTitle, { color: colors.primary }]}>بحث كلمة</Text>
                <Text style={[styles.infoNotice, { color: colors.mutedForeground }]}>
                  اختر كلمة لعرض حالة البحث. لا يتوفر مصدر معجمي موثوق داخل تطبيق الهاتف حاليًا.
                </Text>
                <View style={styles.infoWords}>
                  {infoVerse.text.split(/\s+/).filter(Boolean).map((word, index) => (
                    <Pressable
                      key={`${index}-${word}`}
                      onPress={() => setSelectedWord(word.replace(/[،؛:!?؟.()[\]{}"']/g, ''))}
                      style={[
                        styles.infoWordChip,
                      { borderColor: selectedWord === word.replace(/[،؛:!?؟.()[\]{}"']/g, '') ? colors.primary : colors.border, backgroundColor: colors.card },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`بحث عن كلمة ${word}`}
                    >
                      <Text style={[styles.infoWordText, { color: colors.foreground }]}>{word}</Text>
                    </Pressable>
                  ))}
                </View>
                {selectedWord ? (
                  <Text style={[styles.infoNotice, { color: colors.mutedForeground }]} accessibilityLiveRegion="polite">
                    لا تتوفر مادة معجمية موثقة للكلمة «{selectedWord}» في هذا الإصدار؛ لم يتم إنشاء تعريف تخميني.
                  </Text>
                ) : null}
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={focusModeVisible}
        animationType="fade"
        onRequestClose={() => setFocusModeVisible(false)}
      >
        <View style={[styles.focusContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.focusTopBar, { paddingTop: topInset + 12 }]}>
            <Pressable
              onPress={() => setFocusModeVisible(false)}
              hitSlop={12}
              testID="focus-exit-button"
            >
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </Pressable>
            <View style={styles.focusFontControls}>
              <Pressable
                onPress={() => setFontSize(fontSize - 2)}
                hitSlop={10}
                testID="focus-font-decrease"
              >
                <Feather name="minus" size={16} color={colors.mutedForeground} />
              </Pressable>
              <Pressable
                onPress={() => setFontSize(fontSize + 2)}
                hitSlop={10}
                testID="focus-font-increase"
              >
                <Feather name="plus" size={16} color={colors.mutedForeground} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            ref={focusScrollRef}
            contentContainerStyle={styles.focusScrollContent}
          >
            <Text style={[styles.focusPoemTitle, { color: colors.foreground }]}>
              {poem.title}
            </Text>
            {poem.verses.map((verse) => {
              const isActive = verse.id === activeVerseId;
              const { first, second } = splitHemistichs(verse.text);
              return (
                <Pressable
                  key={verse.id}
                  onLayout={(e) => {
                    focusVerseOffsets.current[verse.id] = e.nativeEvent.layout.y;
                  }}
                  onPress={() => verse.alignment && seekToVerse(verse.alignment.startMs)}
                  testID={`focus-verse-${verse.id}`}
                  style={styles.focusVerseRow}
                >
                  <Text
                    style={[
                      styles.focusVerseText,
                      {
                        fontSize: fontSize + 6,
                        lineHeight: (fontSize + 6) * 1.8,
                        color: isActive ? colors.foreground : colors.mutedForeground,
                        fontFamily: isActive ? 'Amiri_700Bold' : 'Amiri_400Regular',
                      },
                    ]}
                  >
                    {first}
                  </Text>
                  {second ? (
                    <>
                      <View style={styles.focusVerseDivider}>
                        <Feather
                          name="star"
                          size={12}
                          color={isActive ? colors.primary : colors.mutedForeground}
                        />
                      </View>
                      <Text
                        style={[
                          styles.focusVerseText,
                          {
                            fontSize: fontSize + 6,
                            lineHeight: (fontSize + 6) * 1.8,
                            color: isActive ? colors.foreground : colors.mutedForeground,
                            fontFamily: isActive ? 'Amiri_700Bold' : 'Amiri_400Regular',
                          },
                        ]}
                      >
                        {second}
                      </Text>
                    </>
                  ) : null}
                </Pressable>
              );
            })}
            <View style={{ height: 140 }} />
          </ScrollView>

          <Pressable
            onPress={togglePlay}
            testID="focus-play-pause"
            style={[styles.focusPlayButton, { backgroundColor: colors.primary }]}
          >
            <Feather
              name={status.playing ? 'pause' : 'play'}
              size={24}
              color={colors.primaryForeground}
            />
          </Pressable>
        </View>
      </Modal>

      <Modal
        visible={playlistModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setPlaylistModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.background, paddingBottom: bottomInset + 20 },
            ]}
          >
            <View style={styles.modalHeader}>
              <Pressable onPress={() => setPlaylistModalVisible(false)} hitSlop={12}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                إضافة إلى قائمة تشغيل
              </Text>
            </View>

            <ScrollView style={styles.modalList}>
              {playlists.length === 0 ? (
                <Text style={[styles.modalEmpty, { color: colors.mutedForeground }]}>
                  لا توجد قوائم تشغيل بعد
                </Text>
              ) : (
                playlists.map((playlist) => {
                  const included = playlist.poemIds.includes(poem.id);
                  return (
                    <Pressable
                      key={playlist.id}
                      onPress={() =>
                        included
                          ? removePoemFromPlaylist(playlist.id, poem.id)
                          : addPoemToPlaylist(playlist.id, poem.id)
                      }
                      style={[styles.modalRow, { borderColor: colors.border }]}
                      testID={`playlist-toggle-${playlist.id}`}
                    >
                      <Feather
                        name={included ? 'check-square' : 'square'}
                        size={18}
                        color={included ? colors.primary : colors.mutedForeground}
                      />
                      <Text style={[styles.modalRowText, { color: colors.foreground }]}>
                        {playlist.name}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>

            <View
              style={[
                styles.createRow,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <TextInput
                value={newPlaylistName}
                onChangeText={setNewPlaylistName}
                placeholder="قائمة تشغيل جديدة"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.createInput, { color: colors.foreground, fontFamily: 'Cairo_400Regular' }]}
                textAlign="right"
                testID="new-playlist-input"
              />
              <Pressable
                onPress={async () => {
                  const trimmed = newPlaylistName.trim();
                  if (!trimmed) return;
                  const playlist = await createPlaylist(trimmed);
                  await addPoemToPlaylist(playlist.id, poem.id);
                  setNewPlaylistName('');
                }}
                hitSlop={10}
                testID="new-playlist-confirm"
              >
                <Feather name="plus" size={18} color={colors.primary} />
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBar: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  topBarActions: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 20,
  },
  boundaryButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
  },
  boundaryButtonText: {
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalCard: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 20,
    paddingHorizontal: 24,
    maxHeight: '75%',
    gap: 16,
  },
  infoModalCard: {
    maxHeight: '88%',
    minHeight: '55%',
  },
  infoScroll: {
    flexShrink: 1,
  },
  infoScrollContent: {
    gap: 12,
    paddingBottom: 8,
  },
  infoVerseText: {
    fontFamily: 'Amiri_400Regular',
    fontSize: 21,
    lineHeight: 38,
    textAlign: 'center',
    paddingVertical: 8,
  },
  infoSectionTitle: {
    fontSize: 16,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
    marginTop: 6,
  },
  infoNotice: {
    fontSize: 14,
    fontFamily: 'Cairo_400Regular',
    lineHeight: 24,
    textAlign: 'right',
  },
  infoStateRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
  },
  infoRetryButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginTop: 8,
  },
  infoItem: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  infoItemSource: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  infoItemText: {
    fontSize: 15,
    fontFamily: 'Cairo_400Regular',
    lineHeight: 26,
    textAlign: 'right',
  },
  infoAttribution: {
    fontSize: 12,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
  },
  infoWords: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: 8,
  },
  infoWordChip: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  infoWordText: {
    fontSize: 14,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  modalHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  modalList: {
    maxHeight: 300,
  },
  modalEmpty: {
    fontSize: 15,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'center',
    paddingVertical: 24,
  },
  modalRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalRowText: {
    fontSize: 16,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
  },
  exportOption: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
  },
  exportOptionDisabled: {
    opacity: 0.55,
  },
  exportOptionText: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  createRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    height: 52,
    marginBottom: 20,
  },
  createInput: {
    flex: 1,
    fontSize: 15,
  },
  focusContainer: {
    flex: 1,
  },
  focusTopBar: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  focusFontControls: {
    flexDirection: 'row-reverse',
    gap: 20,
  },
  focusScrollContent: {
    paddingHorizontal: 24,
    paddingTop: 24,
    alignItems: 'center',
  },
  focusPoemTitle: {
    fontSize: 26,
    fontFamily: 'Amiri_700Bold',
    marginBottom: 32,
    textAlign: 'center',
  },
  focusVerseRow: {
    paddingVertical: 18,
    width: '100%',
    alignItems: 'center',
  },
  focusVerseText: {
    textAlign: 'center',
  },
  focusVerseDivider: {
    paddingVertical: 8,
  },
  focusPlayButton: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
  },
  headerText: {
    paddingHorizontal: 24,
    paddingBottom: 20,
    gap: 4,
  },
  coverImage: {
    width: '100%',
    height: 240,
    borderRadius: 8,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontFamily: 'Amiri_700Bold',
    textAlign: 'right',
    lineHeight: 40,
  },
  poet: {
    fontSize: 16,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  readerRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-end',
    marginTop: 9,
    marginBottom: 5,
  },
  readerCopy: { alignItems: 'flex-end', minWidth: 0 },
  readerEyebrow: { fontFamily: 'Cairo_400Regular', fontSize: 10, textAlign: 'right' },
  readerName: { fontFamily: 'Cairo_600SemiBold', fontSize: 12, textAlign: 'right' },
  downloadAudio: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 9,
    minHeight: 42,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 9,
    marginTop: 6,
  },
  downloadAudioText: { fontFamily: 'Cairo_700Bold', fontSize: 12, textAlign: 'right' },
  versesScroll: {
    flex: 1,
    paddingHorizontal: 20,
  },
  verseCard: {
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  verseMetaRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  verseMetaBadges: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
  },
  verseNumberBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  verseNumberText: {
    fontSize: 12,
    fontFamily: 'Cairo_700Bold',
  },
  verseTimeBadge: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  verseTimeText: {
    fontSize: 11,
    fontFamily: 'Cairo_600SemiBold',
  },
  verseHemistichBlock: {
    alignItems: 'center',
    marginTop: 16,
    gap: 4,
  },
  verseDivider: {
    paddingVertical: 8,
  },
  verseText: {
    fontFamily: 'Amiri_400Regular',
    textAlign: 'center',
  },
  verseActionsRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'flex-start',
    gap: 20,
  },
  verseEditRow: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    gap: 12,
  },
  verseEditInput: {
    textAlignVertical: 'top',
    minHeight: 80,
  },
  verseEditActions: {
    flexDirection: 'row-reverse',
    justifyContent: 'flex-start',
    gap: 24,
  },
  verseEditAction: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
  },
  playerBar: {
    paddingHorizontal: 24,
    paddingTop: 8,
    borderTopWidth: 1,
    gap: 12,
  },
  playerCollapseButton: {
    alignSelf: 'center',
    paddingHorizontal: 24,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactPlayer: {
    minHeight: 56,
    paddingTop: 8,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  compactPlayerExpand: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
  },
  compactPlayerText: {
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
  },
  compactPlayerTime: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
  },
  timeRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
  },
  timeText: {
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
  },
  verseNavigationRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  verseNavigationButton: {
    minWidth: 74,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  verseNavigationText: {
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
  },
  verseNavigationHint: {
    fontSize: 10,
    fontFamily: 'Cairo_400Regular',
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
});
