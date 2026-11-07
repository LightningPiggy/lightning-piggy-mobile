/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { nip19 } from 'nostr-tools';

const root = path.join(__dirname, '../..');
const listing = parse(fs.readFileSync(path.join(root, 'zapstore.yaml'), 'utf8'));
const workflow = parse(fs.readFileSync(path.join(__dirname, 'release-zapstore.yml'), 'utf8'));
const steps: { name?: string; run?: string; env?: Record<string, string> }[] =
  workflow.jobs.publish.steps;
const LP_TEAM_PUBKEY = '22818ec33d8078e64964b561c839b74433f2371552d7f5bd6ab0af325a79f429';

describe('zapstore.yaml', () => {
  test('is signed for the Lightning Piggy team account', () => {
    expect(nip19.decode(listing.pubkey)).toEqual({ type: 'npub', data: LP_TEAM_PUBKEY });
    const preflight = fs.readFileSync(
      path.join(root, 'scripts/zapstore-signer-preflight.mjs'),
      'utf8',
    );
    expect(preflight).toContain(`'${LP_TEAM_PUBKEY}'`);
  });

  test('icon and screenshots exist (a broken path fails the release)', () => {
    for (const file of [listing.icon, ...listing.images]) {
      expect(file).toMatch(/^\.\//);
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }
  });

  test('selects the release workflow APK', () => {
    const match = new RegExp(listing.match);
    expect(match.test('lightning-piggy-v1.5.2.apk')).toBe(true);
    expect(match.test('TECHNICAL_SOLUTION_DOCUMENT.pdf')).toBe(false);
    expect(match.test('lightning-piggy-v1.5.2-rc1.apk')).toBe(false);
  });

  test('leaves release_filter to the workflow, and never says "LP" to users', () => {
    expect(listing.release_filter).toBeUndefined();
    for (const text of [listing.name, listing.summary, listing.description]) {
      expect(text).not.toMatch(/\bLP\b/);
    }
  });
});

test('the workflow pins zsp to the tag being published', () => {
  const pin = steps.find((step) => step.name === 'Pin the release tag');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapstore-pin-'));
  try {
    fs.copyFileSync(path.join(root, 'zapstore.yaml'), path.join(dir, 'zapstore.yaml'));
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', pin!.run!], {
      cwd: dir,
      env: { ...process.env, TAG: 'v1.5.2' },
      stdio: 'pipe',
    });
    const pinned = parse(fs.readFileSync(path.join(dir, '.zapstore-ci.yaml'), 'utf8'));
    expect(pinned.release_filter).toBe('^v1\\.5\\.2$');
    expect(new RegExp(pinned.release_filter).test('v1.5.2')).toBe(true);
    expect(new RegExp(pinned.release_filter).test('v1x5x2')).toBe(false);
    expect({ ...pinned, release_filter: undefined }).toEqual({
      ...listing,
      release_filter: undefined,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishing inherits the verified, secret-free URI from the pre-flight', () => {
  const preflight = steps.find(
    (step) => step.name === 'Pair client key and verify the signer account',
  );
  const publish = steps.find((step) => step.name === 'Publish to Zapstore');
  expect(steps.indexOf(preflight!)).toBeLessThan(steps.indexOf(publish!));
  expect(preflight!.env!.XDG_CONFIG_HOME).toBe(publish!.env!.XDG_CONFIG_HOME);
  expect(publish!.env).not.toHaveProperty('SIGN_WITH');
  expect(preflight!.run).toBe('node scripts/zapstore-signer-preflight.mjs');
});
