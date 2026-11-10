import type { ViewInstance } from 'react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, GestureResponderEvent } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createAlphabetBarStyles } from '../styles/AlphabetBar.styles';

interface Props {
  // Letters that have content (friends/contacts) — tappable. Letters NOT
  // in this list still render in the bar but are greyed out and
  // non-interactive (so the user sees the full A-Z index instead of a
  // truncated subset).
  letters: string[];
  currentLetter: string | null;
  onLetterPress: (letter: string) => void;
}

// `#` covers names that don't start with a Latin A-Z letter (digits,
// emoji, non-Latin scripts — see firstAlpha() in FriendPickerSheet /
// FriendsScreen).
const FULL_ALPHABET = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
];

const AlphabetBar: React.FC<Props> = React.memo(
  ({ letters, currentLetter, onLetterPress }) => {
    const colors = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createAlphabetBarStyles(colors), [colors]);
    const [tapped, setTapped] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onPressRef = useRef(onLetterPress);
    onPressRef.current = onLetterPress;

    const barRef = useRef<ViewInstance>(null);
    const barLayout = useRef({ y: 0, height: 0 });
    const lastDragLetter = useRef<string | null>(null);

    useEffect(() => {
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }, []);

    const handlePress = useCallback((letter: string) => {
      setTapped(letter);
      onPressRef.current(letter);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setTapped(null);
      }, 1500);
    }, []);

    const availableSet = useMemo(() => new Set(letters), [letters]);

    const getLetterFromY = useCallback(
      (pageY: number) => {
        // The rendered bar always shows FULL_ALPHABET (27 buckets), so
        // map the touch y-position against FULL_ALPHABET.length, not the
        // (possibly smaller) `letters` subset — otherwise dragging
        // jumps because the visual letter under the finger doesn't
        // match the index the math computes. Then if the letter we
        // landed on is disabled (no contacts in that bucket), snap to
        // the nearest enabled letter so the user always sees feedback.
        const { y, height } = barLayout.current;
        if (height === 0 || letters.length === 0) return null;
        const relY = pageY - y;
        const idx = Math.max(
          0,
          Math.min(Math.floor((relY / height) * FULL_ALPHABET.length), FULL_ALPHABET.length - 1),
        );
        const target = FULL_ALPHABET[idx];
        if (availableSet.has(target)) return target;
        // Snap to the nearest enabled letter (search outward from idx).
        for (let off = 1; off < FULL_ALPHABET.length; off++) {
          const before = FULL_ALPHABET[idx - off];
          if (before && availableSet.has(before)) return before;
          const after = FULL_ALPHABET[idx + off];
          if (after && availableSet.has(after)) return after;
        }
        return null;
      },
      [letters, availableSet],
    );

    const handleTouchStart = useCallback((e: GestureResponderEvent) => {
      const { locationY, pageY } = e.nativeEvent;
      barLayout.current.y = pageY - locationY;
      lastDragLetter.current = null;
    }, []);

    const handleTouchMove = useCallback(
      (e: GestureResponderEvent) => {
        const pageY = e.nativeEvent.pageY;
        const letter = getLetterFromY(pageY);
        if (letter && letter !== lastDragLetter.current) {
          lastDragLetter.current = letter;
          setTapped(letter);
          onPressRef.current(letter);
          if (timerRef.current) clearTimeout(timerRef.current);
        }
      },
      [getLetterFromY],
    );

    const handleTouchEnd = useCallback(() => {
      lastDragLetter.current = null;
      timerRef.current = setTimeout(() => setTapped(null), 1500);
    }, []);

    return (
      <View
        ref={barRef}
        style={styles.alphabetBar}
        accessibilityRole="list"
        accessibilityLabel={t('alphabetBar.alphabetIndex')}
        onLayout={(e) => {
          barLayout.current.height = e.nativeEvent.layout.height;
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {FULL_ALPHABET.map((letter) => {
          const enabled = availableSet.has(letter);
          const isActive =
            enabled && (tapped === letter || (tapped === null && currentLetter === letter));
          return (
            <TouchableOpacity
              key={letter}
              style={[styles.alphabetLetterTouch, isActive && styles.alphabetLetterActive]}
              activeOpacity={enabled ? 0.7 : 1}
              onPress={() => enabled && handlePress(letter)}
              disabled={!enabled}
              accessibilityRole="button"
              accessibilityLabel={
                enabled
                  ? t('alphabetBar.jumpTo', { letter })
                  : t('alphabetBar.noContacts', { letter })
              }
              accessibilityState={{ disabled: !enabled }}
              testID={`alphabet-${letter}`}
            >
              <Text
                style={[
                  styles.alphabetLetter,
                  !enabled && styles.alphabetLetterDisabled,
                  isActive && styles.alphabetLetterTextActive,
                ]}
              >
                {letter}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  },
  (prev, next) => {
    if (prev.currentLetter !== next.currentLetter) return false;
    if (prev.letters.length !== next.letters.length) return false;
    return prev.letters === next.letters || prev.letters.every((l, i) => l === next.letters[i]);
  },
);
AlphabetBar.displayName = 'AlphabetBar';

export default AlphabetBar;
