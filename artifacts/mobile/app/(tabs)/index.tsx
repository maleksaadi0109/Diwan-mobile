import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import { useGlobalAudioPlayer } from '@/contexts/AudioPlayerContext';
import { PoemCard } from '@/components/PoemCard';
import { SampleAudioNotice } from '@/components/SampleAudioNotice';
import { EmptyState } from '@/components/EmptyState';
import { AddPoemsToPlaylistModal } from '@/components/AddPoemsToPlaylistModal';
import { normalizeArabic } from '@/lib/utils';
import type { Poem } from '@/lib/types';

export default function LibraryScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { poems, isLoading, removePoems } = useLibrary();
  const { activePoem } = useGlobalAudioPlayer();
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [poetFilter, setPoetFilter] = useState<string | null>(null);
  const [eraFilter, setEraFilter] = useState<string | null>(null);
  const [meterFilter, setMeterFilter] = useState<string | null>(null);
  const [audioFilter, setAudioFilter] = useState<'all' | 'with-audio' | 'without-audio'>('all');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPlaylistModalVisible, setBulkPlaylistModalVisible] = useState(false);

  const poets = useMemo(
    () => Array.from(new Set(poems.map((poem) => poem.poetName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ar')),
    [poems],
  );
  const eras = useMemo(
    () => Array.from(new Set(poems.map((poem) => poem.era?.trim()).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, 'ar')),
    [poems],
  );
  const meters = useMemo(
    () => Array.from(new Set(poems.map((poem) => poem.meter?.trim()).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, 'ar')),
    [poems],
  );
  const activeFilterCount = Number(Boolean(poetFilter)) + Number(Boolean(eraFilter)) + Number(Boolean(meterFilter)) + Number(audioFilter !== 'all');

  const filtered = useMemo(() => {
    const q = normalizeArabic(query.trim());
    return poems.filter((p) => {
      if (poetFilter && p.poetName !== poetFilter) return false;
      if (eraFilter && p.era !== eraFilter) return false;
      if (meterFilter && p.meter !== meterFilter) return false;
      if (audioFilter === 'with-audio' && !p.recording) return false;
      if (audioFilter === 'without-audio' && p.recording) return false;
      if (!q) return true;
      if (normalizeArabic(p.title).includes(q)) return true;
      if (normalizeArabic(p.poetName).includes(q)) return true;
      return p.verses.some((v) => normalizeArabic(v.text).includes(q));
    });
  }, [poems, query, poetFilter, eraFilter, meterFilter, audioFilter]);

  const renderFilterOptions = (
    label: string,
    options: string[],
    selected: string | null,
    onSelect: (value: string | null) => void,
  ) => (
    <View style={styles.filterGroup}>
      <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={styles.filterOptions}>
        {[{ label: 'الكل', value: null }, ...options.map((value) => ({ label: value, value }))].map((option) => {
          const selectedOption = selected === option.value;
          return (
            <Pressable
              key={option.value ?? 'all'}
              onPress={() => onSelect(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedOption }}
              style={({ pressed }) => [
                styles.filterChip,
                {
                  backgroundColor: selectedOption ? colors.primary : colors.background,
                  borderColor: selectedOption ? colors.primary : colors.border,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <Text style={[styles.filterChipText, { color: selectedOption ? colors.primaryForeground : colors.foreground }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const tabBarHeight = Platform.OS === 'web' ? 84 : 64 + insets.bottom;
  const miniPlayerVisible = Boolean(activePoem?.recording);
  const miniPlayerHeight = miniPlayerVisible ? 60 : 0;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkDelete = () => {
    const selected = Array.from(selectedIds);
    const deleteSelected = async () => {
      try {
        await removePoems(selected);
        exitSelectMode();
      } catch {
        const message = 'تعذر حذف القصائد. تحقق من مساحة التخزين وحاول مجددًا.';
        if (Platform.OS === 'web') window.alert(message);
        else Alert.alert('خطأ', message);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`هل تريد حذف ${selected.length} قصيدة من مكتبتك؟`)) {
        void deleteSelected();
      }
      return;
    }
    Alert.alert(
      'حذف القصائد',
      `هل تريد حذف ${selected.length} قصيدة من مكتبتك؟`,
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'حذف',
          style: 'destructive',
          onPress: deleteSelected,
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: Poem }) => {
    const isSelected = selectedIds.has(item.id);
    return (
      <View style={styles.selectableRow}>
        {selectMode ? (
          <Feather
            name={isSelected ? 'check-square' : 'square'}
            size={20}
            color={isSelected ? colors.primary : colors.mutedForeground}
            style={styles.selectCheckbox}
          />
        ) : null}
        <View style={{ flex: 1 }}>
          <PoemCard
            poem={item}
            testID={`library-item-${item.id}`}
            onPress={() =>
              selectMode
                ? toggleSelected(item.id)
                : router.push({ pathname: '/poem/[id]', params: { id: item.id } })
            }
            onLongPress={() => {
              if (!selectMode) setSelectMode(true);
              toggleSelected(item.id);
            }}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 12 }]}>
        <View style={styles.headerTopRow}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            ديوان
          </Text>
          {poems.length > 0 && selectMode ? (
            <View style={styles.selectionHeaderActions}>
              <Pressable
                onPress={() => setSelectedIds(new Set(filtered.map((poem) => poem.id)))}
                hitSlop={10}
                testID="library-select-all"
              >
                <Text style={[styles.selectToggleText, { color: colors.primary }]}>
                  تحديد الكل
                </Text>
              </Pressable>
              <Pressable onPress={exitSelectMode} hitSlop={10} testID="library-cancel-selection">
                <Text style={[styles.selectToggleText, { color: colors.mutedForeground }]}>
                  إلغاء
                </Text>
              </Pressable>
            </View>
          ) : poems.length > 0 ? (
            <Pressable
              onPress={() => setSelectMode(true)}
              hitSlop={10}
              testID="library-select-toggle"
            >
              <Text style={[styles.selectToggleText, { color: colors.primary }]}>
                تحديد
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
        </View>
        <Text style={[styles.headerSubtitle, { color: colors.mutedForeground }]}>
          مكتبتك من القصائد
        </Text>
        {!selectMode ? (
          <Pressable
            onPress={() => router.push('/manual-poem')}
            testID="library-manual-poem"
            style={({ pressed }) => [
              styles.manualButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Feather name="plus" size={17} color={colors.primaryForeground} />
            <Text style={[styles.manualButtonText, { color: colors.primaryForeground }]}>
              كتابة قصيدة يدويًا
            </Text>
          </Pressable>
        ) : null}
        {poems.length > 0 && !selectMode ? (
          <>
            <View style={styles.searchAndFilterRow}>
              <View
                style={[
                  styles.searchBar,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Feather name="search" size={16} color={colors.mutedForeground} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="ابحث عن قصيدة أو شاعر"
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    styles.searchInput,
                    { color: colors.foreground, fontFamily: 'Cairo_400Regular' },
                  ]}
                  textAlign="right"
                  testID="library-search-input"
                />
              </View>
              <Pressable
                onPress={() => setFiltersOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityState={{ expanded: filtersOpen }}
                testID="library-filters-toggle"
                style={({ pressed }) => [
                  styles.filterToggle,
                  {
                    backgroundColor: filtersOpen || activeFilterCount > 0 ? colors.primary : colors.card,
                    borderColor: filtersOpen || activeFilterCount > 0 ? colors.primary : colors.border,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Feather name="sliders" size={17} color={filtersOpen || activeFilterCount > 0 ? colors.primaryForeground : colors.foreground} />
                <Text style={[styles.filterToggleText, { color: filtersOpen || activeFilterCount > 0 ? colors.primaryForeground : colors.foreground }]}>
                  تصفية{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
                </Text>
              </Pressable>
            </View>
            {filtersOpen ? (
              <View style={[styles.filtersPanel, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {poets.length > 0 ? renderFilterOptions('الشاعر', poets, poetFilter, setPoetFilter) : null}
                {eras.length > 0 ? renderFilterOptions('العصر', eras, eraFilter, setEraFilter) : null}
                {meters.length > 0 ? renderFilterOptions('البحر', meters, meterFilter, setMeterFilter) : null}
                <View style={styles.filterGroup}>
                  <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>الصوت</Text>
                  <View style={styles.filterOptions}>
                    {([
                      { label: 'الكل', value: 'all' },
                      { label: 'مع صوت', value: 'with-audio' },
                      { label: 'نص فقط', value: 'without-audio' },
                    ] as const).map((option) => {
                      const selected = audioFilter === option.value;
                      return (
                        <Pressable
                          key={option.value}
                          onPress={() => setAudioFilter(option.value)}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          style={({ pressed }) => [
                            styles.filterChip,
                            {
                              backgroundColor: selected ? colors.primary : colors.background,
                              borderColor: selected ? colors.primary : colors.border,
                              opacity: pressed ? 0.75 : 1,
                            },
                          ]}
                        >
                          <Text style={[styles.filterChipText, { color: selected ? colors.primaryForeground : colors.foreground }]}>
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                {activeFilterCount > 0 ? (
                  <Pressable
                    onPress={() => {
                      setPoetFilter(null);
                      setEraFilter(null);
                      setMeterFilter(null);
                      setAudioFilter('all');
                    }}
                    hitSlop={8}
                    style={styles.clearFiltersButton}
                  >
                    <Text style={[styles.clearFiltersText, { color: colors.primary }]}>مسح عوامل التصفية</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </View>

      {!isLoading && poems.length === 0 ? (
        <EmptyState
          icon="book-open"
          title="مكتبتك فارغة"
          subtitle="استورد أول قصيدة من تبويب الاستيراد لتبدأ الاستماع والقراءة"
        />
      ) : (
        <FlatList
          data={filtered}
          ListHeaderComponent={<SampleAudioNotice />}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.list,
            {
              paddingBottom:
                tabBarHeight +
                (selectMode
                  ? miniPlayerHeight + 110
                  : miniPlayerVisible
                    ? miniPlayerHeight + 20
                    : 24),
            },
            filtered.length === 0 && { flex: 1, justifyContent: 'center' }
          ]}
          scrollEnabled={filtered.length > 0}
          ListEmptyComponent={
            <EmptyState
              icon="search"
              title="لا توجد نتائج"
              subtitle="جرّب كلمة بحث أخرى"
            />
          }
        />
      )}

      {selectMode && selectedIds.size > 0 ? (
        <View
          style={[
            styles.bulkBar,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              bottom:
                tabBarHeight +
                (miniPlayerVisible ? miniPlayerHeight + 10 : 20),
            },
          ]}
        >
          <Text style={[styles.bulkCount, { color: colors.foreground }]}>
            {selectedIds.size} محددة
          </Text>
          <View style={styles.bulkActions}>
            <Pressable
              onPress={() => setBulkPlaylistModalVisible(true)}
              hitSlop={10}
              testID="library-bulk-add-to-playlist"
              style={styles.bulkActionButton}
            >
              <Feather name="list" size={20} color={colors.mutedForeground} />
              <Text style={[styles.bulkActionText, { color: colors.mutedForeground }]}>
                إضافة إلى قائمة
              </Text>
            </Pressable>
            <Pressable onPress={handleBulkDelete} hitSlop={10} testID="library-bulk-delete">
              <Feather name="trash-2" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {bulkPlaylistModalVisible ? (
        <AddPoemsToPlaylistModal
          poemIds={Array.from(selectedIds)}
          onClose={() => {
            setBulkPlaylistModalVisible(false);
            exitSelectMode();
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 20,
    gap: 8,
  },
  headerTitle: {
    fontSize: 34,
    fontFamily: 'Amiri_700Bold',
    textAlign: 'right',
  },
  headerSubtitle: {
    fontSize: 15,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
    marginBottom: 12,
  },
  manualButton: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    marginBottom: 4,
  },
  manualButtonText: {
    fontSize: 13,
    fontFamily: 'Cairo_700Bold',
  },
  searchBar: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    height: 48,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  searchAndFilterRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
  },
  filterToggle: {
    minHeight: 48,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  filterToggleText: {
    fontSize: 12,
    fontFamily: 'Cairo_700Bold',
  },
  filtersPanel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 12,
  },
  filterGroup: {
    gap: 7,
  },
  filterLabel: {
    textAlign: 'right',
    fontSize: 12,
    fontFamily: 'Cairo_700Bold',
  },
  filterOptions: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: 7,
  },
  filterChip: {
    minHeight: 38,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 5,
  },
  filterChipText: {
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  clearFiltersButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  clearFiltersText: {
    fontSize: 12,
    fontFamily: 'Cairo_700Bold',
  },
  headerTopRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectionHeaderActions: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 20,
  },
  selectToggleText: {
    fontSize: 15,
    fontFamily: 'Cairo_600SemiBold',
  },
  list: {
    paddingHorizontal: 20,
    gap: 16,
  },
  selectableRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
  },
  selectCheckbox: {
    marginTop: 2,
  },
  bulkBar: {
    position: 'absolute',
    left: 20,
    right: 20,
    borderRadius: 8,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  bulkCount: {
    fontSize: 15,
    fontFamily: 'Cairo_700Bold',
  },
  bulkActions: {
    flexDirection: 'row-reverse',
    gap: 24,
  },
  bulkActionButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
  },
  bulkActionText: {
    fontSize: 13,
    fontFamily: 'Cairo_700Bold',
  },
});
