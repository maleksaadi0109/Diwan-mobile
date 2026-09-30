import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import * as DocumentPicker from 'expo-document-picker';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { useDownloadYoutubeAudio } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import {
  alignPoemInBackground,
  downloadYoutubeCover,
  extractErrorMessage,
  makeLocalId,
  needsCookieUnlock,
  pollAlignmentJob,
  toPlayableAudioUrl,
  uploadAudioFile,
  type UploadedAudioJob,
} from '@/lib/api';
import { cacheRecordingAudio } from '@/lib/offlineAudio';
import { CATALOG_RECITERS, getBundledReadyPoem } from '@/lib/readyCatalog';
import type { Poem, Recording, Verse } from '@/lib/types';
import {
  clearPendingAlignmentImport,
  readPendingAlignmentImport,
  savePendingAlignmentImport,
  type PendingAlignmentImport,
} from '@/lib/pendingImport';
import {
  CatalogPoemEntry,
  POEM_CATALOG,
  extractMizanPoemId,
  fetchMizanPoem,
  parseMizanPoem,
  type ParsedMizanPoem,
} from '@/lib/mizan';

type CatalogItemStatus = 'idle' | 'text' | 'downloading' | 'aligning' | 'caching' | 'error';
type MizanAudioMode = 'none' | 'youtube' | 'upload' | 'record';

interface PickedAudioFile {
  uri: string;
  name: string;
  mimeType: string;
  sizeLabel?: string;
}

const AUDIO_MODE_OPTIONS: {
  key: MizanAudioMode;
  label: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { key: 'none', label: 'نص فقط', icon: 'file-text' },
  { key: 'youtube', label: 'رابط يوتيوب', icon: 'youtube' },
  { key: 'upload', label: 'رفع ملف', icon: 'upload' },
  { key: 'record', label: 'تسجيل صوتي', icon: 'mic' },
];

function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function ImportScreen() {
  const colors = useColors();
  const router = useRouter();
  const { catalogId, requestId } = useLocalSearchParams<{
    catalogId?: string;
    requestId?: string;
  }>();
  const lastCatalogRequest = useRef<string | null>(null);
  const insets = useSafeAreaInsets();
  const { addPoem, updatePoem, poems, isLoading: libraryLoading } = useLibrary();

  const [error, setError] = useState<string | null>(null);

  const [needsCookies, setNeedsCookies] = useState(false);
  const [cookiesText, setCookiesText] = useState('');
  const [showCookieHelp, setShowCookieHelp] = useState(false);

  const [activeCatalogId, setActiveCatalogId] = useState<string | null>(null);
  const [retryCatalogId, setRetryCatalogId] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<Record<string, CatalogItemStatus>>({});

  const [mizanUrl, setMizanUrl] = useState('');
  const [mizanLoading, setMizanLoading] = useState(false);
  const [mizanError, setMizanError] = useState<string | null>(null);
  const [mizanPreview, setMizanPreview] = useState<{
    poemId: string;
    parsed: ParsedMizanPoem;
  } | null>(null);
  const [mizanSaving, setMizanSaving] = useState(false);
  const [mizanImportStage, setMizanImportStage] = useState<
    'idle' | 'downloading' | 'aligning' | 'caching'
  >('idle');
  const [alignProgress, setAlignProgress] = useState<number | null>(null);

  const [mizanAudioMode, setMizanAudioMode] = useState<MizanAudioMode>('none');
  const [mizanYoutubeUrl, setMizanYoutubeUrl] = useState('');
  const [mizanUploadedFile, setMizanUploadedFile] = useState<PickedAudioFile | null>(null);
  const [mizanRecordedUri, setMizanRecordedUri] = useState<string | null>(null);
  const [mizanRecordedDurationMs, setMizanRecordedDurationMs] = useState(0);
  const [pendingImport, setPendingImport] = useState<PendingAlignmentImport | null>(null);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);


  const downloadMutation = useDownloadYoutubeAudio({
    request: { headers: { 'X-Diwan-Temporary-Audio': '1' } },
  });

  useEffect(() => {
    let mounted = true;
    readPendingAlignmentImport()
      .then((draft) => {
        if (mounted) setPendingImport(draft);
      })
      .catch((err) => {
        if (mounted) {
          setPendingError(extractErrorMessage(err, 'تعذر قراءة عملية الاستيراد المحفوظة'));
        }
      })
      .finally(() => {
        if (mounted) setPendingLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const finishPendingImport = async (
    originalDraft: PendingAlignmentImport,
    alignment: NonNullable<PendingAlignmentImport['alignment']>,
  ) => {
    const draft = { ...originalDraft, alignment };
    await savePendingAlignmentImport(draft);
    setPendingImport(draft);

    const existing = poems.find(
      (poem) =>
        poem.externalProvider === draft.poem.externalProvider &&
        poem.externalId === draft.poem.externalId,
    );
    if (existing && (existing.recording || existing.recordings?.length)) {
      await clearPendingAlignmentImport();
      setPendingImport(null);
      setPendingError(null);
      router.push({ pathname: '/poem/[id]', params: { id: existing.id } });
      return;
    }

    const alignedById = new Map(alignment.alignments.map((item) => [item.verse_id, item]));
    const verses = draft.poem.verses.map((verse) => {
      const item = alignedById.get(verse.id);
      return item
        ? {
            ...verse,
            alignment: {
              startMs: item.start_ms,
              endMs: item.end_ms,
              confidence: item.confidence,
            },
          }
        : verse;
    });
    let recording: Recording;
    try {
      recording = await cacheRecordingAudio({
        id: draft.recording.id,
        audioUrl: toPlayableAudioUrl(draft.recording.playbackAudioPath),
        durationMs: draft.recording.durationMs,
        reciter: draft.recording.reciter,
      });
    } catch {
      // Keep the aligned draft. Do not save a native poem that depends on
      // temporary server audio if the phone download fails.
      throw new Error('تعذر حفظ الصوت على الهاتف. لم تُحفظ القصيدة بعد؛ تحقق من المساحة والاتصال ثم اضغط استئناف.');
    }
    if (existing) {
      const draftVerses = new Map(draft.poem.verses.map((verse) => [verse.id, verse]));
      let poemStillExists = false;
      await updatePoem(existing.id, (current) => {
        poemStillExists = true;
        if (current.recording || current.recordings?.length) return current;
        return {
          ...current,
          coverImageUrl: current.coverImageUrl ?? draft.poem.coverImageUrl,
          recording,
          verses: current.verses.map((verse) => {
            const source = draftVerses.get(verse.id);
            const aligned = alignedById.get(verse.id);
            return source?.text === verse.text && aligned
              ? {
                  ...verse,
                  alignment: {
                    startMs: aligned.start_ms,
                    endMs: aligned.end_ms,
                    confidence: aligned.confidence,
                  },
                }
              : verse;
          }),
        };
      });
      if (!poemStillExists) {
        throw new Error('حُذفت القصيدة أثناء تنزيل الصوت. احتُفظ بعملية الاستيراد؛ استعد القصيدة قبل المتابعة.');
      }
      await clearPendingAlignmentImport();
      setPendingImport(null);
      setPendingError(null);
      router.push({ pathname: '/poem/[id]', params: { id: existing.id } });
      return;
    }
    const poem: Poem = {
      ...draft.poem,
      verses,
      recording,
    };
    await addPoem(poem);
    await clearPendingAlignmentImport();
    setPendingImport(null);
    setPendingError(null);
    router.push({ pathname: '/poem/[id]', params: { id: poem.id } });
  };

  const resumePendingImport = async () => {
    if (!pendingImport || pendingBusy) return;
    setPendingBusy(true);
    setPendingError(null);
    setMizanImportStage(pendingImport.alignment ? 'caching' : 'aligning');
    try {
      if (pendingImport.alignment) {
        await finishPendingImport(pendingImport, pendingImport.alignment);
      } else {
        const alignment = await pollAlignmentJob(pendingImport.jobId, (progress) =>
          setAlignProgress(typeof progress === 'number' ? progress : null),
        );
        await finishPendingImport(pendingImport, alignment);
      }
    } catch (err) {
      setPendingError(
        extractErrorMessage(err, 'تعذر استئناف المزامنة. إذا أعيد تشغيل الخادم، احذف المسودة وابدأ الاستيراد من جديد.'),
      );
    } finally {
      setPendingBusy(false);
      setMizanImportStage('idle');
      setAlignProgress(null);
    }
  };

  const discardPendingImport = async () => {
    try {
      await clearPendingAlignmentImport();
      setPendingImport(null);
      setPendingError(null);
    } catch (err) {
      setPendingError(extractErrorMessage(err, 'تعذر حذف مسودة الاستيراد'));
    }
  };

  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const tabBarHeight = Platform.OS === 'web' ? 84 : 64 + insets.bottom;

  const resetMizanAudioState = () => {
    setMizanAudioMode('none');
    setMizanYoutubeUrl('');
    setMizanUploadedFile(null);
    setMizanRecordedUri(null);
    setMizanRecordedDurationMs(0);
  };

  const resetMizanForm = () => {
    setMizanUrl('');
    setMizanPreview(null);
    resetMizanAudioState();
  };

  const handleMizanFetch = async () => {
    const trimmed = mizanUrl.trim();
    if (!trimmed) return;
    setMizanError(null);
    setMizanPreview(null);
    setMizanLoading(true);
    try {
      const poemId = extractMizanPoemId(trimmed);
      const existing = poems.find(
        (p) => p.externalProvider === 'mizan_al_arab' && p.externalId === poemId,
      );
      if (existing) {
        router.push({ pathname: '/poem/[id]', params: { id: existing.id } });
        return;
      }
      const data = await fetchMizanPoem(poemId);
      const parsed = parseMizanPoem(data);
      setMizanPreview({ poemId, parsed });
    } catch (err) {
      setMizanError(extractErrorMessage(err, 'تعذر جلب القصيدة من ميزان العرب'));
    } finally {
      setMizanLoading(false);
    }
  };

  const handlePickAudioFile = async () => {
    setMizanError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setMizanUploadedFile({
        uri: asset.uri,
        name: asset.name || 'recitation.mp3',
        mimeType: asset.mimeType || 'audio/mpeg',
        sizeLabel:
          typeof asset.size === 'number' ? `${(asset.size / (1024 * 1024)).toFixed(1)} م.ب` : undefined,
      });
    } catch {
      setMizanError('تعذر اختيار الملف الصوتي');
    }
  };

  const handleStartRecording = async () => {
    setMizanError(null);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setMizanError('يجب السماح باستخدام الميكروفون لتسجيل التلاوة');
        return;
      }
      setMizanRecordedUri(null);
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setMizanError('تعذر بدء التسجيل، حاول مرة أخرى');
    }
  };

  const handleStopRecording = async () => {
    try {
      const durationMs = recorderState.durationMillis;
      await recorder.stop();
      if (recorder.uri) {
        setMizanRecordedUri(recorder.uri);
        setMizanRecordedDurationMs(Math.round(durationMs));
      }
    } catch {
      setMizanError('تعذر إيقاف التسجيل');
    }
  };

  const handleDiscardRecording = () => {
    setMizanRecordedUri(null);
    setMizanRecordedDurationMs(0);
  };

  const handleMizanImport = async () => {
    if (!mizanPreview) return;
    setMizanSaving(true);
    setMizanError(null);
    const { poemId, parsed } = mizanPreview;
    const verses: Verse[] = parsed.verses.map((v, index) => ({
      id: makeLocalId('verse'),
      orderIndex: index,
      text: v.text,
      externalId: v.externalId,
    }));

    // Text-only path: no audio source chosen, save immediately.
    if (mizanAudioMode === 'none') {
      try {
        const poem: Poem = {
          id: makeLocalId('poem'),
          title: parsed.title,
          poetName: parsed.poetName,
          era: parsed.era,
          meter: parsed.meter,
          verses,
          createdAt: Date.now(),
          sourceUrl: mizanUrl.trim(),
          externalProvider: 'mizan_al_arab',
          externalId: poemId,
        };
        await addPoem(poem);
        const importedId = poem.id;
        resetMizanForm();
        router.push({ pathname: '/poem/[id]', params: { id: importedId } });
      } catch (err) {
        setMizanError(extractErrorMessage(err, 'تعذر حفظ القصيدة، حاول مرة أخرى'));
      } finally {
        setMizanSaving(false);
      }
      return;
    }

    // Audio path: obtain a processed audio job (from YouTube, an uploaded
    // file, or a fresh recording), then align it against the Mizan text
    // exactly like the fixed catalog entries.
    let persistedDraft: PendingAlignmentImport | null = null;
    try {
      let job: UploadedAudioJob;
      let coverImageUrl: string | null = null;

      if (mizanAudioMode === 'youtube') {
        const trimmedYoutubeUrl = mizanYoutubeUrl.trim();
        if (!trimmedYoutubeUrl) {
          setMizanError('يرجى إدخال رابط يوتيوب');
          setMizanSaving(false);
          return;
        }
        setMizanImportStage('downloading');
        job = await downloadMutation.mutateAsync({
          data: {
            url: trimmedYoutubeUrl,
            cookies_content: needsCookies ? cookiesText.trim() : undefined,
          },
        });
        coverImageUrl = await downloadYoutubeCover(
          trimmedYoutubeUrl,
          needsCookies ? cookiesText : undefined,
        );
      } else if (mizanAudioMode === 'upload') {
        if (!mizanUploadedFile) {
          setMizanError('يرجى اختيار ملف صوتي');
          setMizanSaving(false);
          return;
        }
        setMizanImportStage('downloading');
        job = await uploadAudioFile({
          uri: mizanUploadedFile.uri,
          fileName: mizanUploadedFile.name,
          mimeType: mizanUploadedFile.mimeType,
        });
      } else {
        if (!mizanRecordedUri) {
          setMizanError('يرجى تسجيل مقطع صوتي أولاً');
          setMizanSaving(false);
          return;
        }
        setMizanImportStage('downloading');
        job = await uploadAudioFile({
          uri: mizanRecordedUri,
          fileName: 'recitation.m4a',
          mimeType: 'audio/m4a',
        });
      }

      const draftBase: Omit<PendingAlignmentImport, 'jobId' | 'alignment'> = {
        poem: {
          id: makeLocalId('poem'),
          title: parsed.title,
          poetName: parsed.poetName,
          era: parsed.era,
          meter: parsed.meter,
          verses,
          createdAt: Date.now(),
          sourceUrl: mizanUrl.trim(),
          externalProvider: 'mizan_al_arab',
          externalId: poemId,
          coverImageUrl:
            coverImageUrl && !coverImageUrl.startsWith('data:') ? coverImageUrl : undefined,
        },
        recording: {
          id: makeLocalId('rec'),
          playbackAudioPath: job.playback_audio_path,
          durationMs: job.duration_ms ?? mizanRecordedDurationMs ?? 0,
        },
      };

      setMizanImportStage('aligning');
      setAlignProgress(null);
      const alignment = await alignPoemInBackground(
        {
          audio_path: job.processing_audio_path,
          verses: verses.map((v) => ({ id: v.id, text: v.text })),
          poem_id: draftBase.poem.id,
          recording_id: draftBase.recording.id,
        },
        (progress) => setAlignProgress(typeof progress === 'number' ? progress : null),
        async (jobId) => {
          const draft: PendingAlignmentImport = { ...draftBase, jobId };
          await savePendingAlignmentImport(draft);
          persistedDraft = draft;
          setPendingImport(draft);
          setPendingError(null);
        },
      );

      setMizanImportStage('caching');
      if (!persistedDraft) {
        throw new Error('تعذر العثور على مسودة عملية المزامنة؛ أعد الاستيراد.');
      }
      await finishPendingImport(persistedDraft, alignment);
      resetMizanForm();
    } catch (err) {
      if (needsCookieUnlock(err)) {
        setNeedsCookies(true);
      }
      setMizanError(
        persistedDraft
          ? extractErrorMessage(err, 'توقفت العملية؛ يمكنك استئنافها من البطاقة أدناه.')
          : `تعذر بدء متابعة المزامنة. أعد الاستيراد يدويًا، مع العلم أن أي مهمة خادم أُنشئت دون حفظ مسودتها على الجهاز لا يمكن استعادتها. ${extractErrorMessage(err, 'تحقق من الاتصال وحاول مرة أخرى')}`,
      );
      if (persistedDraft) {
        setPendingError('توقفت العملية مؤقتًا. يمكنك استئنافها أدناه دون إعادة رفع الصوت.');
      }
    } finally {
      setMizanImportStage('idle');
      setAlignProgress(null);
      setMizanSaving(false);
    }
  };

  const handleCatalogImport = async (entry: CatalogPoemEntry) => {
    const existing = poems.find(
      (p) => p.externalProvider === 'mizan_al_arab' && p.externalId === entry.mizanPoemId,
    );
    if (existing && (existing.recording || existing.recordings?.length)) {
      router.push({ pathname: '/poem/[id]', params: { id: existing.id } });
      return;
    }

    setError(null);
    setRetryCatalogId(null);
    setActiveCatalogId(entry.id);
    setCatalogStatus((s) => ({ ...s, [entry.id]: 'text' }));
    let persistedDraft: PendingAlignmentImport | null = null;
    try {
      const bundled = existing ? null : getBundledReadyPoem(entry);
      const parsed = existing
        ? {
            title: existing.title,
            poetName: existing.poetName,
            era: existing.era,
            meter: existing.meter,
            verses: existing.verses.map((verse) => ({
              orderIndex: verse.orderIndex,
              text: verse.text,
              externalId: verse.externalId,
            })),
          }
        : bundled ?? parseMizanPoem(await fetchMizanPoem(entry.mizanPoemId));

      setCatalogStatus((s) => ({ ...s, [entry.id]: 'downloading' }));
      const download = await downloadMutation.mutateAsync({
        data: {
          url: entry.youtubeUrl,
          cookies_content: needsCookies ? cookiesText.trim() : undefined,
        },
      });
      const coverImageUrl = await downloadYoutubeCover(
        entry.youtubeUrl,
        needsCookies ? cookiesText : undefined,
      );

      const verses: Verse[] = existing
        ? existing.verses
        : parsed.verses.map((v, index) => ({
            id: makeLocalId('verse'),
            orderIndex: index,
            text: v.text,
            externalId: v.externalId,
          }));

      const draftBase: Omit<PendingAlignmentImport, 'jobId' | 'alignment'> = {
        poem: {
          id: existing?.id ?? makeLocalId('poem'),
          title: parsed.title,
          poetName: parsed.poetName !== 'شاعر غير معروف' ? parsed.poetName : entry.poetHint,
          era: parsed.era,
          meter: parsed.meter,
          verses,
          createdAt: Date.now(),
          sourceUrl: entry.mizanUrl,
          externalProvider: 'mizan_al_arab',
          externalId: entry.mizanPoemId,
          coverImageUrl:
            coverImageUrl && !coverImageUrl.startsWith('data:') ? coverImageUrl : undefined,
        },
        recording: {
          id: makeLocalId('rec'),
          playbackAudioPath: download.playback_audio_path,
          durationMs: download.duration_ms ?? 0,
          reciter: CATALOG_RECITERS[entry.reciterId]?.name,
        },
      };

      setCatalogStatus((s) => ({ ...s, [entry.id]: 'aligning' }));
      setAlignProgress(null);
      const alignment = await alignPoemInBackground(
        {
          audio_path: download.processing_audio_path,
          verses: verses.map((v) => ({ id: v.id, text: v.text })),
          poem_id: draftBase.poem.id,
          recording_id: draftBase.recording.id,
        },
        (progress) => setAlignProgress(typeof progress === 'number' ? progress : null),
        async (jobId) => {
          const draft: PendingAlignmentImport = { ...draftBase, jobId };
          await savePendingAlignmentImport(draft);
          persistedDraft = draft;
          setPendingImport(draft);
          setPendingError(null);
        },
      );

      setCatalogStatus((s) => ({ ...s, [entry.id]: 'caching' }));
      if (!persistedDraft) {
        throw new Error('تعذر العثور على مسودة عملية المزامنة؛ أعد الاستيراد.');
      }
      await finishPendingImport(persistedDraft, alignment);
      setCatalogStatus((s) => ({ ...s, [entry.id]: 'idle' }));
      setActiveCatalogId(null);
    } catch (err) {
      if (needsCookieUnlock(err)) {
        setNeedsCookies(true);
        setRetryCatalogId(entry.id);
      }
      setCatalogStatus((s) => ({ ...s, [entry.id]: 'error' }));
      setActiveCatalogId(null);
      setError(
        persistedDraft
          ? extractErrorMessage(err, 'توقفت العملية؛ يمكنك استئنافها من البطاقة أدناه.')
          : extractErrorMessage(err, 'تعذر استيراد القصيدة من ميزان العرب'),
      );
      if (persistedDraft) {
        setPendingError('توقفت العملية مؤقتًا. يمكنك استئنافها أدناه دون إعادة تنزيل الصوت.');
      }
    }
  };

  // The ready-made library owns browsing. This screen owns the existing
  // download/alignment pipeline, so a catalog card routes here with its ID.
  useEffect(() => {
    if (pendingLoading || libraryLoading || typeof catalogId !== 'string') return;
    const key = typeof requestId === 'string' ? `${catalogId}:${requestId}` : catalogId;
    if (lastCatalogRequest.current === key) return;
    lastCatalogRequest.current = key;
    if (pendingImport || activeCatalogId || mizanSaving) {
      setError('توجد عملية استيراد جارية. أكملها أو احذفها قبل تنزيل قصيدة أخرى.');
      return;
    }
    const entry = POEM_CATALOG.find((item) => item.id === catalogId);
    if (!entry) {
      setError('القصيدة المطلوبة غير موجودة في المكتبة الجاهزة.');
      return;
    }
    void handleCatalogImport(entry);
  }, [catalogId, requestId, pendingLoading, libraryLoading, pendingImport]);

  const activeCatalog = POEM_CATALOG.find((entry) => entry.id === activeCatalogId);
  const activeCatalogStatus = activeCatalogId ? catalogStatus[activeCatalogId] : null;
  const activeCatalogLabel =
    activeCatalogStatus === 'text'
      ? 'جارٍ جلب النص...'
      : activeCatalogStatus === 'downloading'
        ? 'جارٍ تنزيل الصوت...'
        : activeCatalogStatus === 'aligning'
          ? alignProgress === null
            ? 'جارٍ مزامنة الأبيات...'
            : `جارٍ مزامنة الأبيات ${Math.round(alignProgress * 100)}٪`
          : activeCatalogStatus === 'caching'
            ? 'جارٍ حفظ الصوت للجهاز...'
            : null;

  const confirmLabel = mizanSaving
    ? mizanImportStage === 'downloading'
      ? mizanAudioMode === 'youtube'
        ? 'جارٍ تنزيل الصوت...'
        : 'جارٍ معالجة الصوت...'
      : mizanImportStage === 'aligning'
        ? alignProgress === null
          ? 'جارٍ مزامنة الأبيات...'
          : `جارٍ مزامنة الأبيات ${Math.round(alignProgress * 100)}٪`
        : mizanImportStage === 'caching'
          ? 'جارٍ حفظ الصوت للجهاز...'
        : 'جارٍ الحفظ...'
    : mizanAudioMode === 'none'
      ? 'استيراد النص فقط'
      : 'استيراد مع الصوت';

  const confirmDisabled =
    mizanSaving ||
    pendingLoading ||
    pendingImport !== null ||
    libraryLoading ||
    (mizanAudioMode === 'youtube' && !mizanYoutubeUrl.trim()) ||
    (mizanAudioMode === 'upload' && !mizanUploadedFile) ||
    (mizanAudioMode === 'record' && !mizanRecordedUri);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: topInset + 20, paddingBottom: tabBarHeight + 60 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>
          استيراد قصيدة
        </Text>
        {error ? (
          <View style={styles.errorBox}>
            <Feather name="alert-circle" size={16} color={colors.destructive} />
            <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          </View>
        ) : null}
        {activeCatalog ? (
          <View style={[styles.pendingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.pendingTitle, { color: colors.foreground }]}>
                {activeCatalog.titleHint}
              </Text>
              <Text style={[styles.pendingDescription, { color: colors.mutedForeground }]}>
                {activeCatalogLabel ?? 'جارٍ تجهيز القصيدة...'}
              </Text>
            </View>
          </View>
        ) : null}

        {pendingLoading ? (
          <View style={[styles.pendingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.pendingTitle, { color: colors.foreground }]}>
              جارٍ التحقق من عملية استيراد محفوظة...
            </Text>
          </View>
        ) : pendingImport || pendingError ? (
          <View style={[styles.pendingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.pendingTitle, { color: colors.foreground }]}>
              {pendingImport ? `استيراد معلّق: ${pendingImport.poem.title}` : 'تعذر استعادة عملية الاستيراد'}
            </Text>
            <Text style={[styles.pendingDescription, { color: colors.mutedForeground }]}>
              {pendingImport
                ? pendingImport.alignment
                  ? 'اكتملت المزامنة. استأنف حفظ الصوت والقصيدة.'
                  : 'يمكن متابعة المزامنة ما دام الخادم يحتفظ بالعملية مؤقتًا. بعد إعادة تشغيله قد تحتاج إلى إعادة الاستيراد.'
                : 'تحقق من الرسالة أدناه. يمكنك المتابعة باستيراد جديد.'}
            </Text>
            {pendingError ? (
              <Text style={[styles.pendingError, { color: colors.destructive }]}>{pendingError}</Text>
            ) : null}
            {pendingImport ? (
              <View style={styles.pendingActions}>
                <Pressable
                  onPress={resumePendingImport}
                  disabled={pendingBusy || mizanSaving || libraryLoading}
                  testID="pending-import-resume"
                  style={({ pressed }) => [
                    styles.pendingButton,
                    { backgroundColor: colors.primary, opacity: pendingBusy || mizanSaving || libraryLoading ? 0.5 : pressed ? 0.8 : 1 },
                  ]}
                >
                  {pendingBusy ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Feather name="play" size={15} color={colors.primaryForeground} />
                  )}
                  <Text style={[styles.pendingButtonText, { color: colors.primaryForeground }]}>استئناف</Text>
                </Pressable>
                <Pressable
                  onPress={discardPendingImport}
                  disabled={pendingBusy || mizanSaving}
                  testID="pending-import-discard"
                  style={({ pressed }) => [
                    styles.pendingButton,
                    { borderColor: colors.border, opacity: pendingBusy || mizanSaving ? 0.5 : pressed ? 0.7 : 1 },
                  ]}
                >
                  <Feather name="trash-2" size={15} color={colors.destructive} />
                  <Text style={[styles.pendingButtonText, { color: colors.destructive }]}>حذف / إعادة البدء</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.catalogSection}>
          <Pressable
            onPress={() => router.push('/(tabs)/catalog')}
            accessibilityRole="button"
            testID="open-ready-catalog"
            style={({ pressed }) => [
              styles.catalogItem,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="book-open" size={20} color={colors.primary} />
            <View style={styles.catalogItemText}>
              <Text style={[styles.catalogItemTitle, { color: colors.foreground }]}>
                تصفّح المكتبة الجاهزة
              </Text>
              <Text style={[styles.catalogItemPoet, { color: colors.mutedForeground }]}>
                قصائد جاهزة مرتّبة حسب القارئ
              </Text>
            </View>
            <Feather name="chevron-left" size={18} color={colors.mutedForeground} />
          </Pressable>

          <Text style={[styles.sectionLabel, { color: colors.foreground }]}>
            استيراد من ميزان العرب
          </Text>

          <Text style={[styles.pageHint, { color: colors.mutedForeground }]}>
            الصق رابط أي قصيدة من mizanalarab.com لاستيراد نصها الموثّق، ثم اختر
            كيف تريد إضافة الصوت
          </Text>

          <View
            style={[
              styles.inputRow,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TextInput
              value={mizanUrl}
              onChangeText={(v) => {
                setMizanUrl(v);
                setMizanPreview(null);
                setMizanError(null);
                resetMizanAudioState();
              }}
              placeholder="https://mizanalarab.com/poem/..."
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[styles.textInput, { color: colors.foreground }]}
              editable={!mizanLoading && !mizanSaving}
              testID="mizan-url-input"
            />
            <Pressable
              onPress={handleMizanFetch}
              disabled={mizanLoading || mizanSaving || !mizanUrl.trim()}
              testID="mizan-fetch-button"
              style={({ pressed }) => [
                styles.iconButton,
                {
                  backgroundColor: colors.primary,
                  opacity: !mizanUrl.trim() || mizanLoading ? 0.4 : pressed ? 0.8 : 1,
                },
              ]}
            >
              {mizanLoading ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="arrow-left" size={18} color={colors.primaryForeground} />
              )}
            </Pressable>
          </View>

          {mizanUrl.trim() && !mizanPreview ? (
            <View
              style={[
                styles.sourcePromptCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.sourcePromptTitle, { color: colors.foreground }]}>
                اختر مصدر الصوت
              </Text>
              <Text style={[styles.sourcePromptHint, { color: colors.mutedForeground }]}>
                سيظهر هذا الاختيار مع معاينة القصيدة أيضًا
              </Text>
              <View style={styles.audioModeRow}>
                {AUDIO_MODE_OPTIONS.map((option) => {
                  const selected = mizanAudioMode === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setMizanAudioMode(option.key)}
                      disabled={mizanLoading || mizanSaving}
                      testID={`mizan-audio-mode-before-fetch-${option.key}`}
                      style={({ pressed }) => [
                        styles.audioModeChip,
                        {
                          backgroundColor: selected ? colors.primary : colors.background,
                          borderColor: selected ? colors.primary : colors.border,
                          opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather
                        name={option.icon}
                        size={14}
                        color={selected ? colors.primaryForeground : colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.audioModeChipText,
                          {
                            color: selected
                              ? colors.primaryForeground
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {mizanAudioMode === 'youtube' ? (
                <View
                  style={[
                    styles.inputRow,
                    { backgroundColor: colors.background, borderColor: colors.border },
                  ]}
                >
                  <TextInput
                    value={mizanYoutubeUrl}
                    onChangeText={setMizanYoutubeUrl}
                    placeholder="https://youtube.com/watch?v=..."
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[styles.textInput, { color: colors.foreground }]}
                    editable={!mizanLoading && !mizanSaving}
                    testID="mizan-youtube-url-input-before-fetch"
                  />
                </View>
              ) : null}

              {mizanAudioMode === 'upload' ? (
                <View style={styles.audioSourceBox}>
                  <Pressable
                    onPress={handlePickAudioFile}
                    disabled={mizanLoading || mizanSaving}
                    testID="mizan-upload-pick-button-before-fetch"
                    style={({ pressed }) => [
                      styles.audioSourceButton,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                        opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <Feather name="upload" size={16} color={colors.primary} />
                    <Text style={[styles.audioSourceButtonText, { color: colors.foreground }]}>
                      {mizanUploadedFile ? 'اختيار ملف آخر' : 'اختيار ملف صوتي'}
                    </Text>
                  </Pressable>
                  {mizanUploadedFile ? (
                    <View style={styles.audioSourceInfoRow}>
                      <Feather name="music" size={13} color={colors.mutedForeground} />
                      <Text
                        style={[styles.audioSourceInfoText, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {mizanUploadedFile.name}
                        {mizanUploadedFile.sizeLabel ? ` · ${mizanUploadedFile.sizeLabel}` : ''}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {mizanAudioMode === 'record' ? (
                <View style={styles.audioSourceBox}>
                  {!recorderState.isRecording && !mizanRecordedUri ? (
                    <Pressable
                      onPress={handleStartRecording}
                      disabled={mizanLoading || mizanSaving}
                      testID="mizan-record-start-button-before-fetch"
                      style={({ pressed }) => [
                        styles.audioSourceButton,
                        {
                          borderColor: colors.border,
                          backgroundColor: colors.background,
                          opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather name="mic" size={16} color={colors.primary} />
                      <Text style={[styles.audioSourceButtonText, { color: colors.foreground }]}>
                        بدء التسجيل
                      </Text>
                    </Pressable>
                  ) : null}

                  {recorderState.isRecording ? (
                    <Pressable
                      onPress={handleStopRecording}
                      testID="mizan-record-stop-button-before-fetch"
                      style={({ pressed }) => [
                        styles.audioSourceButton,
                        {
                          borderColor: colors.destructive,
                          backgroundColor: 'rgba(226, 54, 54, 0.1)',
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather name="square" size={16} color={colors.destructive} />
                      <Text style={[styles.audioSourceButtonText, { color: colors.destructive }]}>
                        إيقاف التسجيل ({formatRecordingTime(recorderState.durationMillis)})
                      </Text>
                    </Pressable>
                  ) : null}

                  {mizanRecordedUri && !recorderState.isRecording ? (
                    <View style={styles.audioSourceInfoRow}>
                      <Feather name="mic" size={13} color={colors.mutedForeground} />
                      <Text
                        style={[styles.audioSourceInfoText, { color: colors.mutedForeground }]}
                      >
                        تم تسجيل {formatRecordingTime(mizanRecordedDurationMs)}
                      </Text>
                      <Pressable
                        onPress={handleDiscardRecording}
                        hitSlop={8}
                        disabled={mizanLoading || mizanSaving}
                        testID="mizan-record-discard-button-before-fetch"
                      >
                        <Feather name="trash-2" size={14} color={colors.destructive} />
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          {mizanError ? (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={16} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                {mizanError}
              </Text>
            </View>
          ) : null}

          {needsCookies ? (
            <View style={styles.cookieHelpBox}>
              <View style={styles.cookieHeaderRow}>
                <Text style={styles.cookieTitle}>يرجى إدخال ملفات تعريف الارتباط (Cookies)</Text>
              </View>
              <Text style={styles.cookieHelpText}>
                قام يوتيوب بحظر الطلب مؤقتًا. للوصول، يرجى استخراج ملفات تعريف
                الارتباط من متصفحك (بصيغة Netscape) ولصقها هنا.
              </Text>
              <TextInput
                value={cookiesText}
                onChangeText={setCookiesText}
                placeholder="# Netscape HTTP Cookie File..."
                placeholderTextColor="rgba(253, 251, 247, 0.3)"
                multiline
                style={styles.cookieTextInput}
                autoCapitalize="none"
                autoCorrect={false}
                testID="cookie-input"
              />
              <Pressable
                onPress={() => {
                  setNeedsCookies(false);
                  if (mizanPreview) handleMizanImport();
                   else if (retryCatalogId) {
                     const entry = POEM_CATALOG.find((c) => c.id === retryCatalogId);
                    if (entry) handleCatalogImport(entry);
                  }
                }}
                style={styles.cookieRetryButton}
                testID="cookie-retry-button"
              >
                <Feather name="refresh-cw" size={14} color="#fcd34d" />
                <Text style={styles.cookieRetryText}>إعادة المحاولة</Text>
              </Pressable>
            </View>
          ) : null}

          {mizanPreview ? (
            <View
              style={[
                styles.mizanPreviewCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.catalogItemTitle, { color: colors.foreground }]}>
                {mizanPreview.parsed.title}
              </Text>
              <Text style={[styles.catalogItemPoet, { color: colors.primary }]}>
                {mizanPreview.parsed.poetName}
              </Text>

              <Text style={[styles.mizanAudioLabel, { color: colors.mutedForeground, marginTop: 8 }]}>
                مصدر الصوت:
              </Text>
              <View style={styles.audioModeRow}>
                {AUDIO_MODE_OPTIONS.map((option) => {
                  const selected = mizanAudioMode === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setMizanAudioMode(option.key)}
                      disabled={mizanLoading || mizanSaving}
                      testID={`mizan-audio-mode-after-fetch-${option.key}`}
                      style={({ pressed }) => [
                        styles.audioModeChip,
                        {
                          backgroundColor: selected ? colors.primary : colors.background,
                          borderColor: selected ? colors.primary : colors.border,
                          opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather
                        name={option.icon}
                        size={14}
                        color={selected ? colors.primaryForeground : colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.audioModeChipText,
                          {
                            color: selected
                              ? colors.primaryForeground
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {mizanAudioMode === 'youtube' ? (
                <View
                  style={[
                    styles.inputRow,
                    { backgroundColor: colors.background, borderColor: colors.border },
                  ]}
                >
                  <TextInput
                    value={mizanYoutubeUrl}
                    onChangeText={setMizanYoutubeUrl}
                    placeholder="https://youtube.com/watch?v=..."
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[styles.textInput, { color: colors.foreground }]}
                    editable={!mizanLoading && !mizanSaving}
                    testID="mizan-youtube-url-input-after-fetch"
                  />
                </View>
              ) : null}

              {mizanAudioMode === 'upload' ? (
                <View style={styles.audioSourceBox}>
                  <Pressable
                    onPress={handlePickAudioFile}
                    disabled={mizanLoading || mizanSaving}
                    testID="mizan-upload-pick-button-after-fetch"
                    style={({ pressed }) => [
                      styles.audioSourceButton,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                        opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <Feather name="upload" size={16} color={colors.primary} />
                    <Text style={[styles.audioSourceButtonText, { color: colors.foreground }]}>
                      {mizanUploadedFile ? 'اختيار ملف آخر' : 'اختيار ملف صوتي'}
                    </Text>
                  </Pressable>
                  {mizanUploadedFile ? (
                    <View style={styles.audioSourceInfoRow}>
                      <Feather name="music" size={13} color={colors.mutedForeground} />
                      <Text
                        style={[styles.audioSourceInfoText, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {mizanUploadedFile.name}
                        {mizanUploadedFile.sizeLabel ? ` · ${mizanUploadedFile.sizeLabel}` : ''}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {mizanAudioMode === 'record' ? (
                <View style={styles.audioSourceBox}>
                  {!recorderState.isRecording && !mizanRecordedUri ? (
                    <Pressable
                      onPress={handleStartRecording}
                      disabled={mizanLoading || mizanSaving}
                      testID="mizan-record-start-button-after-fetch"
                      style={({ pressed }) => [
                        styles.audioSourceButton,
                        {
                          borderColor: colors.border,
                          backgroundColor: colors.background,
                          opacity: mizanLoading || mizanSaving ? 0.6 : pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather name="mic" size={16} color={colors.primary} />
                      <Text style={[styles.audioSourceButtonText, { color: colors.foreground }]}>
                        بدء التسجيل
                      </Text>
                    </Pressable>
                  ) : null}

                  {recorderState.isRecording ? (
                    <Pressable
                      onPress={handleStopRecording}
                      testID="mizan-record-stop-button-after-fetch"
                      style={({ pressed }) => [
                        styles.audioSourceButton,
                        {
                          borderColor: colors.destructive,
                          backgroundColor: 'rgba(226, 54, 54, 0.1)',
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Feather name="square" size={16} color={colors.destructive} />
                      <Text style={[styles.audioSourceButtonText, { color: colors.destructive }]}>
                        إيقاف التسجيل ({formatRecordingTime(recorderState.durationMillis)})
                      </Text>
                    </Pressable>
                  ) : null}

                  {mizanRecordedUri && !recorderState.isRecording ? (
                    <View style={styles.audioSourceInfoRow}>
                      <Feather name="mic" size={13} color={colors.mutedForeground} />
                      <Text
                        style={[styles.audioSourceInfoText, { color: colors.mutedForeground }]}
                      >
                        تم تسجيل {formatRecordingTime(mizanRecordedDurationMs)}
                      </Text>
                      <Pressable
                        onPress={handleDiscardRecording}
                        hitSlop={8}
                        disabled={mizanLoading || mizanSaving}
                        testID="mizan-record-discard-button-after-fetch"
                      >
                        <Feather name="trash-2" size={14} color={colors.destructive} />
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}

              <Pressable
                onPress={handleMizanImport}
                disabled={confirmDisabled}
                testID="mizan-import-confirm-button"
                style={({ pressed }) => [
                  styles.submitButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: confirmDisabled ? 0.4 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                {mizanSaving ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Feather name="check" size={18} color={colors.primaryForeground} />
                )}
                <Text style={[styles.submitButtonText, { color: colors.primaryForeground }]}>
                  {confirmLabel}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 24,
    gap: 16,
  },
  pageTitle: {
    fontSize: 34,
    fontFamily: 'Amiri_700Bold',
    textAlign: 'right',
  },
  pageHint: {
    fontSize: 14,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
    lineHeight: 22,
  },
  inputRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 52,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Cairo_400Regular',
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 8,
    paddingVertical: 16,
    marginTop: 12,
  },
  submitButtonText: {
    fontSize: 16,
    fontFamily: 'Cairo_700Bold',
  },
  errorBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(197,78,78,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(197,78,78,0.3)',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  pendingCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  pendingTitle: {
    fontSize: 15,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  pendingDescription: {
    fontSize: 13,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
    lineHeight: 19,
  },
  pendingError: {
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
    lineHeight: 19,
  },
  pendingActions: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  pendingButton: {
    minHeight: 40,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 13,
    borderRadius: 8,
    borderWidth: 1,
  },
  pendingButtonText: {
    fontSize: 13,
    fontFamily: 'Cairo_700Bold',
  },
  cookieHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cookieHelpBox: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(212,175,55,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.3)',
    gap: 12,
  },
  cookieTitle: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
    color: '#fcd34d',
    textAlign: 'right',
  },
  cookieHelpText: {
    fontSize: 13,
    fontFamily: 'Cairo_400Regular',
    color: 'rgba(235, 227, 213, 0.8)',
    textAlign: 'right',
    lineHeight: 18,
  },
  cookieTextInput: {
    height: 80,
    borderRadius: 8,
    padding: 10,
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' }),
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.2)',
    color: 'rgba(160, 170, 183, 0.8)',
    textAlign: 'left',
  },
  cookieRetryButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 8,
    paddingVertical: 12,
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  cookieRetryText: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
    color: '#fcd34d',
  },
  mizanPreviewCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  mizanAudioLabel: {
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  sourcePromptCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  sourcePromptTitle: {
    fontSize: 15,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  sourcePromptHint: {
    fontSize: 13,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
  },
  audioModeRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: 8,
  },
  audioModeChip: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  audioModeChipText: {
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
  },
  audioSourceBox: {
    gap: 12,
  },
  audioSourceButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 14,
  },
  audioSourceButtonText: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
  },
  audioSourceInfoRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
  },
  audioSourceInfoText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
  },
  catalogSection: {
    gap: 12,
  },
  sectionLabel: {
    fontSize: 18,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  sectionHint: {
    fontSize: 14,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
    lineHeight: 20,
  },
  catalogList: {
    gap: 10,
  },
  catalogItem: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  catalogItemText: {
    flex: 1,
    gap: 4,
  },
  catalogItemTitle: {
    fontSize: 15,
    fontFamily: 'Amiri_700Bold',
    textAlign: 'right',
  },
  catalogItemPoet: {
    fontSize: 13,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
  },
  catalogItemStatus: {
    fontSize: 11,
    fontFamily: 'Cairo_600SemiBold',
  },
  dividerRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 13,
    fontFamily: 'Cairo_600SemiBold',
  },
});
