import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render } from '@testing-library/react-native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { LinkActionSheetHost } from './LinkActionSheet';

// Deliberately uses the REAL @gorhom/bottom-sheet (only the Reanimated /
// Worklets native layer is mocked). The sibling LinkActionSheet.test.tsx mocks
// the whole library, which is how a host mounted outside
// BottomSheetModalProvider — an unconditional startup crash — slipped past
// three review rounds of #1506.
// Node has no UI runtime to decorate; skip gesture-handler's deferred native install.
jest.mock(
  'react-native-gesture-handler/lib/module/handlers/gestures/installUIRuntimeBindings',
  () => ({
    installUIRuntimeBindings: jest.fn(),
  }),
);
jest.mock('react-native-worklets', () =>
  jest.requireActual('react-native-worklets/lib/module/mock'),
);
// Reanimated 4.7's native initializer registers CSS events even with its JS
// mock. The Node test has no CSS/native runtime; retain the real sheet/provider.
jest.mock('react-native-reanimated/src/initializers', () => ({
  initializeReanimatedModule: jest.fn(),
}));
jest.mock('react-native-reanimated', () => jest.requireActual('react-native-reanimated/mock'));
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../styles/LinkActionSheet.styles', () => ({ createLinkActionSheetStyles: () => ({}) }));

it('needs BottomSheetModalProvider — the real modal throws without it', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<LinkActionSheetHost />)).toThrow(/BottomSheetModalInternalContext/);
  spy.mockRestore();
});

it('mounts inside BottomSheetModalProvider', () => {
  expect(() =>
    render(
      <BottomSheetModalProvider>
        <LinkActionSheetHost />
      </BottomSheetModalProvider>,
    ),
  ).not.toThrow();
});

it('App.tsx mounts the host inside its BottomSheetModalProvider', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const open = app.indexOf('<BottomSheetModalProvider>');
  const close = app.indexOf('</BottomSheetModalProvider>');
  const host = app.indexOf('<LinkActionSheetHost />');
  expect(open).toBeGreaterThan(-1);
  expect(host).toBeGreaterThan(open);
  expect(host).toBeLessThan(close);
});
