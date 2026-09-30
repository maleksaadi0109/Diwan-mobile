import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useColors } from '@/hooks/useColors';
import type { Poem } from '@/lib/types';
import { getReciterForMobilePoem } from '@/lib/readyCatalog';
import { getBundledSampleThumbnailSource, getPoemCoverSource } from '@/lib/sampleThumbnails';
import { ReciterPortrait } from '@/components/ReciterPortrait';

interface PoemCardProps {
  poem: Poem;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
}

export function PoemCard({ poem, onPress, onLongPress, testID }: PoemCardProps) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const preview = poem.verses[0]?.text ?? '';
  const reciter = getReciterForMobilePoem(poem);
  const readerName = reciter?.name ?? poem.recording?.reciter;
  const coverSource = getPoemCoverSource(poem);
  const bundledCover = Boolean(coverSource && coverSource === getBundledSampleThumbnailSource(poem));
  const coverHeight = Math.min(210, Math.max(155, Math.round(Math.min(width - 48, 560) * 0.47)));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID ?? `poem-card-${poem.id}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRightColor: colors.primary,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {coverSource ? (
        <Image
          source={coverSource}
          style={[styles.cover, { height: coverHeight, backgroundColor: colors.background }]}
          contentFit="cover"
          contentPosition={bundledCover ? 'top center' : 'center'}
          transition={180}
          accessibilityLabel={`الصورة المصغّرة لقصيدة ${poem.title}`}
        />
      ) : null}

      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text
              style={[styles.title, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {poem.title}
            </Text>
            <Text
              style={[styles.poet, { color: colors.primary }]}
              numberOfLines={1}
            >
              {poem.poetName}
            </Text>
          </View>
          {poem.recording ? (
            <View style={[styles.badge, { backgroundColor: colors.accent }]}>
              <Feather name="play" size={12} color={colors.primary} style={{ marginLeft: 2 }} />
            </View>
          ) : (
            <View style={[styles.badge, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}>
              <Feather name="book-open" size={12} color={colors.mutedForeground} />
            </View>
          )}
        </View>

        {preview ? (
          <Text
            style={[styles.preview, { color: colors.mutedForeground }]}
            numberOfLines={2}
          >
            {preview}
          </Text>
        ) : null}
        {readerName ? (
          <View style={[styles.reader, { borderTopColor: colors.border }]}>
            <ReciterPortrait reciterId={reciter?.id} name={readerName} size={27} />
            <Text style={[styles.readerName, { color: colors.mutedForeground }]} numberOfLines={1}>
              بصوت {readerName}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 130,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderRightWidth: 3,
    overflow: 'hidden',
  },
  cover: {
    width: '100%',
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 15,
    gap: 10,
  },
  header: {
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    gap: 12,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Amiri_700Bold',
    textAlign: 'right',
  },
  poet: {
    fontSize: 12,
    fontFamily: 'Cairo_600SemiBold',
    textAlign: 'right',
  },
  preview: {
    fontSize: 15,
    fontFamily: 'Amiri_400Regular',
    textAlign: 'right',
    lineHeight: 26,
  },
  reader: { flexDirection: 'row-reverse', alignItems: 'center', gap: 7, borderTopWidth: 1, paddingTop: 10 },
  readerName: { flexShrink: 1, fontSize: 11, fontFamily: 'Cairo_600SemiBold', textAlign: 'right' },
});
