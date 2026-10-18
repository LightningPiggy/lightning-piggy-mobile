// Making a stopped Marmot session inert, so sign-out can never hang on it and
// nothing it was waiting for can land after the account's data is wiped.
//
// A session may be mid key-package publish when the account signs out: an
// Amber / NIP-46 prompt nobody answers, or a slow relay. Sign-out waits for
// that work only for a bounded time; after that:
//  - the session's signer rejects (a late signer answer is discarded, so it
//    can never publish a key package for a signed-out account), and
//  - its storage is fenced (writes are dropped, so a late result can't
//    re-create a private key or record under the wiped account).

import type { EventSigner } from 'applesauce-core';

import type { MarmotKvBackend } from './marmotStore';

const stoppedError = () => new Error('marmot: session stopped');

export interface StopGate {
  readonly stopped: boolean;
  readonly fenced: boolean;
  /** Settle with `p`, unless the session stops first (or did meanwhile). */
  guard<T>(p: Promise<T> | T): Promise<T>;
  stop(): void;
  /** After this the session's storage drops every write. */
  fence(): void;
}

export function createStopGate(): StopGate {
  let stopped = false;
  let fenced = false;
  let reject!: (e: Error) => void;
  const onStop = new Promise<never>((_, r) => (reject = r));
  onStop.catch(() => undefined);
  return {
    get stopped() {
      return stopped;
    },
    get fenced() {
      return fenced;
    },
    guard<T>(p: Promise<T> | T): Promise<T> {
      if (stopped) return Promise.reject(stoppedError());
      return Promise.race([Promise.resolve(p), onStop]).then((value) => {
        if (stopped) throw stoppedError();
        return value;
      });
    },
    stop() {
      stopped = true;
      reject(stoppedError());
    },
    fence() {
      stopped = true;
      fenced = true;
      reject(stoppedError());
    },
  };
}

/** `signer`, but every request is abandoned once the session stops. */
export function fenceSigner(signer: EventSigner, gate: StopGate): EventSigner {
  const nip44 = signer.nip44;
  return {
    ...signer,
    signEvent: (draft) => gate.guard(signer.signEvent(draft)),
    nip44: nip44 && {
      encrypt: (pk, plaintext) => gate.guard(nip44.encrypt(pk, plaintext)),
      decrypt: (pk, ciphertext) => gate.guard(nip44.decrypt(pk, ciphertext)),
    },
  };
}

/** `backend`, but writes are dropped once the gate is fenced. */
export function fenceBackend(backend: MarmotKvBackend, gate: StopGate): MarmotKvBackend {
  return {
    owner: backend.owner,
    get: (ns, key) => backend.get(ns, key),
    keys: (ns) => backend.keys(ns),
    remove: async (ns, key) => {
      if (!gate.fenced) await backend.remove(ns, key);
    },
    clear: async (ns) => {
      if (!gate.fenced) await backend.clear(ns);
    },
    set: async (ns, key, value) => {
      if (!gate.fenced) await backend.set(ns, key, value);
    },
  };
}

/** Resolves once `p` settles or `ms` have passed, whichever is first. */
export function settleWithin(p: Promise<unknown> | null | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// Every stopped session per account, kept until that account's wipe fences
// it. Not just ones with tracked work pending: an untracked late operation (a
// Welcome join, dropping an unsent edit's history entry) may still reach the
// backend, so a session is only safe to forget once it is fenced. A gate is a
// few closures, and sign-out clears the account's entry.
const lingering = new Map<string, Set<StopGate>>();

/** Remember a stopped session until `owner`'s sign-out fences it. */
export function trackStoppedSession(owner: string, gate: StopGate): void {
  const gates = lingering.get(owner) ?? new Set<StopGate>();
  gates.add(gate);
  lingering.set(owner, gates);
}

/** Before wiping `owner`: fence every stopped session of that account. */
export function fenceStoppedSessions(owner: string): void {
  for (const gate of lingering.get(owner) ?? []) gate.fence();
  lingering.delete(owner);
}
