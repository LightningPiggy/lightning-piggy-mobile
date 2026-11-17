import React from 'react';
import { Appearance } from 'react-native';
import { darkPalette, lightPalette } from '../styles/palettes';
import { act, renderHook, waitFor, render, fireEvent } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider, useTheme } from './ThemeContext';
import OutgoingBubbleStyleSection from '../components/OutgoingBubbleStyleSection';
import { outgoingBubblePalettes } from '../styles/outgoingBubblePalettes';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('defaults outgoing bubbles to A and persists a palette change', async () => {
  const { result } = renderHook(useTheme, { wrapper });
  await act(async () => {});
  expect(result.current.outgoingBubbleStyle).toBe('A');
  expect(result.current.colors.outgoingBubble).toEqual(outgoingBubblePalettes.A);
  act(() => result.current.setOutgoingBubbleStyle('B'));
  expect(result.current.colors.outgoingBubble).toEqual(outgoingBubblePalettes.B);
  expect(await AsyncStorage.getItem('app_outgoing_bubble_style')).toBe('B');
});

test.each(['B', 'C'] as const)('restores saved palette %s', async (style) => {
  await AsyncStorage.setItem('app_outgoing_bubble_style', style);
  const { result } = renderHook(useTheme, { wrapper });
  await waitFor(() => expect(result.current.outgoingBubbleStyle).toBe(style));
  expect(result.current.colors.outgoingBubble).toEqual(outgoingBubblePalettes[style]);
});

test('invalid saved palette safely falls back to A', async () => {
  await AsyncStorage.setItem('app_outgoing_bubble_style', 'bogus');
  const { result } = renderHook(useTheme, { wrapper });
  await act(async () => {});
  expect(result.current.outgoingBubbleStyle).toBe('A');
});

jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));

test('Advanced developer selector switches the persisted palette between A, B and C', async () => {
  const ui = render(
    <ThemeProvider>
      <OutgoingBubbleStyleSection />
    </ThemeProvider>,
  );
  await act(async () => {});
  for (const style of ['B', 'C', 'A']) {
    fireEvent.press(ui.getByTestId(`advanced-bubble-style-${style}`));
    expect(ui.getByTestId(`advanced-bubble-style-${style}`).props.accessibilityState.selected).toBe(
      true,
    );
    expect(await AsyncStorage.getItem('app_outgoing_bubble_style')).toBe(style);
  }
});

test.each(['dark', 'light', null] as const)(
  'system preference resolves OS appearance %s on mount',
  async (colorScheme) => {
    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue(colorScheme);
    const { result } = renderHook(useTheme, { wrapper });
    await act(async () => {});
    expect(result.current.preference).toBe('system');
    expect(result.current.scheme).toBe(colorScheme === 'dark' ? 'dark' : 'light');
    expect(result.current.colors.surface).toBe(
      colorScheme === 'dark' ? darkPalette.surface : lightPalette.surface,
    );
  },
);

test('system follows live appearance changes and removes its listener on unmount', async () => {
  jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
  const remove = jest.fn();
  const subscribe = jest.spyOn(Appearance, 'addChangeListener').mockReturnValue({ remove });
  const { result, unmount } = renderHook(useTheme, { wrapper });
  await act(async () => {});
  const onChange = subscribe.mock.calls[0][0];
  act(() => onChange({ colorScheme: 'dark' }));
  expect(result.current.scheme).toBe('dark');
  expect(result.current.colors.surface).toBe(darkPalette.surface);
  act(() => onChange({ colorScheme: 'light' }));
  expect(result.current.scheme).toBe('light');
  act(() => onChange({ colorScheme: null }));
  expect(result.current.scheme).toBe('light');
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

test.each(['light', 'dark'] as const)(
  'saved %s preference ignores OS changes until System is selected',
  async (preference) => {
    await AsyncStorage.setItem('app_theme_preference', preference);
    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
    const subscribe = jest
      .spyOn(Appearance, 'addChangeListener')
      .mockReturnValue({ remove: jest.fn() });
    const { result } = renderHook(useTheme, { wrapper });
    await waitFor(() => expect(result.current.preference).toBe(preference));
    const onChange = subscribe.mock.calls[0][0];
    act(() => onChange({ colorScheme: 'dark' }));
    act(() => onChange({ colorScheme: 'light' }));
    expect(result.current.scheme).toBe(preference);
    act(() => onChange({ colorScheme: 'dark' }));
    expect(result.current.scheme).toBe(preference);
    act(() => result.current.setPreference('system'));
    expect(result.current.scheme).toBe('dark');
    expect(await AsyncStorage.getItem('app_theme_preference')).toBe('system');
  },
);
