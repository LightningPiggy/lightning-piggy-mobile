/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

const { parse } = require('yaml');
const picomatch = require('picomatch');
const workflow = parse(fs.readFileSync(path.join(__dirname, 'ci.yml'), 'utf8'));
const filter = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'filter');
const matchesNative = picomatch(parse(filter.with.filters).native);

describe('native CI input coverage', () => {
  test.each([
    'scripts/ios-tests/NostrEngineFixtures.swift',
    'scripts/ios-tests/NostrEngineLifecycle.swift',
    'scripts/download-sdk-artifact.mjs',
    'scripts/download-sdk-artifact.test.mjs',
    'scripts/fetch-nostr-sdk-swift.mjs',
    'scripts/fetch-nostr-sdk-swift.test.mjs',
    'scripts/native-sdk-manifest.mjs',
    'scripts/native-sdk-manifest.test.mjs',
    'scripts/check-elf-alignment.sh',
    'scripts/check-elf-alignment.test.mjs',
    'vendor/native-sdk.tgz',
    'targets/widget/WalletWidget.swift',
    'targets/widget/expo-target.config.js',
    'src/widgets/walletSelectionCases.json',
    'scripts/ios-tests/WidgetLogicTests.swift',
    'assets/icon.png',
    'google-services.json',
    '.npmrc',
    '.nvmrc',
    'index.ts',
    'App.tsx',
  ])('%s triggers native validation', (file) => {
    expect(matchesNative(file)).toBe(true);
  });

  test.each(['src/screens/WalletScreen.tsx', 'docs/README.md'])(
    '%s keeps the fast PR path',
    (file) => {
      expect(matchesNative(file)).toBe(false);
    },
  );
});
