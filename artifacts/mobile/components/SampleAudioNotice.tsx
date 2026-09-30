import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useLibrary } from '@/contexts/LibraryContext';
import { SAMPLE_CATALOG_IDS } from '@/lib/samplePoems';
import { hasPoemAudio } from '@/lib/sampleAudio';

/** Visible while the three built-in poems acquire their real recordings. */
export function SampleAudioNotice() {
  const colors = useColors();
  const { poems, sampleAudioStatus, retrySampleAudio } = useLibrary();
  const samples = SAMPLE_CATALOG_IDS.map((id) => ({
    id,
    poem: poems.find((item) => item.id === `sample-${id}`),
  })).filter((item) => Boolean(item.poem));
  if (!samples.length) return null;
  const remaining = samples.filter(({ poem }) => poem && !hasPoemAudio(poem));
  if (!remaining.length) return null;
  const active = remaining.find(({ id }) =>
     ['downloading', 'saving', 'resuming'].includes(sampleAudioStatus[id]?.phase ?? ''));
  const readyCount = samples.length - remaining.length;

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}
      testID="sample-audio-notice">
      <Text style={[styles.title, { color: colors.foreground }]}>
        أصوات قصائد التجربة · {readyCount} من {samples.length}
      </Text>
      {Platform.OS === 'web' ? (
        <Text style={[styles.detail, { color: colors.mutedForeground }]}>
          تنزيل الصوت وحفظه دون اتصال يتم داخل تطبيق الهاتف؛ معاينة الويب لا تحفظ الملفات الصوتية.
        </Text>
      ) : (
        <>
          {active ? (
            <View style={styles.activeRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                 {sampleAudioStatus[active.id]?.phase === 'saving' ? 'جارٍ حفظ' :
                   sampleAudioStatus[active.id]?.phase === 'resuming' ? 'جارٍ استكمال' : 'جارٍ تنزيل'}
                {' '}صوت «{active.poem?.title}»…
                 {sampleAudioStatus[active.id]?.phase === 'saving' && sampleAudioStatus[active.id]?.progress
                   ? ` ${Math.floor(100 * sampleAudioStatus[active.id]!.progress!)}٪` : ''}
              </Text>
            </View>
          ) : null}
           {remaining.filter(({ id }) => ['error', 'interrupted'].includes(sampleAudioStatus[id]?.phase ?? '')).map(({ id, poem }) => (
            <View key={id} style={styles.errorRow}>
              <Text style={[styles.detail, styles.errorText, { color: colors.destructive }]}>
                 {poem?.title}: {sampleAudioStatus[id]?.phase === 'interrupted' ? 'توقف التنزيل؛ يمكن استكماله عند فتح التطبيق. ' : ''}{sampleAudioStatus[id]?.message}
              </Text>
              <Pressable
                accessibilityRole="button"
                testID={`sample-audio-retry-${id}`}
                onPress={() => { void retrySampleAudio(id); }}
              >
                <Text style={[styles.retry, { color: colors.primary }]}>إعادة المحاولة</Text>
              </Pressable>
            </View>
          ))}
           {!active && !remaining.some(({ id }) => ['error', 'interrupted'].includes(sampleAudioStatus[id]?.phase ?? '')) ? (
            <Text style={[styles.detail, { color: colors.mutedForeground }]}>
              ستُنزّل الأصوات تلقائيًا وتُحفظ على الهاتف عند توفر الاتصال.
            </Text>
          ) : null}
          {Platform.OS === 'android' && active ? (
            <Text style={[styles.detail, { color: colors.mutedForeground }]}>
              قد يتوقف حفظ الملف إذا أغلق النظام التطبيق؛ يمكن إعادة المحاولة عند فتحه.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginHorizontal: 20, marginTop: 10, marginBottom: 12, padding: 14, borderRadius: 12, borderWidth: 1 },
  title: { fontFamily: 'Cairo_700Bold', fontSize: 13, textAlign: 'right' },
  detail: { fontFamily: 'Cairo_400Regular', fontSize: 12, textAlign: 'right', lineHeight: 20, flexShrink: 1 },
  activeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginTop: 4 },
  errorRow: { marginTop: 6, gap: 3 },
  errorText: { flex: 1 },
  retry: { fontFamily: 'Cairo_600SemiBold', fontSize: 12, textAlign: 'right' },
});