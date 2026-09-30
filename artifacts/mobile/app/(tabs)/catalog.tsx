import React, { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import { useGlobalAudioPlayer } from '@/contexts/AudioPlayerContext';
import { normalizeArabic } from '@/lib/utils';
import { CATALOG_RECITERS, POEM_CATALOG } from '@/lib/readyCatalog';
import type { CatalogPoemEntry, CatalogReciter } from '@/lib/readyCatalog';
import type { Poem } from '@/lib/types';
import { ReciterPortrait } from '@/components/ReciterPortrait';
import { getSampleThumbnailSource } from '@/lib/sampleThumbnails';

const reciterOrder = [
  'osama-alwaaedh',
  'taraneem',
  'omar-alsharafi',
  'khaled-alsharafi',
  'khaled-bin-hassan',
];

export default function CatalogScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { poems, isLoading, sampleAudioStatus, retrySampleAudio, cancelSampleAudio } = useLibrary();
  const { activePoem } = useGlobalAudioPlayer();
  const [query, setQuery] = useState('');
  const [selectedReciter, setSelectedReciter] = useState<string | null>(null);

  const importedByMizanId = useMemo(() => {
    const imported = new Map<string, Poem>();
    poems.forEach((poem) => {
      if (poem.externalProvider === 'mizan_al_arab' && poem.externalId) {
        imported.set(poem.externalId, poem);
      }
    });
    return imported;
  }, [poems]);

  const reciters = useMemo(() => reciterOrder
    .map((id) => CATALOG_RECITERS[id])
    .filter((reciter): reciter is CatalogReciter => Boolean(reciter)), []);

  const groups = useMemo(() => {
    const search = normalizeArabic(query.trim());
    return reciters
      .filter((reciter) => !selectedReciter || reciter.id === selectedReciter)
      .map((reciter) => ({
        reciter,
        entries: POEM_CATALOG.filter((entry) =>
          entry.reciterId === reciter.id &&
          (!search ||
            normalizeArabic(entry.titleHint).includes(search) ||
            normalizeArabic(entry.poetHint).includes(search) ||
            normalizeArabic(reciter.name).includes(search))
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [reciters, query, selectedReciter]);

  const importedCount = POEM_CATALOG.filter((entry) => importedByMizanId.has(entry.mizanPoemId)).length;

  const openEntry = (entry: CatalogPoemEntry, audioAction = false) => {
    const poem = importedByMizanId.get(entry.mizanPoemId);
    if (poem && (!audioAction || poem.recording || poem.recordings?.length)) {
      router.push({ pathname: '/poem/[id]', params: { id: poem.id } });
    } else {
      router.push({
        pathname: '/(tabs)/import',
        params: { catalogId: entry.id, requestId: `${Date.now()}` },
      });
    }
  };

  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomSpace = (Platform.OS === 'web' ? 84 : 64 + insets.bottom) +
    (activePoem?.recording ? 80 : 24);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, { paddingTop: topInset + 18, paddingBottom: bottomSpace }]}
      >
        <View style={styles.content}>
          <View style={styles.kickerRow}>
            <View style={[styles.kickerMark, { backgroundColor: colors.primary }]} />
            <Text style={[styles.kicker, { color: colors.primary }]}>من أصوات الشعر العربي</Text>
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>المكتبة الجاهزة</Text>
          <Text style={[styles.intro, { color: colors.mutedForeground }]}>
            قصائد موثقة بنصوصها وأصواتها. اختر القارئ الذي تحب، وأضف ما يلامسك إلى ديوانك.
          </Text>

          <View style={[styles.overview, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.overviewCopy}>
              <Text style={[styles.overviewEyebrow, { color: colors.primary }]}>مجموعة مختارة</Text>
              <Text style={[styles.overviewHeadline, { color: colors.foreground }]}>
                لكل قصيدة صوتها.
              </Text>
              <Text style={[styles.overviewSub, { color: colors.mutedForeground }]}>
                {POEM_CATALOG.length} قصيدة · {reciters.length} قرّاء · {importedCount} في ديوانك
              </Text>
            </View>
            <View style={[styles.overviewIcon, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
              <Feather name="headphones" size={28} color={colors.primary} />
            </View>
          </View>

          <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="search" size={19} color={colors.mutedForeground} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="ابحث عن قصيدة، شاعر أو قارئ"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground }]}
              textAlign="right"
              returnKeyType="search"
              accessibilityLabel="البحث في المكتبة الجاهزة"
              testID="catalog-search"
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="مسح البحث">
                <Feather name="x" size={17} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>

          <View style={styles.filterHeading}>
            <Text style={[styles.filterTitle, { color: colors.foreground }]}>تصفح حسب القارئ</Text>
            {selectedReciter ? (
              <Pressable onPress={() => setSelectedReciter(null)} hitSlop={8}>
                <Text style={[styles.clearFilter, { color: colors.primary }]}>عرض الكل</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterStrip}
          style={styles.filterScroll}
        >
          <Pressable
            onPress={() => setSelectedReciter(null)}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedReciter === null }}
            style={({ pressed }) => [styles.filterPill, {
              backgroundColor: selectedReciter === null ? colors.primary : colors.card,
              borderColor: selectedReciter === null ? colors.primary : colors.border,
              opacity: pressed ? 0.75 : 1,
            }]}
          >
            <Text style={[styles.filterPillText, { color: selectedReciter === null ? colors.primaryForeground : colors.foreground }]}>
              كل القرّاء
            </Text>
          </Pressable>
          {reciters.map((reciter) => {
            const selected = selectedReciter === reciter.id;
            return (
              <Pressable
                key={reciter.id}
                onPress={() => setSelectedReciter(selected ? null : reciter.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={({ pressed }) => [styles.filterPill, {
                  backgroundColor: selected ? colors.primary : colors.card,
                  borderColor: selected ? colors.primary : colors.border,
                  opacity: pressed ? 0.75 : 1,
                }]}
              >
                <Text style={[styles.filterPillText, { color: selected ? colors.primaryForeground : colors.foreground }]}>
                  {reciter.name}
                </Text>
                <Text style={[styles.filterCount, { color: selected ? colors.primaryForeground : colors.mutedForeground }]}>
                  {POEM_CATALOG.filter((entry) => entry.reciterId === reciter.id).length}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={[styles.content, styles.results]}>
          {isLoading ? (
            <View style={styles.loadingGroup}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[styles.loadingRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={[styles.loadingCircle, { backgroundColor: colors.muted }]} />
                  <View style={styles.loadingLines}>
                    <View style={[styles.loadingLine, { backgroundColor: colors.muted, width: '62%' }]} />
                    <View style={[styles.loadingLine, { backgroundColor: colors.muted, width: '38%' }]} />
                  </View>
                </View>
              ))}
            </View>
          ) : groups.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="search" size={27} color={colors.primary} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>لم نجد قصيدة بهذا الوصف</Text>
              <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
                جرّب اسم شاعر آخر أو ارجع إلى جميع القرّاء.
              </Text>
              <Pressable
                onPress={() => { setQuery(''); setSelectedReciter(null); }}
                style={[styles.resetButton, { backgroundColor: colors.secondary }]}
              >
                <Text style={[styles.resetText, { color: colors.primary }]}>عرض جميع القصائد</Text>
              </Pressable>
            </View>
          ) : groups.map(({ reciter, entries }, groupIndex) => (
            <View key={reciter.id} style={styles.group}>
              <View style={styles.groupTopline}>
                <Text style={[styles.groupNumber, { color: colors.primary }]}>
                  {String(reciterOrder.indexOf(reciter.id) + 1).padStart(2, '0')}
                </Text>
                <View style={[styles.groupRule, { backgroundColor: colors.border }]} />
                <Text style={[styles.groupCount, { color: colors.mutedForeground }]}>
                  {entries.length} قصيدة
                </Text>
              </View>
              <View style={styles.reciterHeading}>
                <ReciterPortrait reciterId={reciter.id} name={reciter.name} size={56} />
                <View style={styles.reciterCopy}>
                  <Text style={[styles.reciterName, { color: colors.foreground }]}>{reciter.name}</Text>
                  <Text style={[styles.reciterRole, { color: colors.primary }]}>{reciter.role}</Text>
                </View>
              </View>
              <Text style={[styles.description, { color: colors.mutedForeground }]}>{reciter.description}</Text>

              <View style={[styles.poemList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {entries.map((entry, index) => {
                  const savedPoem = importedByMizanId.get(entry.mizanPoemId);
                  const imported = Boolean(savedPoem);
                  const hasAudio = Boolean(savedPoem?.recording || savedPoem?.recordings?.length);
                  const samplePhase = savedPoem?.id === `sample-${entry.id}` && !hasAudio
                    ? sampleAudioStatus[entry.id]?.phase
                    : undefined;
                   const autoBusy = samplePhase === 'downloading' || samplePhase === 'saving' || samplePhase === 'resuming';
                   const canCancel = autoBusy && Platform.OS === 'android';
                   const autoFailed = (samplePhase === 'error' || samplePhase === 'interrupted') && Platform.OS !== 'web';
                  const thumbnail = getSampleThumbnailSource(entry.id);
                  return (
                    <View
                      key={entry.id}
                      style={[
                        styles.poemRow,
                        index !== entries.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border },
                      ]}
                    >
                      <Pressable
                        onPress={() => openEntry(entry)}
                        accessibilityRole="button"
                        accessibilityLabel={`${entry.titleHint}، ${entry.poetHint}، ${imported ? 'افتح القصيدة' : 'أضف إلى ديوانك'}`}
                        style={({ pressed }) => [styles.poemInfo, { opacity: pressed ? 0.65 : 1 }]}
                        testID={`catalog-entry-${entry.id}`}
                      >
                        <ReciterPortrait reciterId={reciter.id} name={reciter.name} size={36} />
                        {thumbnail ? (
                          <Image source={thumbnail} style={[styles.sampleThumbnail, { borderColor: colors.border, backgroundColor: colors.background }]}
                            contentFit="contain" accessibilityLabel={`صورة فيديو ${entry.titleHint}`} />
                        ) : null}
                        <View style={styles.poemText}>
                          <Text style={[styles.poemTitle, { color: colors.foreground }]} numberOfLines={2}>
                            {entry.titleHint}
                          </Text>
                          <Text style={[styles.poetName, { color: colors.mutedForeground }]} numberOfLines={1}>
                            {entry.poetHint}
                          </Text>
                           {autoFailed && sampleAudioStatus[entry.id]?.message ? (
                             <Text style={[styles.poetName, { color: colors.mutedForeground }]}>
                               {sampleAudioStatus[entry.id].message}
                             </Text>
                           ) : null}
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                           if (canCancel) cancelSampleAudio(entry.id);
                           else if (autoFailed) void retrySampleAudio(entry.id);
                          else openEntry(entry, true);
                        }}
                         disabled={autoBusy && !canCancel}
                         accessibilityState={{ disabled: autoBusy && !canCancel }}
                        accessibilityRole="button"
                         accessibilityLabel={canCancel ? `إلغاء تنزيل صوت ${entry.titleHint}` : autoBusy ? `جارٍ تنزيل صوت ${entry.titleHint}` : autoFailed ? `إعادة تنزيل صوت ${entry.titleHint}` : hasAudio ? `افتح ${entry.titleHint}` : imported ? `نزّل صوت ${entry.titleHint}` : `نزّل ${entry.titleHint} إلى ديوانك`}
                        hitSlop={4}
                        style={({ pressed }) => [styles.entryAction, {
                          backgroundColor: hasAudio ? colors.secondary : colors.primary,
                          opacity: pressed ? 0.7 : 1,
                        }]}
                        testID={`catalog-download-${entry.id}`}
                      >
                         <Feather name={hasAudio ? 'check' : canCancel ? 'x' : autoBusy ? 'clock' : autoFailed ? 'rotate-cw' : 'download'} size={16} color={hasAudio ? colors.primary : colors.primaryForeground} />
                        <Text style={[styles.entryActionLabel, { color: hasAudio ? colors.primary : colors.primaryForeground }]}>
                           {hasAudio ? 'في ديوانك' : canCancel ? `إلغاء ${Math.round((sampleAudioStatus[entry.id]?.progress ?? 0) * 100)}٪` : autoBusy ? 'جارٍ التنزيل' : autoFailed ? 'إعادة المحاولة' : imported ? 'تنزيل الصوت' : 'تنزيل'}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
              {groupIndex !== groups.length - 1 ? <View style={styles.groupSpacing} /> : null}
            </View>
          ))}
          {!isLoading && groups.length > 0 ? (
            <Text style={[styles.footerNote, { color: colors.mutedForeground }]}>
              نصوص من ميزان العرب ومجموعة ترنيم، بصحبة أصوات تختارها أنت.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 22 },
  kickerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 4 },
  kickerMark: { width: 17, height: 2, borderRadius: 2 },
  kicker: { fontFamily: 'Cairo_700Bold', fontSize: 11, letterSpacing: 0.2, textAlign: 'right' },
  title: { fontFamily: 'Amiri_700Bold', fontSize: 39, lineHeight: 62, textAlign: 'right' },
  intro: { fontFamily: 'Cairo_400Regular', fontSize: 13, lineHeight: 25, textAlign: 'right', marginTop: -2, marginBottom: 21 },
  overview: { borderWidth: 1, borderRadius: 15, paddingHorizontal: 19, paddingVertical: 17, flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 22 },
  overviewCopy: { flex: 1, alignItems: 'flex-end' },
  overviewEyebrow: { fontFamily: 'Cairo_700Bold', fontSize: 10, textAlign: 'right' },
  overviewHeadline: { fontFamily: 'Amiri_700Bold', fontSize: 24, lineHeight: 36, textAlign: 'right' },
  overviewSub: { fontFamily: 'Cairo_400Regular', fontSize: 11, textAlign: 'right' },
  overviewIcon: { width: 55, height: 55, borderWidth: 1, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  searchBox: { height: 50, borderWidth: 1, borderRadius: 10, flexDirection: 'row-reverse', alignItems: 'center', paddingHorizontal: 15, gap: 10 },
  searchInput: { flex: 1, fontFamily: 'Cairo_400Regular', fontSize: 13, paddingVertical: 0, minWidth: 0 },
  filterHeading: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginTop: 25, marginBottom: 12 },
  filterTitle: { fontFamily: 'Cairo_700Bold', fontSize: 14, textAlign: 'right' },
  clearFilter: { fontFamily: 'Cairo_600SemiBold', fontSize: 12 },
  filterScroll: { flexGrow: 0, width: '100%', maxWidth: 760, alignSelf: 'center' },
  filterStrip: { flexDirection: 'row-reverse', gap: 8, paddingHorizontal: 22, paddingBottom: 4 },
  filterPill: { minHeight: 40, borderRadius: 21, borderWidth: 1, paddingHorizontal: 14, flexDirection: 'row-reverse', alignItems: 'center', gap: 7 },
  filterPillText: { fontFamily: 'Cairo_600SemiBold', fontSize: 12 },
  filterCount: { fontFamily: 'Cairo_600SemiBold', fontSize: 11 },
  results: { paddingTop: 30 },
  group: { width: '100%' },
  groupTopline: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 15 },
  groupNumber: { fontFamily: 'Cairo_700Bold', fontSize: 12 },
  groupRule: { flex: 1, height: 1 },
  groupCount: { fontFamily: 'Cairo_600SemiBold', fontSize: 11 },
  reciterHeading: { flexDirection: 'row-reverse', alignItems: 'center', gap: 13 },
  reciterCopy: { flex: 1, alignItems: 'flex-end' },
  reciterName: { fontFamily: 'Amiri_700Bold', fontSize: 26, lineHeight: 35, textAlign: 'right' },
  reciterRole: { fontFamily: 'Cairo_600SemiBold', fontSize: 11, textAlign: 'right' },
  description: { fontFamily: 'Cairo_400Regular', fontSize: 12, lineHeight: 23, textAlign: 'right', marginTop: 11, marginBottom: 16 },
  poemList: { borderWidth: 1, borderRadius: 13, overflow: 'hidden' },
  poemRow: { flexDirection: 'row-reverse', alignItems: 'center', minHeight: 83, paddingHorizontal: 11, paddingVertical: 11, gap: 8 },
  poemInfo: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row-reverse', alignItems: 'center', gap: 9 },
  sampleThumbnail: { width: 38, height: 38, borderRadius: 6, borderWidth: 1, flexShrink: 0 },
  poemText: { flex: 1, minWidth: 0, alignItems: 'flex-end' },
  poemTitle: { fontFamily: 'Amiri_700Bold', fontSize: 19, lineHeight: 28, textAlign: 'right' },
  poetName: { fontFamily: 'Cairo_400Regular', fontSize: 11, textAlign: 'right', marginTop: 1 },
  entryAction: { minWidth: 78, minHeight: 38, paddingHorizontal: 9, borderRadius: 8, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5 },
  entryActionLabel: { fontFamily: 'Cairo_700Bold', fontSize: 11 },
  groupSpacing: { height: 35 },
  footerNote: { fontFamily: 'Cairo_400Regular', fontSize: 11, textAlign: 'center', marginTop: 28 },
  empty: { borderWidth: 1, borderRadius: 14, paddingVertical: 45, paddingHorizontal: 25, alignItems: 'center', gap: 9 },
  emptyTitle: { fontFamily: 'Amiri_700Bold', fontSize: 24, textAlign: 'center' },
  emptyBody: { fontFamily: 'Cairo_400Regular', fontSize: 12, textAlign: 'center', lineHeight: 22 },
  resetButton: { paddingHorizontal: 17, paddingVertical: 9, borderRadius: 8, marginTop: 10 },
  resetText: { fontFamily: 'Cairo_700Bold', fontSize: 12 },
  loadingGroup: { gap: 12 },
  loadingRow: { borderWidth: 1, borderRadius: 12, minHeight: 85, padding: 16, flexDirection: 'row-reverse', alignItems: 'center', gap: 13 },
  loadingCircle: { width: 43, height: 43, borderRadius: 10 },
  loadingLines: { flex: 1, gap: 10, alignItems: 'flex-end' },
  loadingLine: { height: 9, borderRadius: 5 },
});