import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { useSendInputMode } from './useSendInputMode';
import type { SendInputMode } from '../components/SendModeTabs';

type Permission = { granted: boolean } | null;
interface Props {
  visible: boolean;
  permission: Permission;
  hasInput?: boolean;
  initialAddress?: string;
  preferred?: SendInputMode;
}

// Mirrors SendSheet: the hook is called first, then the open effect keyed on
// `visible` applies the open default (same effect ordering as the sheet).
const liveInputRef = { current: '' };

function useHarness({ visible, permission, hasInput = false, initialAddress, preferred }: Props) {
  const mode = useSendInputMode({ visible, permission, hasInput, liveInputRef });
  useEffect(() => {
    if (visible) mode.resetInputModeForOpen(initialAddress, preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  return mode;
}

const granted = { granted: true };
const denied = { granted: false };
const setup = (initialProps: Props) => renderHook((p: Props) => useHarness(p), { initialProps });

beforeEach(() => {
  liveInputRef.current = '';
});

it('moves an untouched first open to Scan once permission resolves granted', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  expect(result.current.inputMode).toBe('paste');
  rerender({ visible: true, permission: granted });
  expect(result.current.inputMode).toBe('scan');
});

it('keeps Paste when permission resolves denied, and does not switch on a later grant', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  rerender({ visible: true, permission: denied });
  expect(result.current.inputMode).toBe('paste');
  rerender({ visible: true, permission: granted });
  expect(result.current.inputMode).toBe('paste');
});

it('opens directly on Scan / Paste when permission is already known', () => {
  const g = setup({ visible: true, permission: granted });
  expect(g.result.current.inputMode).toBe('scan');
  const d = setup({ visible: true, permission: denied });
  expect(d.result.current.inputMode).toBe('paste');
});

it('keeps Paste for an initialAddress open even when permission resolves granted', () => {
  const { result, rerender } = setup({
    visible: true,
    permission: null,
    initialAddress: 'piggy@example.com',
  });
  rerender({ visible: true, permission: granted, initialAddress: 'piggy@example.com' });
  expect(result.current.inputMode).toBe('paste');
});

it.each(['paste', 'nfc'] as const)('respects a user %s tab tap before resolution', (tab) => {
  const { result, rerender } = setup({ visible: true, permission: null });
  act(() => result.current.selectInputMode(tab));
  rerender({ visible: true, permission: granted });
  expect(result.current.inputMode).toBe(tab);
});

it('never yanks typed content: input latches Paste even if later cleared', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  rerender({ visible: true, permission: null, hasInput: true });
  rerender({ visible: true, permission: null, hasInput: false });
  rerender({ visible: true, permission: granted, hasInput: false });
  expect(result.current.inputMode).toBe('paste');
});

it('ignores input arriving in the same commit as the resolution', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  rerender({ visible: true, permission: granted, hasInput: true });
  expect(result.current.inputMode).toBe('paste');
});

it('keeps Paste for native text in the live ref that has not reached state yet', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  // onChangeText wrote the ref synchronously; its setState hasn't committed,
  // so the resolution render still reports hasInput=false.
  liveInputRef.current = 'lnbc1';
  rerender({ visible: true, permission: granted, hasInput: false });
  expect(result.current.inputMode).toBe('paste');
});

it('does not switch a closed sheet; the next open picks Scan from the resolved state', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  rerender({ visible: false, permission: null });
  rerender({ visible: false, permission: granted });
  expect(result.current.inputMode).toBe('paste');
  rerender({ visible: true, permission: granted });
  expect(result.current.inputMode).toBe('scan');
});

it('only reacts to the first resolution after an open (no flip-flop on later changes)', () => {
  const { result, rerender } = setup({ visible: true, permission: null });
  rerender({ visible: true, permission: granted });
  act(() => result.current.selectInputMode('paste'));
  rerender({ visible: true, permission: denied });
  rerender({ visible: true, permission: granted });
  expect(result.current.inputMode).toBe('paste');
});

it('opens on an explicitly preferred tab (widget Scan button) whatever the permission', () => {
  for (const permission of [null, denied, granted]) {
    const { result, rerender } = setup({ visible: true, permission, preferred: 'scan' });
    expect(result.current.inputMode).toBe('scan');
    // A later resolution doesn't move it off the requested tab.
    rerender({ visible: true, permission: denied, preferred: 'scan' });
    expect(result.current.inputMode).toBe('scan');
  }
});
