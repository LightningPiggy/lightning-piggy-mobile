import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  LP_TEAM_PUBKEY,
  bunkerHost,
  installClientKey,
  parseClientKey,
  secretFreeBunkerUri,
  verifySigner,
  zspClientKeyPath,
} from './zapstore-signer-preflight.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const BUNKER_PUBKEY = 'a'.repeat(64);

test('client key must be 64 hex characters and not the account key', () => {
  const secret = generateSecretKey();
  assert.equal(parseClientKey(` ${hex(secret).toUpperCase()}\n`).hex, hex(secret));
  assert.throws(() => parseClientKey('nsec1abc'), /64 hex characters/);
  assert.throws(() => parseClientKey(''), /64 hex characters/);
  assert.throws(
    () => parseClientKey(hex(secret), getPublicKey(secret)),
    /separate client key, not the account key/,
  );
});

test('bunker host is the remote-signer pubkey zsp names the key file after', () => {
  assert.equal(
    bunkerHost(`bunker://${BUNKER_PUBKEY}?relay=wss%3A%2F%2Frelay.example&secret=s`),
    BUNKER_PUBKEY,
  );
  for (const bad of ['', 'nostrconnect://x', 'bunker://ABC', `bunker://${'A'.repeat(64)}`]) {
    assert.throws(() => bunkerHost(bad), /Invalid bunker URI/);
  }
});

test('client key lands where zsp reads it, owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsp-config-'));
  try {
    const file = installClientKey(dir, BUNKER_PUBKEY, 'b'.repeat(64));
    // Mirrors zsp v0.4.17 internal/nostr/signer.go bunkerKeyPath().
    assert.equal(file, path.join(dir, 'zsp', 'bunker-keys', `${BUNKER_PUBKEY}.key`));
    assert.equal(file, zspClientKeyPath(dir, BUNKER_PUBKEY));
    assert.equal(fs.readFileSync(file, 'utf8'), `${'b'.repeat(64)}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSigner(pubkey, { hang = false } = {}) {
  return {
    closed: false,
    async connect() {
      if (hang) await new Promise(() => {});
    },
    async getPublicKey() {
      if (hang) await new Promise(() => {});
      return pubkey;
    },
    async close() {
      this.closed = true;
    },
  };
}

test('accepts only the Lightning Piggy team account, and always closes', async () => {
  const good = fakeSigner(LP_TEAM_PUBKEY);
  assert.equal(await verifySigner(good), LP_TEAM_PUBKEY);
  assert.equal(good.closed, true);

  const wrong = fakeSigner(getPublicKey(generateSecretKey()));
  await assert.rejects(verifySigner(wrong), /different account, not Lightning Piggy/);
  assert.equal(wrong.closed, true);
});

test('an unapproved connection times out with a clear message', async () => {
  const signer = fakeSigner(LP_TEAM_PUBKEY, { hang: true });
  await assert.rejects(verifySigner(signer, { timeoutMs: 20 }), /approval timed out/);
  assert.equal(signer.closed, true);
});

test('publish URI drops every secret while preserving the bunker and all relays', () => {
  const uri = `bunker://${BUNKER_PUBKEY}?relay=wss%3A%2F%2Fone.example&secret=one-time&relay=wss%3A%2F%2Ftwo.example&secret=duplicate`;
  const clean = new URL(secretFreeBunkerUri(uri));
  assert.equal(clean.host, BUNKER_PUBKEY);
  assert.equal(clean.searchParams.has('secret'), false);
  assert.deepEqual(clean.searchParams.getAll('relay'), ['wss://one.example', 'wss://two.example']);
  assert.equal(secretFreeBunkerUri(clean.toString()), clean.toString());
});

test('an authorised client never resends the consumed connect secret', async () => {
  const signer = fakeSigner(LP_TEAM_PUBKEY);
  signer.connect = async () => assert.fail('Must not reconnect an authorised client');
  assert.equal(await verifySigner(signer), LP_TEAM_PUBKEY);
  assert.equal(signer.closed, true);
});

for (const ignored of [false, true]) {
  test(`a new client pairs after a ${ignored ? 'silent' : 'rejected'} public-key probe`, async () => {
    const signer = fakeSigner(LP_TEAM_PUBKEY);
    let authorised = false;
    let connects = 0;
    signer.getPublicKey = async () => {
      if (authorised) return LP_TEAM_PUBKEY;
      if (ignored) return new Promise(() => {});
      throw new Error('Not authorised');
    };
    signer.connect = async () => {
      connects++;
      authorised = true;
    };
    assert.equal(await verifySigner(signer, { probeTimeoutMs: 5 }), LP_TEAM_PUBKEY);
    assert.equal(connects, 1);
    assert.equal(signer.closed, true);

    // A later runner reuses the same stable key; no second connect is sent.
    signer.closed = false;
    assert.equal(await verifySigner(signer), LP_TEAM_PUBKEY);
    assert.equal(connects, 1);
  });
}

for (const pubkey of [LP_TEAM_PUBKEY, 'b'.repeat(64)]) {
  test(`an already-connected response still checks the account (${pubkey === LP_TEAM_PUBKEY ? 'right' : 'wrong'})`, async () => {
    const signer = fakeSigner(pubkey);
    let probes = 0;
    signer.getPublicKey = async () => {
      if (probes++ === 0) throw new Error('Not yet ready');
      return pubkey;
    };
    signer.connect = async () => {
      throw new Error('already connected');
    };
    if (pubkey === LP_TEAM_PUBKEY) {
      assert.equal(await verifySigner(signer), LP_TEAM_PUBKEY);
    } else {
      await assert.rejects(verifySigner(signer), /different account, not Lightning Piggy/);
    }
    assert.equal(probes, 2);
    assert.equal(signer.closed, true);
  });
}

test('a rejected connection cannot bypass public-key authorisation', async () => {
  const signer = fakeSigner(LP_TEAM_PUBKEY);
  signer.connect = async () => {
    throw new Error('Connection denied');
  };
  signer.getPublicKey = async () => {
    throw new Error('Permission denied');
  };
  await assert.rejects(verifySigner(signer), /Permission denied/);
  assert.equal(signer.closed, true);
});
