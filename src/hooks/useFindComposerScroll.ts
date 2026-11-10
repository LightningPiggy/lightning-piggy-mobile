import { useEffect, useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';

/** Returning from a successful claim brings the always-visible composer into view. */
export function useFindComposerScroll(openComposer: boolean | undefined) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    if (!openComposer) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [openComposer]);
  return scrollRef;
}
