#!/usr/bin/env node
// Zapstore signer pre-flight (#1517). Runs on GitHub Actions only, before zsp.
//
// 1. Installs the stable NIP-46 client key where zsp looks for it
//    ($XDG_CONFIG_HOME/zsp/bunker-keys/<bunker pubkey>.key). Otherwise zsp
//    generates a new client key on every fresh runner, so the bunker sees an
//    unknown client and the bunker URI's one-time secret fails on the second
//    release.
// 2. Reuses an authorised client, or pairs it once, and refuses to continue
//    unless the bunker signs for the Lightning Piggy team account. zsp checks the
//    zapstore.yaml `pubkey` against local signers only, never against a bunker,
//    and whoever signs the first Zapstore release owns the listing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { getPublicKey } from 'nostr-tools/pure';

export const LP_TEAM_PUBKEY = '22818ec33d8078e64964b561c839b74433f2371552d7f5bd6ab0af325a79f429';
// Richard approves the first connection on his phone; ten minutes timed out
// twice for the release note, so allow 30.
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

const HEX_KEY = /^[0-9a-f]{64}$/;

export class PreflightError extends Error {}

// zsp only accepts a 64-character hex client key file.
export function parseClientKey(value, accountPubkey = LP_TEAM_PUBKEY) {
  const key = (value || '').trim().toLowerCase();
  if (!HEX_KEY.test(key))
    throw new PreflightError('ZAPSTORE_CLIENT_KEY must be 64 hex characters.');
  const bytes = Uint8Array.from(Buffer.from(key, 'hex'));
  if (getPublicKey(bytes) === accountPubkey) {
    throw new PreflightError(
      'ZAPSTORE_CLIENT_KEY must be a separate client key, not the account key.',
    );
  }
  return { hex: key, bytes };
}

// zsp names the key file after the bunker URI's host, verbatim.
export function bunkerHost(uri) {
  const match = /^bunker:\/\/([^/?#]+)/.exec(uri || '');
  if (!match || !HEX_KEY.test(match[1])) throw new PreflightError('Invalid bunker URI.');
  return match[1];
}

export function zspClientKeyPath(configDir, host) {
  return path.join(configDir, 'zsp', 'bunker-keys', `${host}.key`);
}

export function installClientKey(configDir, host, hex) {
  const file = zspClientKeyPath(configDir, host);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${hex}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

// Preserve all relay parameters, but never give zsp the consumed pairing token.
export function secretFreeBunkerUri(uri) {
  bunkerHost(uri);
  const url = new URL(uri);
  url.searchParams.delete('secret');
  return url.toString();
}

async function withTimeout(operation, timeoutMs, error) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(error), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifySigner(
  signer,
  {
    expectedPubkey = LP_TEAM_PUBKEY,
    timeoutMs = APPROVAL_TIMEOUT_MS,
    probeTimeoutMs = 10_000,
  } = {},
) {
  try {
    const pubkey = await withTimeout(
      async () => {
        // Existing clients must not resend a one-time secret: nsec.app ignores it.
        // A new client may be rejected or ignored until connect is approved.
        try {
          return await withTimeout(
            () => signer.getPublicKey(),
            Math.min(probeTimeoutMs, timeoutMs),
            new Error('Client is not yet authorised.'),
          );
        } catch {
          try {
            await signer.connect();
          } catch {
            // Some signers reply "already connected". Only get_public_key can
            // establish whether this client is authorised for the right account.
          }
          return signer.getPublicKey();
        }
      },
      timeoutMs,
      new PreflightError(
        `Bunker approval timed out after ${Math.round(timeoutMs / 60_000)} minutes. Approve the connection in the signer and re-run.`,
      ),
    );
    if (pubkey !== expectedPubkey) {
      throw new PreflightError(
        'The bunker signs for a different account, not Lightning Piggy. Publishing refused.',
      );
    }
    return pubkey;
  } finally {
    try {
      // close() can wait on a relay that never answers; don't hold the job open.
      await Promise.race([signer.close(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch {
      // Already closed.
    }
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_ENVIRONMENT) {
    throw new PreflightError('The Zapstore pre-flight runs only on a GitHub Actions runner.');
  }
  const uri = (process.env.ZAPSTORE_BUNKER_URI || '').trim();
  const configDir = process.env.XDG_CONFIG_HOME;
  if (!configDir) throw new PreflightError('XDG_CONFIG_HOME must be set.');
  if (!process.env.GITHUB_ENV) throw new PreflightError('GITHUB_ENV must be set.');
  const host = bunkerHost(uri);
  const pointer = await parseBunkerInput(uri);
  if (!pointer?.relays.length || pointer.pubkey !== host) {
    throw new PreflightError('Invalid bunker URI.');
  }
  // GitHub masks the whole secret, not its parts; mask the connection secret too.
  if (pointer.secret) console.log(`::add-mask::${pointer.secret}`);
  const key = parseClientKey(process.env.ZAPSTORE_CLIENT_KEY);
  installClientKey(configDir, host, key.hex);

  // Library diagnostics can include relay notices or signer auth URLs.
  console.debug = () => {};
  console.warn = () => {};
  const pool = new SimplePool();
  const signer = BunkerSigner.fromBunker(key.bytes, pointer, {
    pool,
    onauth: () => console.log('::notice::Approve the Zapstore connection in the signer.'),
  });
  console.log('Waiting up to 30 minutes for the bunker to approve the connection.');
  try {
    await verifySigner(signer);
  } finally {
    pool.destroy();
    key.bytes.fill(0);
  }
  // Publish inherits this value instead of reconnecting with the original secret.
  fs.appendFileSync(process.env.GITHUB_ENV, `SIGN_WITH=${secretFreeBunkerUri(uri)}\n`);
  console.log('Bunker signs for the Lightning Piggy team account.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      // Only our own messages are safe to print; library errors can carry secrets.
      console.error(
        `::error::${error instanceof PreflightError ? error.message : 'Could not reach the bunker. Check the signer is online and the connection still exists, then re-run.'}`,
      );
      process.exit(1);
    });
