import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import { verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';

export const RELAY_AUTH_TIMEOUT_MS = 15_000;
export interface RelayAuthAccount {
  pubkey: string;
  signerType: string;
  ownRelays: string[];
  sign: (event: EventTemplate) => Promise<Event | null>;
}
let account: RelayAuthAccount | null = null;
// Session decisions survive list refreshes and account switches, but never persist.
const remoteAttempts = new Map<
  string,
  {
    relay: AbstractRelay;
    challenge: string | undefined;
    connection: Promise<void> | undefined;
    result: Promise<void>;
  }
>();
const inFlight = new Map<
  string,
  { relay: AbstractRelay; pubkey: string | null; result: Promise<void> }
>();
const authenticatedAs = new WeakMap<AbstractRelay, string>();
// nostr-tools caches AUTH across accounts on a shared socket. Its runtime fields
// are private in the types; keep this compatibility seam here (SDK 2.23).
function authState(relay: AbstractRelay) {
  return relay as unknown as {
    challenge?: string;
    authPromise?: Promise<string>;
    connectionPromise?: Promise<void>;
    ws?: WebSocket;
    openEventPublishes: Map<
      string,
      { reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
    >;
  };
}

/** SDK auth() ignores send() rejections. Keep its OK waiter/drain tracking,
 * but send AUTH on the captured socket and settle failures without payloads. */
async function sendAuth(
  relay: AbstractRelay,
  signed: VerifiedEvent,
  current: () => boolean,
): Promise<void> {
  const originalSend = relay.send;
  const safeSend: AbstractRelay['send'] = async (message) => {
    if (!message.startsWith('["AUTH",')) return originalSend.call(relay, message);
    try {
      const socket = authState(relay).ws;
      if (!current() || !socket || socket.readyState !== 1)
        throw new Error('auth-required: originating socket disconnected');
      // SDK send() starts a detached connectionPromise.then(). A synchronous
      // socket send here lets us catch both throws and rejected test transports.
      await socket.send(message);
    } catch {
      const pending = authState(relay).openEventPublishes.get(signed.id);
      if (pending) {
        clearTimeout(pending.timeout);
        authState(relay).openEventPublishes.delete(signed.id);
        pending.reject(new Error('auth was required but sending authentication failed'));
      }
    }
  };
  relay.send = safeSend;
  try {
    await bounded(relay.auth(async () => signed));
  } finally {
    if (relay.send === safeSend) relay.send = originalSend;
  }
}

export function setRelayAuthAccount(next: RelayAuthAccount | null): void {
  account = next;
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timed out')), RELAY_AUTH_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        // Signer errors can contain the request. Never forward them to SDK logging.
        reject(new Error('auth was required but signing or authentication failed'));
      },
    );
  });
}

async function signOnSocket(
  owner: RelayAuthAccount,
  template: EventTemplate,
  socket: WebSocket | undefined,
): Promise<Event | null> {
  let disconnected!: () => void;
  const closed = new Promise<never>((_, reject) => {
    disconnected = () => reject(new Error('auth-required: originating socket disconnected'));
  });
  socket?.addEventListener?.('close', disconnected);
  try {
    return await bounded(Promise.race([owner.sign(template), closed]));
  } finally {
    socket?.removeEventListener?.('close', disconnected);
  }
}

/** Sign only on CLOSED auth-required, never on unsolicited relay challenges. */
export function authenticateRelay(relay: AbstractRelay): Promise<void> {
  const owner = account;
  const url = normalizeURL(relay.url);
  const pk = getCurrentUserPubkey();
  if (isTestRelayLockdown(pk) && url !== normalizeURL(TEST_RELAY_URL))
    return Promise.reject(new Error('auth-required: relay outside test lockdown'));
  if (!owner || owner.pubkey !== pk)
    return Promise.reject(new Error('auth-required: no active signer'));
  if (!relay.connected)
    return Promise.reject(new Error('auth-required: originating socket disconnected'));
  const key = `${pk}:${url}`;
  const pending = inFlight.get(url);
  if (pending)
    return pending.relay === relay && pending.pubkey === pk
      ? pending.result
      : Promise.reject(new Error('auth-required: another authentication is in flight'));
  const remote = owner.signerType !== 'nsec';
  if (remote && !owner.ownRelays.some((own) => normalizeURL(own) === url))
    return Promise.reject(new Error('auth-required: relay outside own inbox/read lists'));
  const previous = remoteAttempts.get(key);
  if (remote && previous) {
    // A new socket/challenge needs a new signature; never reuse an old AUTH event
    // or open the remote signer a second time this session.
    return previous.relay === relay &&
      previous.challenge === authState(relay).challenge &&
      previous.connection === authState(relay).connectionPromise
      ? previous.result.then(() => {
          if (authenticatedAs.get(relay) !== pk)
            throw new Error('auth-required: socket authenticated as another account');
        })
      : Promise.reject(new Error('auth-required: remote signer already asked this session'));
  }
  const current = () => getCurrentUserPubkey() === pk && account?.pubkey === pk;
  const result = (async () => {
    const connection = authState(relay).connectionPromise;
    const socket = authState(relay).ws;
    const connected = () =>
      relay.connected &&
      !!connection &&
      authState(relay).connectionPromise === connection &&
      authState(relay).ws === socket;
    if (!connected()) throw new Error('auth-required: originating socket disconnected');
    const challenge = authState(relay).challenge;
    if (!challenge) throw new Error('auth-required: no challenge');
    const template: EventTemplate = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['relay', relay.url],
        ['challenge', challenge],
      ],
      content: '',
    };
    const expectedTags = JSON.stringify(template.tags);
    const expectedTime = template.created_at;
    // Sign before SDK auth(): its async executor swallows signer rejection.
    const signed = await signOnSocket(owner, template, socket);
    if (!connected()) throw new Error('auth-required: originating socket disconnected');
    if (!signed || !current() || authState(relay).challenge !== challenge || signed.pubkey !== pk)
      throw new Error('auth-required: signing declined or account/challenge changed');
    if (
      signed.kind !== template.kind ||
      signed.content !== '' ||
      JSON.stringify(signed.tags) !== expectedTags ||
      signed.created_at !== expectedTime ||
      !verifyEvent(signed)
    )
      throw new Error('auth-required: invalid signed event');
    authState(relay).authPromise = undefined;
    await sendAuth(
      relay,
      signed,
      () => current() && connected() && authState(relay).challenge === challenge,
    );
    if (!current() || !connected()) throw new Error('auth-required: account or socket changed');
    authenticatedAs.set(relay, pk!);
  })();
  inFlight.set(url, { relay, pubkey: pk, result });
  if (remote)
    remoteAttempts.set(key, {
      relay,
      challenge: authState(relay).challenge,
      connection: authState(relay).connectionPromise,
      result,
    });
  void result.then(
    () => inFlight.delete(url),
    () => inFlight.delete(url),
  );
  return result;
}
