import React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColors } from '../contexts/ThemeContext';
import { outgoingBubbleBackgroundStyles as styles } from '../styles/OutgoingBubbleBackground.styles';

/** Decorative layer; parent owns padding, border radius and interaction. */
export default function OutgoingBubbleBackground({ fromMe }: { fromMe: boolean }) {
  const { outgoingBubble } = useThemeColors();
  if (!fromMe) return null;
  return (
    <LinearGradient
      pointerEvents="none"
      colors={outgoingBubble.gradient}
      locations={outgoingBubble.locations}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.fill}
    >
      <View style={[styles.fill, { backgroundColor: outgoingBubble.scrim }]} />
    </LinearGradient>
  );
}
