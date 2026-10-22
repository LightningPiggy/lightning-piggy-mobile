// Adapts the app's three signer backends (nsec / Amber / NIP-46) to the
// applesauce `EventSigner` shape marmot-ts expects.
//
// marmot-ts only needs the user's Nostr key for a handful of operations —
// signing key packages (kind 30443) + their account-identity proof, and
// sealing gift-wrapped Welcomes (NIP-44 encrypt + sign kind 13). MLS group
// traffic (kind 445) is signed with per-message ephemeral keys inside the
// library, so remote signers are NOT prompted per chat message.
//
// Calls are serialised through one queue: Amber's native module rejects
// concurrent Intents with `BUSY`, and marmot-ts can fan out (e.g. inviting
// several members seals several Welcomes).

import * as SecureStore from 'expo-secure-store';
import type { EventSigner } from 'applesauce-core';

import { NSEC_KEY } from '../contexts/nostrAuthKeys';
import type { SignerType } from '../types/nostr';
import * as amberService from './amberService';
import { AmberSignerError } from './amberErrors';
import { markDmSetup } from './marmotDmSetupTrace';
import { nip44DecryptFrom, nip44EncryptForRecipient } from './nostrCrypto';
import * as nostrConnectService from './nostrConnectService';
import * as nostrService from './nostrService';

type Draft = Parameters<EventSigner['signEvent']>[0];
type Signed = Awaited<ReturnType<EventSigner['signEvent']>>;

/** Runs async tasks strictly one at a time, in submission order. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function loadSecretKey(): Promise<Uint8Array> {
  const nsec = await SecureStore.getItemAsync(NSEC_KEY);
  if (!nsec) throw new Error('marmot signer: no nsec stored');
  return nostrService.decodeNsec(nsec).secretKey;
}

/** The unsigned template a remote signer should sign (no id/sig). */
const toTemplate = (draft: Draft, pubkey: string) => ({
  kind: draft.kind,
  created_at: draft.created_at,
  tags: draft.tags,
  content: draft.content,
  pubkey,
});

// ONE queue for every signer instance (each Marmot session, the notification
// watcher's registrations): Amber rejects an intent while another is open.
const enqueue = createSerialQueue();

const ABANDON_POLL_MS = 250;

/**
 * Longest one Amber request may hold the shared queue (#1658). Every Marmot
 * signer call waits behind it, and the native module evicts a stale request
 * only when ANOTHER one launches, which this queue never lets happen, so an
 * unanswered approval used to block every later invite / Welcome for good.
 * Past this it rejects as "no response" and the queue moves on; the next
 * launch then either works or gets BUSY. It never hangs.
 */
export const AMBER_REQUEST_TIMEOUT_MS = 120_000;

/** When the Amber request at the front of the queue started, or null. */
let amberOpenSince: number | null = null;
export const amberRequestOpenSince = (): number | null => amberOpenSince;

/** An Amber answer faster than this almost certainly came from its silent
 * ContentResolver path (no approval sheet); slower ones from an Intent. */
const AMBER_SILENT_GUESS_MS = 1_500;

function withAmberDeadline<T>(task: () => Promise<T>, op: string): Promise<T> {
  const startedAt = Date.now();
  amberOpenSince = startedAt;
  markDmSetup(`amber ${op} start`);
  const settled = (outcome: string) => {
    const ms = Date.now() - startedAt;
    const path = ms < AMBER_SILENT_GUESS_MS ? 'silent?' : 'intent?';
    markDmSetup(`amber ${op} ${outcome} ${ms}ms ${path}`);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AmberSignerError('NO_RESULT', 'no-response', 'Amber did not answer in time (marmot)'),
        ),
      AMBER_REQUEST_TIMEOUT_MS,
    );
  });
  return Promise.race([task(), deadline])
    .then(
      (value) => (settled('ok'), value),
      (e: unknown) => {
        settled((e as { code?: string })?.code ?? 'error');
        throw e;
      },
    )
    .finally(() => {
      clearTimeout(timer);
      if (amberOpenSince === startedAt) amberOpenSince = null;
    });
}

/** Settle with `p`, or reject as soon as `cancelled()` turns true — so an
 * abandoned request gives the shared queue back instead of holding it until
 * a remote signer that may never answer (an offline NIP-46 bunker) does. */
function abandonable<T>(p: Promise<T>, cancelled: () => boolean): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (cancelled()) reject(new Error('marmot signer: request abandoned'));
    }, ABANDON_POLL_MS);
  });
  return Promise.race([p, gaveUp]).finally(() => clearInterval(timer));
}

/**
 * `opts.cancelled` is checked when a queued request reaches the front, right
 * before the backend (an Amber / NIP-46 prompt) is asked — so a request whose
 * caller has moved on (e.g. an account that signed out) never prompts — and
 * while it is open, so abandoning it frees the queue for everyone else.
 */
export function createMarmotSigner(
  pubkey: string,
  signerType: SignerType,
  opts: { cancelled?: () => boolean } = {},
): EventSigner {
  const { cancelled } = opts;
  const run = <T>(rawTask: () => Promise<T>, op = 'request'): Promise<T> => {
    const task = signerType === 'amber' ? () => withAmberDeadline(rawTask, op) : rawTask;
    if (!cancelled) return enqueue(task);
    return new Promise<T>((resolve, reject) => {
      void enqueue(async () => {
        if (cancelled()) {
          reject(new Error('marmot signer: request abandoned'));
          return;
        }
        const request = task();
        const forCaller = abandonable(request, cancelled);
        forCaller.then(resolve, reject);
        // The caller hears "abandoned" at once, but the queue is only given
        // back when the backend is free again: Amber's intent stays open until
        // the user answers it (the next one would fail with BUSY) or until
        // AMBER_REQUEST_TIMEOUT_MS, whereas a NIP-46 request may never settle
        // (offline bunker).
        await (signerType === 'amber' ? request : forCaller).catch(() => undefined);
      });
    });
  };
  const parseSigned = (json: string | null | undefined, who: string): Signed => {
    if (!json) throw new Error(`marmot signer: ${who} returned no signed event`);
    return JSON.parse(json) as Signed;
  };

  const signEvent = (draft: Draft): Promise<Signed> =>
    run(async () => {
      const template = toTemplate(draft, pubkey);
      switch (signerType) {
        case 'nsec':
          return nostrService.signEvent(template, await loadSecretKey()) as Signed;
        case 'amber': {
          // Keep pubkey on the template — Amber misroutes sign_event Intents
          // without it (#356).
          const { event } = await amberService.requestEventSignature(
            JSON.stringify(template),
            '',
            pubkey,
          );
          return parseSigned(event, 'Amber');
        }
        case 'nip46': {
          const { event } = await nostrConnectService.requestEventSignature(
            JSON.stringify(template),
            '',
            pubkey,
          );
          return parseSigned(event, 'NIP-46 signer');
        }
      }
    }, `sign:${draft.kind}`);

  const nip44 = {
    encrypt: (peer: string, plaintext: string) =>
      run(async () => {
        switch (signerType) {
          case 'nsec':
            return nip44EncryptForRecipient(plaintext, await loadSecretKey(), peer);
          case 'amber':
            return amberService.requestNip44Encrypt(plaintext, peer, pubkey);
          case 'nip46':
            return nostrConnectService.requestNip44Encrypt(plaintext, peer, pubkey);
        }
      }, 'nip44_encrypt'),
    decrypt: (peer: string, ciphertext: string) =>
      run(async () => {
        switch (signerType) {
          case 'nsec':
            return nip44DecryptFrom(ciphertext, await loadSecretKey(), peer);
          case 'amber':
            return amberService.requestNip44Decrypt(ciphertext, peer, pubkey);
          case 'nip46':
            return nostrConnectService.requestNip44Decrypt(ciphertext, peer, pubkey);
        }
      }, 'nip44_decrypt'),
  };

  return { getPublicKey: () => pubkey, signEvent, nip44 };
}
