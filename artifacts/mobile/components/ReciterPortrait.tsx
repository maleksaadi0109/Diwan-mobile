import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useColors } from '@/hooks/useColors';

const portraits: Record<string, number> = {
  'osama-alwaaedh': require('../assets/reciters/osama-alwaaedh.jpg'),
  'omar-alsharafi': require('../assets/reciters/omar-alsharafi.jpg'),
  'khaled-alsharafi': require('../assets/reciters/khaled-alsharafi.jpg'),
  'khaled-bin-hassan': require('../assets/reciters/khaled-bin-hassan.jpg'),
  taraneem: require('../assets/reciters/taraneem.jpg'),
};

interface ReciterPortraitProps {
  reciterId?: string;
  name?: string;
  size?: number;
}

export function ReciterPortrait({ reciterId, name, size = 48 }: ReciterPortraitProps) {
  const colors = useColors();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [reciterId]);
  const source = reciterId ? portraits[reciterId] : undefined;
  // Taraneem uses the channel's published artwork, not a verified headshot.
  const label = reciterId === 'taraneem'
    ? 'صورة قناة ترنيم'
    : name ? `صورة القارئ ${name}` : 'صورة القارئ';
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.frame, {
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        backgroundColor: colors.secondary,
        borderColor: colors.border,
      }]}
    >
      {source && !failed ? (
        <Image
          source={source}
          style={styles.image}
          contentFit="cover"
          transition={180}
          onError={() => setFailed(true)}
          accessible={false}
        />
      ) : name ? (
        <Text
          accessible={false}
          style={[styles.initial, { color: colors.primary, fontSize: size * 0.53, lineHeight: size * 0.8 }]}
        >
          {name.trim().charAt(0)}
        </Text>
      ) : (
        <Feather name="user" size={size * 0.45} color={colors.primary} accessible={false} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  image: { width: '100%', height: '100%' },
  initial: { fontFamily: 'Amiri_700Bold', textAlign: 'center', includeFontPadding: false },
});