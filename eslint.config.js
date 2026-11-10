const { FlatCompat } = require('@eslint/eslintrc');
const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

const compat = new FlatCompat();

module.exports = [
  {
    ignores: ['node_modules/**', '.expo/**', 'babel.config.js', 'eslint.config.js'],
  },
  ...compat.extends('expo', 'prettier'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // SDK 58 enables compiler-adoption rules; keep this upgrade scoped to
      // API compatibility. React Compiler is not enabled for this app.
      'react-hooks/globals': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',

      // Force toasts to flow through the brand-themed wrapper. Direct
      // imports of `react-native-toast-message` bypass the pink / blue
      // accent + rounded-corner styling configured in BrandedToast.tsx.
      // The wrapper itself is the only legitimate consumer; an override
      // block below opens a hole specifically for that file.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native-toast-message',
              message:
                "Import Toast from 'src/components/BrandedToast' instead — keeps the on-brand pink/blue toast styling consistent across the app.",
            },
          ],
        },
      ],
    },
  },
  {
    // BrandedToast wraps `react-native-toast-message` and MUST be allowed
    // to import it directly. Re-declare the restriction as 'off' for this
    // single file to punch a hole in the global rule above.
    files: ['src/components/BrandedToast.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Standalone Node ESM helpers under scripts/ run in Node, not in the
    // React Native runtime, so give them access to Node globals like
    // setTimeout and process. The Expo lint rules around process.env
    // (no-dynamic-env-var, no-env-var-destructuring) exist to keep Metro
    // able to inline EXPO_PUBLIC_* at bundle time — irrelevant for these
    // standalone CI helpers, so we turn them off here.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'expo/no-dynamic-env-var': 'off',
      'expo/no-env-var-destructuring': 'off',
    },
  },
  {
    // Jest setup/config files + co-located `*.test.ts(x)` run under
    // jest-expo, so allow the jest globals (`jest`, `expect`, etc.).
    files: [
      'jest.setup.js',
      'jest.config.js',
      '**/*.test.ts',
      '**/*.test.tsx',
      'tests/unit/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  {
    // Block React Native's native `Alert` outside BrandedAlert.tsx itself
    // so every alert renders through the in-app branded modal (matches
    // the app's pink/blue theme and is testable via Maestro). The
    // whitelist on BrandedAlert.tsx is defence-in-depth — that file
    // wraps RN's `Modal` and does not currently import `Alert` from
    // 'react-native', but a future re-export for parity testing would
    // legitimately need to. See CLAUDE.md → "Code Style".
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      'src/components/BrandedAlert.tsx',
      'src/components/BrandedSpinner.tsx',
      'src/components/BrandedRefreshControl.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Alert', 'ActivityIndicator', 'RefreshControl'],
              message:
                "Use BrandedAlert, BrandedSpinner or BrandedRefreshControl from src/components instead. Import via the relative path matching this file's location (e.g. '../components/BrandedAlert' from src/screens/, './BrandedAlert' from src/components/). See CLAUDE.md → Code Style.",
            },
            {
              // Lives in this src/** block (not a new one) because flat
              // config REPLACES a rule's options per matching block — a
              // separate block would silently drop the Alert restriction.
              // The wrapper itself opts out with an inline disable.
              name: '@gorhom/bottom-sheet',
              importNames: ['BottomSheetModal', 'default'],
              message:
                "Import BottomSheetModal from src/components/AccessibleBottomSheetModal instead — the library defaults sheet content to accessible={true}, which on iOS collapses the whole sheet into one 'Bottom Sheet' element that VoiceOver and Maestro can't see inside. See CLAUDE.md → Code Style.",
            },
          ],
        },
      ],
    },
  },
  {
    // Existing alert wrapper exception must still use branded loading indicators.
    files: ['src/components/BrandedAlert.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['ActivityIndicator', 'RefreshControl'],
              message:
                'Use BrandedSpinner or BrandedRefreshControl from src/components for theme-consistent loading indicators.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the two loading wrappers may import the native loading controls.
    files: ['src/components/BrandedSpinner.tsx', 'src/components/BrandedRefreshControl.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Alert'],
              message: 'Use BrandedAlert from src/components.',
            },
            {
              name: '@gorhom/bottom-sheet',
              importNames: ['BottomSheetModal', 'default'],
              message: 'Use AccessibleBottomSheetModal from src/components.',
            },
            {
              name: 'react-native-toast-message',
              message: 'Use BrandedToast from src/components.',
            },
          ],
        },
      ],
    },
  },
];
