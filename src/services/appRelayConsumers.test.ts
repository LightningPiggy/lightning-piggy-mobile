import { GC_RELAYS } from './geocacheRelays';
import { withGcRelays } from './nostrPlacesPublisher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { forgetAppRelayPrefs, loadAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import { MARKET_RELAYS, marketSnapshotRelays } from '../utils/marketListingsQuery';
import { RELAY_LIST_INDEXERS, relayListPublishTargets } from '../utils/relayListEvents';
import { MARMOT_KEY_PACKAGE_RELAYS, keyPackagePublishRelays } from './marmotKeyPackageRelays';
import { mergeRelays } from './nostrRelayStorage';
import { appReadRelays } from './appReadRelays';
import { nip17TargetRelays } from './nip17RumorSend';
import { listingTargetRelays } from './listingRepublish';

const owner = 'a'.repeat(64);
beforeEach(async () => {
  setCurrentUserPubkey(owner);
  await forgetAppRelayPrefs(owner);
  await AsyncStorage.clear();
  await loadAppRelayPrefs(owner);
});
afterEach(() => setCurrentUserPubkey(null));
it('removes app defaults from merged foreground and wallet read relays, preserving explicit choices', async () => {
  const disabled = DEFAULT_RELAYS[0];
  await setAppRelayEnabled(owner, 'default', disabled, false);
  expect(mergeRelays({ nip65: [], user: [] }).map((r) => r.url)).not.toContain(disabled);
  expect(appReadRelays()).not.toContain(disabled);
  expect(
    mergeRelays({ nip65: [{ url: disabled, read: true, write: true }], user: [] }).map(
      (r) => r.url,
    ),
  ).toContain(disabled);
});
it('filters indexers from list publish destinations without replacing an empty group', async () => {
  for (const url of RELAY_LIST_INDEXERS) await setAppRelayEnabled(owner, 'indexers', url, false);
  expect(relayListPublishTargets([], [])).toEqual([]);
  expect(relayListPublishTargets(['wss://personal.example'], [])).toEqual([
    'wss://personal.example',
  ]);
});
it('filters marketplace discovery and republish destinations', async () => {
  for (const url of MARKET_RELAYS) await setAppRelayEnabled(owner, 'market', url, false);
  expect(marketSnapshotRelays([]).urls).toEqual([]);
  expect(listingTargetRelays(owner, [])).toEqual([]);
  expect(listingTargetRelays(owner, [{ url: MARKET_RELAYS[0], write: true }])).toEqual([
    MARKET_RELAYS[0],
  ]);
});
it('filters Marmot well-known relays while retaining explicit account relays', async () => {
  for (const url of MARMOT_KEY_PACKAGE_RELAYS)
    await setAppRelayEnabled(owner, 'marmot', url, false);
  expect(keyPackagePublishRelays(owner, [])).toEqual([]);
  expect(keyPackagePublishRelays(owner, ['wss://personal.example'])).toEqual([
    'wss://personal.example',
  ]);
});

it('filters the geo-cache backbone for read and publish helpers', async () => {
  for (const url of GC_RELAYS) await setAppRelayEnabled(owner, 'geocache', url, false);
  expect(withGcRelays()).toEqual([]);
  expect(withGcRelays(['wss://personal.example'])).toEqual(['wss://personal.example']);
});

/** Every consumer, including geo-cache read/write entry points, must filter at use time. */
it('guards every source-constant consumer against bypassing per-account preferences', () => {
  const names = new Set([
    'DEFAULT_RELAYS',
    'DEFAULT_NOSTR_RELAYS',
    'RELAY_LIST_INDEXERS',
    'GC_RELAYS',
    'MARMOT_KEY_PACKAGE_RELAYS',
    'MARKET_RELAYS',
  ]);
  const violations: string[] = [];
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(file);
        continue;
      }
      if (
        !/\.tsx?$/.test(file) ||
        /\.test\./.test(file) ||
        file.endsWith('/AdvancedRelaysSection.tsx') ||
        file.endsWith('/relayPublishSummary.ts')
      )
        continue;
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        if (ts.isIdentifier(node) && names.has(node.text)) {
          let parent: ts.Node | undefined = node.parent;
          if (ts.isVariableDeclaration(parent) && parent.name === node) return;
          while (parent) {
            if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return;
            if (
              ts.isCallExpression(parent) &&
              parent.expression.getText(source) === 'enabledAppRelays'
            )
              return;
            parent = parent.parent;
          }
          violations.push(
            `${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(path.join(process.cwd(), 'src'));
  expect(violations).toEqual([]);
});

it('binds marketplace and NIP-17 defaults to the caller after the active account changes', async () => {
  const other = 'b'.repeat(64);
  await loadAppRelayPrefs(other);
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], false);
  await setAppRelayEnabled(owner, 'market', MARKET_RELAYS[0], false);
  setCurrentUserPubkey(other);
  expect(nip17TargetRelays([], owner)).not.toContain(DEFAULT_RELAYS[0]);
  expect(nip17TargetRelays([], other)).toContain(DEFAULT_RELAYS[0]);
  expect(listingTargetRelays(owner, [])).not.toContain(MARKET_RELAYS[0]);
  expect(listingTargetRelays(other, [])).toContain(MARKET_RELAYS[0]);
  await forgetAppRelayPrefs(other);
});
