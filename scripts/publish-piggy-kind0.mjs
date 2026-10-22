#!/usr/bin/env node
// Publishes (or refreshes) the kind-0 profile metadata for each Piggy
// test-fixture identity. Sets `picture` to the tinted piggy avatar
// hosted in this repo and `lud16` to the per-Piggy lud16 so test flows
// can pay each Piggy independently and observe their wallet balance in
// isolation. Other existing kind-0 fields (name, display_name, about,
// banner, nip05, etc.) are fetched from DEFAULT_RELAYS and merged so
// we don't clobber them.
//
// Usage:
//   node scripts/publish-piggy-kind0.mjs                       # publish all four
//   node scripts/publish-piggy-kind0.mjs MAESTRO_NSEC_LITTLE   # publish one
//   BRANCH=main node scripts/publish-piggy-kind0.mjs           # override raw URL branch
//
// Re-run this script whenever a Piggy's kind-0 picture or lud16 needs
// refreshing (e.g. after the tinted PNGs change, the dedicated LNbits
// wallets change, or a relay drops the event).
//
// Never logs the nsec. Reads each MAESTRO_NSEC_* from .env.

import { readFileSync, existsSync } from 'node:fs';
import { argv, exit, env } from 'node:process';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';

// Mirror src/services/nostrService.ts → DEFAULT_RELAYS so we publish to
// the same relays the app reads from.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const BRANCH = env.BRANCH || 'main';
const RAW_BASE = `https://raw.githubusercontent.com/LightningPiggy/lightning-piggy-mobile/${BRANCH}/.maestro/fixtures`;

// Each Piggy maps to (env var, fixture filename, friendly label, lud16).
// `lud16` resolves to a dedicated LNbits wallet on the LNbits server named
// by PIGGY_LUD16_DOMAIN in .env (kept out of the repo)
// so each Piggy is independently payable in test flows and the per-
// wallet balance is observable in isolation. Evil Piggy keeps the
// shared fallback because it doesn't need its own wallet for the
// scenarios it covers (unfollowed-sender / Following-only toggle).
// Label is only used for log lines — we never overwrite an existing
// `name` / `display_name` on the kind-0 if it's already published.
// Banners are farmyard scenes (1500x500 crops, fit the ProfileScreen
// banner slot after `resizeMode: 'cover'`) re-hosted to Blossom
// (blossom.primal.net) — content-addressed + signed by each Piggy's own
// nsec, so they don't depend on a third-party hotlink staying alive.
// Re-host via the BUD-02 upload flow if a blob ever 404s.
const PIGGIES = [
  // Mapping matches .maestro/README.adoc — note NSEC2=Little, NSEC3=Middle.
  {
    envVar: 'MAESTRO_NSEC_BIG',
    file: 'big-piggy-profile.png',
    label: 'Big Piggy',
    lud16User: 'big.piggy',
    about: 'The biggest of the Piggies. Saves more than she spends.',
    bannerUrl:
      'https://blossom.primal.net/e4541a2c43c067cbe8977a5a986cc507c19674b555cc3ce1a359c15453424348.jpg',
  },
  {
    envVar: 'MAESTRO_NSEC_LITTLE',
    file: 'little-piggy-profile.png',
    label: 'Little Piggy',
    lud16User: 'little.piggy',
    about: 'The littlest Piggy. Just learning about sats and zaps.',
    bannerUrl:
      'https://blossom.primal.net/78768018cf54486a7750ca8b16f49fc9a2ce69994b210938083ce37c99ab53ae.jpg',
  },
  {
    envVar: 'MAESTRO_NSEC_MIDDLE',
    file: 'middle-piggy-profile.png',
    label: 'Middle Piggy',
    lud16User: 'middle.piggy',
    about: 'The middle Piggy. Splits the difference between Big and Little.',
    bannerUrl:
      'https://blossom.primal.net/611658ea525b4484dd4e1a9fef5e86161b56f60bcb62d85965be58491e0d8bf6.jpg',
  },
  {
    envVar: 'MAESTRO_NSEC_EVIL',
    file: 'evil-piggy-profile.png',
    label: 'Evil Piggy',
    lud16User: 'ben.weeks',
    about: 'A mysterious unfriended Piggy. Used in test flows for the unfollowed-sender path.',
    bannerUrl:
      'https://blossom.primal.net/ad9421cf466eeaa51df1f084b0babe4318ebe0970efd6dfd8c3ddcf83ac12ef0.jpg',
  },
];

if (!existsSync('.env')) {
  console.error('No .env file in cwd — run from the repo root.');
  exit(1);
}
const envText = readFileSync('.env', 'utf8');
const LUD16_DOMAIN = envText
  .split('\n')
  .find((l) => l.startsWith('PIGGY_LUD16_DOMAIN='))
  ?.slice('PIGGY_LUD16_DOMAIN='.length)
  .trim();
if (!LUD16_DOMAIN) {
  console.error('Set PIGGY_LUD16_DOMAIN in .env (the LNbits host behind the Piggy lud16s).');
  exit(1);
}
function nsecFor(envVar) {
  const line = envText.split('\n').find((l) => l.startsWith(`${envVar}=`));
  if (!line) return null;
  return line.slice(envVar.length + 1).trim();
}

const onlyEnvVar = argv[2];
const targets = onlyEnvVar ? PIGGIES.filter((p) => p.envVar === onlyEnvVar) : PIGGIES;
if (onlyEnvVar && targets.length === 0) {
  console.error(
    `Unknown env var: ${onlyEnvVar}. Expected one of ${PIGGIES.map((p) => p.envVar).join(', ')}.`,
  );
  exit(1);
}

const pool = new SimplePool();

// Sentinel: distinguish "the relay query timed out" from "the relays
// confirmed there's no existing kind-0". Treating both as "no existing"
// (the previous behaviour) risks clobbering real metadata when a relay
// is just slow or unreachable.
const FETCH_TIMEOUT = Symbol('fetch-timeout');

async function fetchExistingKind0(pubkey) {
  try {
    const events = await Promise.race([
      pool.querySync(RELAYS, { kinds: [0], authors: [pubkey], limit: 5 }),
      new Promise((resolve) => setTimeout(() => resolve(FETCH_TIMEOUT), 8000)),
    ]);
    if (events === FETCH_TIMEOUT) return FETCH_TIMEOUT;
    if (!events || events.length === 0) return null;
    events.sort((a, b) => b.created_at - a.created_at);
    return events[0];
  } catch (err) {
    console.warn(`  fetch failed: ${err?.message || err}`);
    return FETCH_TIMEOUT;
  }
}

function parseContent(content) {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content);
    // typeof null === 'object' and Array.isArray covers `[]` — both would
    // produce a surprising spread (numeric keys / null bypass). Reject.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

let exitCode = 0;

for (const piggy of targets) {
  const { envVar, file, label, lud16User, about, bannerUrl } = piggy;
  const lud16 = `${lud16User}@${LUD16_DOMAIN}`;
  console.log(`\n=== ${label} (${envVar}) ===`);
  const nsec = nsecFor(envVar);
  if (!nsec) {
    console.error(`  ${envVar} not set in .env — skipping`);
    exitCode = 1;
    continue;
  }
  let secretKey;
  let pubkey;
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('not an nsec');
    secretKey = decoded.data;
    pubkey = getPublicKey(secretKey);
  } catch (err) {
    console.error(`  ${envVar} failed to decode: ${err?.message || err}`);
    exitCode = 1;
    continue;
  }
  console.log(`  pubkey: ${pubkey}`);
  console.log(`  npub:   ${nip19.npubEncode(pubkey)}`);

  const pictureUrl = `${RAW_BASE}/${file}`;
  console.log(`  picture: ${pictureUrl}`);
  console.log(`  banner:  ${bannerUrl}`);

  const existing = await fetchExistingKind0(pubkey);
  if (existing === FETCH_TIMEOUT) {
    console.error(
      `  ${label}: relay query timed out — refusing to publish (would risk clobbering existing metadata). Re-run when relays are healthy.`,
    );
    exitCode = 1;
    continue;
  }
  const existingContent = existing ? parseContent(existing.content) : {};
  if (existing) {
    console.log(
      `  existing kind-0 found (created_at=${existing.created_at}, fields=${Object.keys(existingContent).join(',') || '(empty)'})`,
    );
  } else {
    console.log(
      '  no existing kind-0 (relays confirmed empty) — seeding name + display_name from label',
    );
  }

  // Merge: keep everything, override picture + banner + lud16 + about
  // (per-piggy fixtures so the new Profile screen renders meaningful
  // content), fill in name/display_name only when the existing event
  // has nothing there.
  const merged = {
    ...existingContent,
    picture: pictureUrl,
    banner: bannerUrl,
    lud16,
    about,
  };
  if (!merged.name) merged.name = label;
  if (!merged.display_name) merged.display_name = label;

  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: existing?.tags || [],
      content: JSON.stringify(merged),
    },
    secretKey,
  );
  console.log(`  publishing kind-0 ${event.id}`);

  const results = await Promise.allSettled(pool.publish(RELAYS, event));
  let okCount = 0;
  for (let i = 0; i < RELAYS.length; i++) {
    const r = results[i];
    const ok = r.status === 'fulfilled';
    if (ok) okCount += 1;
    const detail = ok ? 'ok' : `failed: ${r.reason?.message || r.reason}`;
    console.log(`    ${RELAYS[i]} — ${detail}`);
  }
  if (okCount === 0) {
    console.error(`  ${label}: all relays rejected — flagging failure`);
    exitCode = 1;
  } else {
    console.log(`  ${label}: published to ${okCount}/${RELAYS.length} relays`);
  }
}

await new Promise((r) => setTimeout(r, 1500));
pool.close(RELAYS);
exit(exitCode);
