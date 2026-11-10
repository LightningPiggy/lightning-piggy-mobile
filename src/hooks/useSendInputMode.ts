import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SendInputMode } from '../components/SendModeTabs';

type CameraPermission = { granted: boolean } | null | undefined;

interface Options {
  visible: boolean;
  // `useCameraPermissions()` value — `null` until expo's async get resolves.
  permission: CameraPermission;
  // Anything the user has already entered/scanned in this open. Latches off the
  // late switch to Scan so an in-progress form is never yanked away.
  hasInput: boolean;
  // Freshest paste-field text. The field is uncontrolled, so native typing
  // writes this ref synchronously and can run ahead of the committed state
  // behind `hasInput`; non-empty text here also blocks the late switch.
  liveInputRef?: RefObject<string>;
}

// Send's Scan/Paste/NFC tab selection. The open default is Scan when the camera
// is usable, else Paste (a scanner that can't start is a dead-end). Because
// HomeSheets lazy-mounts SendSheet on first open, that first open runs in the
// same commit as `useCameraPermissions()`'s mount, while permission is still
// `null`. Such an open defaults to Paste but stays "awaiting": if the first
// resolution is granted, and the user hasn't picked a tab or entered anything,
// move to Scan — only the tab, never a form reset. Denied/unavailable, an
// initialAddress, or any user action ends the wait and keeps Paste.
export function useSendInputMode({ visible, permission, hasInput, liveInputRef }: Options) {
  const [inputMode, setInputMode] = useState<SendInputMode>('scan');
  const awaitingPermissionRef = useRef(false);
  const permissionRef = useRef(permission);
  permissionRef.current = permission;

  // Call from the sheet's open effect (not onChange handlers). An explicit
  // `preferred` tab (the widget's Scan button, #1849) wins: the user asked for
  // it, and the Scan tab itself asks for camera access when it isn't granted.
  const resetInputModeForOpen = useCallback(
    (initialAddress?: string, preferred?: SendInputMode) => {
      const current = permissionRef.current;
      awaitingPermissionRef.current = !preferred && !initialAddress && current == null;
      if (preferred) setInputMode(preferred);
      else setInputMode(initialAddress || !current?.granted ? 'paste' : 'scan');
    },
    [],
  );

  // User tab taps and programmatic returns to an editable field.
  const selectInputMode = useCallback((mode: SendInputMode) => {
    awaitingPermissionRef.current = false;
    setInputMode(mode);
  }, []);

  useEffect(() => {
    if (hasInput) awaitingPermissionRef.current = false;
  }, [hasInput]);

  const resolved = permission != null;
  const granted = !!permission?.granted;
  useEffect(() => {
    if (!resolved || !awaitingPermissionRef.current) return;
    awaitingPermissionRef.current = false;
    // Read the ref, not just `hasInput`: this effect can flush before a
    // keystroke's setState commits (its closure still sees empty input).
    const typing = !!liveInputRef?.current;
    if (granted && visible && !hasInput && !typing) setInputMode('scan');
    // Only the first resolution after an unresolved open matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, granted]);

  return { inputMode, resetInputModeForOpen, selectInputMode };
}
