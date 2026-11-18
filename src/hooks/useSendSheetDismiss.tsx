import React, { useCallback, useEffect } from 'react';
import { BackHandler } from 'react-native';
import { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

interface Options {
  visible: boolean;
  onClose: () => void;
  /** Clears the typed input so the next open starts clean. */
  resetInputForOpen: () => void;
}

/**
 * How the Send sheet closes: the Android back button, a swipe down (the
 * sheet's index reaching -1) and its tap-to-dismiss backdrop. Every route
 * clears the typed input before `onClose`. Split out of SendSheet.tsx.
 */
export function useSendSheetDismiss({ visible, onClose, resetInputForOpen }: Options) {
  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      resetInputForOpen();
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [visible, onClose, resetInputForOpen]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        resetInputForOpen();
        onClose();
      }
    },
    [onClose, resetInputForOpen],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  return { handleSheetChange, renderBackdrop };
}
