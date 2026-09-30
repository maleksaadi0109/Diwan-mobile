import React, { useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useSettings,
} from '@/contexts/SettingsContext';
import { useLibrary } from '@/contexts/LibraryContext';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import {
  assertLocalStorageValid,
  createBackupArchive,
  pickBackup,
  discardPickedBackup,
  shareBackupArchive,
  restoreBackupMerge,
  assertBackupPlaylistReferences,
  type PickedBackup,
} from '@/lib/backup';

const FONT_STEP = 2;

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { fontSize, setFontSize } = useSettings();
  const { poems, addPoem, removePoems, isLoading: libraryLoading } = useLibrary();
  const {
    playlists,
    mergeImportedPlaylists,
    isLoading: playlistsLoading,
  } = usePlaylists();
  const [backupBusy, setBackupBusy] = useState(false);
  const restoreUnavailable = backupBusy || libraryLoading || playlistsLoading;
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const tabBarHeight = Platform.OS === 'web' ? 84 : 64 + insets.bottom;

  const adjust = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setFontSize(fontSize + delta);
  };

  const exportBackup = async () => {
    setBackupBusy(true);
    try {
      const uri = await createBackupArchive();
      await shareBackupArchive(uri);
    } catch (error) {
      Alert.alert('تعذر تصدير النسخة', error instanceof Error ? error.message : 'حدث خطأ غير متوقع.');
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async (picked: PickedBackup) => {
    setBackupBusy(true);
    try {
      const backup = picked.backup;
      await assertLocalStorageValid();
      assertBackupPlaylistReferences(backup, poems.map((poem) => poem.id));
      const { added: addedPlaylists, skipped: existingPlaylists } =
        await restoreBackupMerge(
          backup, poems.map((poem) => poem.id), addPoem, removePoems,
          mergeImportedPlaylists, picked.kind === 'archive' ? picked : undefined,
        );
      setFontSize(backup.settings.fontSize);
      Alert.alert(
        'اكتملت الاستعادة',
        `أُضيفت القصائد والقوائم غير الموجودة فقط (${addedPlaylists} قائمة جديدة، وتُركت ${existingPlaylists} قائمة موجودة دون تغيير). حُفظت معرّفات القوائم الأصلية لتكون الاستعادة المتكررة آمنة. تم تطبيق حجم الخط من النسخة.`,
      );
    } catch (error) {
      Alert.alert(
        'تعذرت الاستعادة بالكامل',
        `لم تُحذف بياناتك الحالية. جرت محاولة التراجع عن أي إضافات؛ إذا تعذر ذلك، احتفظ بالنسخة الاحتياطية وحرّر مساحة التخزين ثم أعد المحاولة. ${error instanceof Error ? error.message : ''}`,
      );
    } finally {
      await discardPickedBackup(picked);
      setBackupBusy(false);
    }
  };

  const importBackup = async () => {
    setBackupBusy(true);
    let confirmationPending = false;
    let picked: PickedBackup | null = null;
    try {
      picked = await pickBackup();
      if (picked === null) return;
      const selected = picked;
      const backup = selected.backup;
      assertBackupPlaylistReferences(backup, poems.map((poem) => poem.id));
      confirmationPending = true;
      Alert.alert(
        'تأكيد استعادة النسخة',
        `${backup.poems.length} قصائد و${backup.playlists.length} قوائم. ستُضاف العناصر ذات المعرّفات غير الموجودة فقط، مع حفظ معرّفات القوائم الأصلية لتكون الاستعادة المتكررة آمنة. لن تُستبدل أو تُحذف بياناتك الحالية. سيُحدّث حجم الخط.`,
        [
          { text: 'إلغاء', style: 'cancel', onPress: () => { void discardPickedBackup(selected); setBackupBusy(false); } },
          { text: 'دمج واستعادة', onPress: () => void restoreBackup(selected) },
        ],
      );
    } catch (error) {
      Alert.alert(
        'تعذر قراءة النسخة الاحتياطية',
        error instanceof Error ? error.message : 'حدث خطأ غير متوقع. لم يتم تغيير أي بيانات.',
      );
    } finally {
      if (!confirmationPending) {
        if (picked) await discardPickedBackup(picked);
        setBackupBusy(false);
      }
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: topInset + 20, paddingBottom: tabBarHeight + 24 },
      ]}
    >
      <Text style={[styles.pageTitle, { color: colors.foreground }]}>
        الإعدادات
      </Text>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardLabel, { color: colors.foreground }]}>
          حجم خط القصيدة
        </Text>
        <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
          يتحكم بحجم نص الأبيات في شاشة القراءة
        </Text>

        <View style={styles.fontRow}>
          <Pressable
            onPress={() => adjust(FONT_STEP)}
            disabled={fontSize >= MAX_FONT_SIZE}
            testID="settings-font-increase"
            style={({ pressed }) => [
              styles.stepButton,
              {
                backgroundColor: colors.secondary,
                opacity: fontSize >= MAX_FONT_SIZE ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather name="plus" size={18} color={colors.foreground} />
          </Pressable>

          <View style={styles.fontPreviewWrap}>
            <Text
              style={[
                styles.fontPreview,
                { color: colors.foreground, fontSize },
              ]}
              numberOfLines={1}
            >
              أبجد هوز
            </Text>
          </View>

          <Pressable
            onPress={() => adjust(-FONT_STEP)}
            disabled={fontSize <= MIN_FONT_SIZE}
            testID="settings-font-decrease"
            style={({ pressed }) => [
              styles.stepButton,
              {
                backgroundColor: colors.secondary,
                opacity: fontSize <= MIN_FONT_SIZE ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather name="minus" size={18} color={colors.foreground} />
          </Pressable>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.aboutRow}>
          <Feather name="shield" size={18} color={colors.primary} />
          <Text style={[styles.cardLabel, { color: colors.foreground }]}>
            النسخ الاحتياطي والاستعادة
          </Text>
        </View>
        <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
          تصدير أرشيف ديوان يشمل مكتبتك وقوائمك وحجم الخط وملفات الصوت المحفوظة دون اتصال، حتى للمكتبات الكبيرة. يمكن أيضاً استعادة نسخ JSON القديمة (حتى 100 ميغابايت). الاستعادة تدمج العناصر الجديدة فقط ولا تستبدل بياناتك. التسجيلات البعيدة غير المحفوظة محلياً تحتاج اتصالاً بالخادم لتشغيلها.
        </Text>
        {Platform.OS === 'web' ? (
          <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
            النسخ والاستعادة غير متاحين في إصدار الويب حالياً؛ استخدم تطبيق الهاتف.
          </Text>
        ) : (
          <View style={styles.backupButtons}>
            <Pressable
              disabled={backupBusy}
              onPress={() => void exportBackup()}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.backupButton,
                { backgroundColor: colors.secondary, opacity: backupBusy ? 0.5 : pressed ? 0.7 : 1 },
              ]}
            >
              <Feather name="download" size={16} color={colors.foreground} />
              <Text style={[styles.backupButtonText, { color: colors.foreground }]}>تصدير نسخة</Text>
            </Pressable>
            <Pressable
              disabled={restoreUnavailable}
              onPress={() => void importBackup()}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.backupButton,
                { backgroundColor: colors.secondary, opacity: restoreUnavailable ? 0.5 : pressed ? 0.7 : 1 },
              ]}
            >
              <Feather name="upload" size={16} color={colors.foreground} />
              <Text style={[styles.backupButtonText, { color: colors.foreground }]}>استعادة نسخة</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.aboutRow}>
          <Feather name="server" size={18} color={colors.primary} />
          <Text style={[styles.cardLabel, { color: colors.foreground }]}>
            استيراد الصوت
          </Text>
        </View>
        <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
          يعتمد استيراد قصائد يوتيوب على خادم واحد مشترك (تفريغ ومحاذاة صوتية
          محلية بدون أي خدمة ذكاء اصطناعي مدفوعة). يلزم اتصال بالإنترنت أثناء
          الاستيراد والاستماع فقط.
        </Text>
      </View>
    </ScrollView>
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
    marginBottom: 8,
  },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 20,
    gap: 8,
  },
  cardLabel: {
    fontSize: 17,
    fontFamily: 'Cairo_700Bold',
    textAlign: 'right',
  },
  cardHint: {
    fontSize: 14,
    fontFamily: 'Cairo_400Regular',
    textAlign: 'right',
    lineHeight: 22,
  },
  fontRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 16,
    marginTop: 12,
  },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(235, 227, 213, 0.1)',
  },
  fontPreviewWrap: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(26, 22, 20, 0.5)',
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(235, 227, 213, 0.1)',
  },
  fontPreview: {
    fontFamily: 'Amiri_700Bold',
  },
  aboutRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 10,
  },
  backupButtons: {
    flexDirection: 'row-reverse',
    gap: 10,
    marginTop: 8,
  },
  backupButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  backupButtonText: {
    fontSize: 14,
    fontFamily: 'Cairo_700Bold',
  },
});
