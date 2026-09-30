import React, { useMemo, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import { makeLocalId } from '@/lib/api';
import type { Poem, Verse } from '@/lib/types';

const TITLE_MAX_LENGTH = 120;
const POET_MAX_LENGTH = 100;
const METADATA_MAX_LENGTH = 80;
const VERSES_MAX_LENGTH = 24_000;
const MAX_VERSES = 200;
const MAX_VERSE_LENGTH = 500;

export default function ManualPoemScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { addPoem } = useLibrary();
  const [title, setTitle] = useState('');
  const [poetName, setPoetName] = useState('');
  const [era, setEra] = useState('');
  const [meter, setMeter] = useState('');
  const [versesText, setVersesText] = useState('');
  const [errors, setErrors] = useState<{ title?: string; poetName?: string; verses?: string }>({});
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const verseCount = useMemo(
    () => versesText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
    [versesText],
  );

  const validate = () => {
    const nextErrors: typeof errors = {};
    if (!title.trim()) nextErrors.title = 'أدخل عنوان القصيدة';
    if (!poetName.trim()) nextErrors.poetName = 'أدخل اسم الشاعر';

    const verseLines = versesText.split(/\r?\n/).map((line) => line.trim());
    const nonemptyVerses = verseLines.filter(Boolean);
    if (nonemptyVerses.length === 0) {
      nextErrors.verses = 'أدخل بيتًا واحدًا على الأقل، كل بيت في سطر';
    } else if (nonemptyVerses.length > MAX_VERSES) {
      nextErrors.verses = `الحد الأقصى ${MAX_VERSES} بيتًا`;
    } else if (nonemptyVerses.some((verse) => verse.length > MAX_VERSE_LENGTH)) {
      nextErrors.verses = `يجب ألا يتجاوز كل بيت ${MAX_VERSE_LENGTH} حرفًا`;
    }

    setErrors(nextErrors);
    return { nextErrors, nonemptyVerses };
  };

  const savePoem = async () => {
    if (isSaving) return;
    const { nextErrors, nonemptyVerses } = validate();
    if (Object.keys(nextErrors).length > 0) return;

    const poemId = makeLocalId('poem');
    const poem: Poem = {
      id: poemId,
      title: title.trim(),
      poetName: poetName.trim(),
      ...(era.trim() ? { era: era.trim() } : {}),
      ...(meter.trim() ? { meter: meter.trim() } : {}),
      verses: nonemptyVerses.map((text, orderIndex): Verse => ({
        id: makeLocalId('verse'),
        orderIndex,
        text,
      })),
      createdAt: Date.now(),
    };

    setSaveError('');
    setIsSaving(true);
    try {
      await addPoem(poem);
      router.replace({ pathname: '/poem/[id]', params: { id: poemId } });
    } catch {
      setSaveError('تعذر حفظ القصيدة. تحقق من مساحة التخزين وحاول مرة أخرى.');
      setIsSaving(false);
    }
  };

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  };

  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 16) : insets.top;
  const bottomInset = Platform.OS === 'web' ? 24 : insets.bottom;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.topBar, { paddingTop: topInset + 8, borderBottomColor: colors.border }]}>
        <Pressable
          onPress={goBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="العودة"
          testID="manual-poem-back"
          style={styles.backButton}
        >
          <Feather name="arrow-right" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.topBarTitle, { color: colors.foreground }]}>إضافة قصيدة يدويًا</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 28 }]}
      >
        <View style={styles.intro}>
          <View style={[styles.iconBadge, { backgroundColor: colors.accent }]}>
            <Feather name="edit-3" size={21} color={colors.primary} />
          </View>
          <Text style={[styles.heading, { color: colors.foreground }]}>قصيدة جديدة</Text>
          <Text style={[styles.description, { color: colors.mutedForeground }]}>
            أضف العنوان واسم الشاعر، ثم اكتب كل بيت في سطر مستقل.
          </Text>
        </View>

        <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.foreground }]}>عنوان القصيدة</Text>
          <TextInput
            value={title}
            onChangeText={(value) => {
              setTitle(value);
              setErrors((current) => ({ ...current, title: undefined }));
            }}
            placeholder="مثال: إرادة الحياة"
            placeholderTextColor={colors.mutedForeground}
            maxLength={TITLE_MAX_LENGTH}
            returnKeyType="next"
            textAlign="right"
            style={[styles.singleLineInput, { color: colors.foreground, backgroundColor: colors.input, borderColor: errors.title ? colors.destructive : colors.border }]}
            accessibilityLabel="عنوان القصيدة"
            testID="manual-poem-title"
          />
          <View style={styles.fieldMetaRow}>
            {errors.title ? <Text style={[styles.errorText, { color: colors.destructive }]}>{errors.title}</Text> : <View />}
            <Text style={[styles.counter, { color: colors.mutedForeground }]}>{title.length}/{TITLE_MAX_LENGTH}</Text>
          </View>

          <Text style={[styles.label, styles.spacedLabel, { color: colors.foreground }]}>اسم الشاعر</Text>
          <TextInput
            value={poetName}
            onChangeText={(value) => {
              setPoetName(value);
              setErrors((current) => ({ ...current, poetName: undefined }));
            }}
            placeholder="اسم الشاعر"
            placeholderTextColor={colors.mutedForeground}
            maxLength={POET_MAX_LENGTH}
            returnKeyType="next"
            textAlign="right"
            style={[styles.singleLineInput, { color: colors.foreground, backgroundColor: colors.input, borderColor: errors.poetName ? colors.destructive : colors.border }]}
            accessibilityLabel="اسم الشاعر"
            testID="manual-poem-poet"
          />
          <View style={styles.fieldMetaRow}>
            {errors.poetName ? <Text style={[styles.errorText, { color: colors.destructive }]}>{errors.poetName}</Text> : <View />}
            <Text style={[styles.counter, { color: colors.mutedForeground }]}>{poetName.length}/{POET_MAX_LENGTH}</Text>
          </View>

          <Text style={[styles.label, styles.spacedLabel, { color: colors.foreground }]}>العصر (اختياري)</Text>
          <TextInput
            value={era}
            onChangeText={setEra}
            placeholder="مثال: العصر العباسي"
            placeholderTextColor={colors.mutedForeground}
            maxLength={METADATA_MAX_LENGTH}
            returnKeyType="next"
            textAlign="right"
            style={[styles.singleLineInput, { color: colors.foreground, backgroundColor: colors.input, borderColor: colors.border }]}
            accessibilityLabel="عصر القصيدة"
            testID="manual-poem-era"
          />
          <Text style={[styles.label, styles.spacedLabel, { color: colors.foreground }]}>البحر (اختياري)</Text>
          <TextInput
            value={meter}
            onChangeText={setMeter}
            placeholder="مثال: البحر الطويل"
            placeholderTextColor={colors.mutedForeground}
            maxLength={METADATA_MAX_LENGTH}
            returnKeyType="next"
            textAlign="right"
            style={[styles.singleLineInput, { color: colors.foreground, backgroundColor: colors.input, borderColor: colors.border }]}
            accessibilityLabel="بحر القصيدة"
            testID="manual-poem-meter"
          />

          <View style={[styles.versesHeadingRow, styles.spacedLabel]}>
            <Text style={[styles.label, { color: colors.foreground }]}>أبيات القصيدة</Text>
            <Text style={[styles.counter, { color: colors.mutedForeground }]}>{verseCount}/{MAX_VERSES}</Text>
          </View>
          <TextInput
            value={versesText}
            onChangeText={(value) => {
              setVersesText(value);
              setErrors((current) => ({ ...current, verses: undefined }));
            }}
            placeholder={'اكتب البيت الأول هنا\nثم البيت الثاني في السطر التالي'}
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={VERSES_MAX_LENGTH}
            textAlign="right"
            textAlignVertical="top"
            scrollEnabled={false}
            style={[
              styles.versesInput,
              {
                color: colors.foreground,
                backgroundColor: colors.input,
                borderColor: errors.verses ? colors.destructive : colors.border,
              },
            ]}
            accessibilityLabel="أبيات القصيدة، كل بيت في سطر"
            testID="manual-poem-verses"
          />
          <View style={styles.fieldMetaRow}>
            {errors.verses ? <Text style={[styles.errorText, styles.flexError, { color: colors.destructive }]}>{errors.verses}</Text> : <View style={styles.flexError} />}
            <Text style={[styles.counter, { color: colors.mutedForeground }]}>{versesText.length}/{VERSES_MAX_LENGTH}</Text>
          </View>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            الأسطر الفارغة لا تُحفظ. الحد الأقصى {MAX_VERSES} بيتًا و{MAX_VERSE_LENGTH} حرفًا للبيت.
          </Text>
        </View>

        {saveError ? (
          <View style={[styles.saveErrorBox, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '70' }]}>
            <Feather name="alert-circle" size={17} color={colors.destructive} />
            <Text style={[styles.saveErrorText, { color: colors.destructive }]}>{saveError}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={savePoem}
          disabled={isSaving}
          accessibilityRole="button"
          testID="manual-poem-save"
          style={({ pressed }) => [
            styles.saveButton,
            { backgroundColor: colors.primary, opacity: isSaving ? 0.7 : pressed ? 0.82 : 1 },
          ]}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Feather name="check" size={19} color={colors.primaryForeground} />
          )}
          <Text style={[styles.saveButtonText, { color: colors.primaryForeground }]}>
            {isSaving ? 'جارٍ الحفظ…' : 'حفظ القصيدة'}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    minHeight: 58,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { width: 32, alignItems: 'center', justifyContent: 'center' },
  topBarTitle: { fontFamily: 'Cairo_700Bold', fontSize: 16 },
  content: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingHorizontal: 20 },
  intro: { alignItems: 'center', paddingTop: 26, paddingBottom: 22 },
  iconBadge: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heading: { fontFamily: 'Cairo_700Bold', fontSize: 22 },
  description: { fontFamily: 'Cairo_400Regular', fontSize: 13, textAlign: 'center', lineHeight: 21, marginTop: 3 },
  formCard: { borderWidth: 1, borderRadius: 18, padding: 16 },
  label: { fontFamily: 'Cairo_600SemiBold', fontSize: 14, textAlign: 'right' },
  spacedLabel: { marginTop: 17 },
  singleLineInput: { height: 49, borderWidth: 1, borderRadius: 11, marginTop: 7, paddingHorizontal: 12, fontFamily: 'Cairo_400Regular', fontSize: 15, writingDirection: 'rtl' },
  fieldMetaRow: { minHeight: 19, marginTop: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  errorText: { fontFamily: 'Cairo_400Regular', fontSize: 11, textAlign: 'right' },
  flexError: { flex: 1, paddingRight: 8 },
  counter: { fontFamily: 'Cairo_400Regular', fontSize: 10 },
  versesHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  versesInput: { minHeight: 210, borderWidth: 1, borderRadius: 11, marginTop: 7, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, fontFamily: 'Amiri_400Regular', fontSize: 19, lineHeight: 34, writingDirection: 'rtl' },
  hint: { fontFamily: 'Cairo_400Regular', fontSize: 11, textAlign: 'right', lineHeight: 18, marginTop: 3 },
  saveErrorBox: { marginTop: 14, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveErrorText: { flex: 1, textAlign: 'right', fontFamily: 'Cairo_400Regular', fontSize: 12, lineHeight: 18 },
  saveButton: { height: 54, borderRadius: 14, marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  saveButtonText: { fontFamily: 'Cairo_700Bold', fontSize: 15 },
});