import { sendSharedDm } from './sendSharedDm';
import { mergeConversationMessages, DM_CONV_CAP } from '../contexts/nostrDmCache';
import { NWC_SHARE_KIND } from '../utils/nwcShareMessage';
import { getEventHash } from 'nostr-tools';

import {
  MarmotNoKeyPackageError,
  MarmotUnusableKeyPackageError,
  setMarmotSession,
  type MarmotSession,
} from './marmotSession';
import {
  DM_SETUP_TIMEOUT_MS,
  marmotDelivery,
  sendMarmotDm,
  sendMarmotGroupRumor,
} from './marmotSend';
import { MarmotKeyPackageLookupError } from './marmotKeyPackages';
import * as marmotSigner from './marmotSigner';
import { markDmSetup } from './marmotDmSetupTrace';
import { marmotReplyTags } from './marmotEdits';
import { marmotRumorToGroupMessage, marmotRumorToDmRow } from './marmotInbox';
import { buildMarmotRumor } from './marmotSession';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

function fakeSession(overrides: Partial<MarmotSession> = {}) {
  const sent: { groupId: string; rumor: { id: string; kind: number; tags: string[][] } }[] = [];
  const session = {
    pubkey: ME,
    stop: () => undefined,
    getOrCreateDm: async () => ({ id: 'marmot:dm', relays: ['wss://r1', 'wss://r2'] }),
    syncDmDevices: async () => undefined,
    sendRumor: async (groupId: string, rumor: (typeof sent)[number]['rumor']) => {
      sent.push({ groupId, rumor });
      return { 'wss://r1': true, 'wss://r2': false };
    },
    ...overrides,
  } as unknown as MarmotSession;
  setMarmotSession(session);
  return sent;
}

afterEach(() => setMarmotSession(null));

it('round-trips the same White Noise reply tags through group and 1:1 Marmot sends', async () => {
  const sent = fakeSession();
  const parent = 'c'.repeat(64);
  const draft = {
    kind: 14,
    content: 'reply',
    tags: marmotReplyTags(parent),
    created_at: 1700000000,
  };
  const result = await sendMarmotGroupRumor(ME, 'marmot:group', draft);
  await sendMarmotDm(ME, PEER, draft);
  const expected = buildMarmotRumor(ME, { ...draft, kind: 9 });
  expect(result).toMatchObject({ success: true, rumorId: expected.id });
  expect(sent.map(({ rumor }) => rumor)).toEqual([expected, expected]);
  expect(expected.tags).toEqual([
    ['e', parent],
    ['q', parent],
  ]);
  expect(marmotRumorToGroupMessage(expected)).toMatchObject({ replyTo: parent });
  expect(
    marmotRumorToDmRow(ME, {
      group: { id: 'marmot:dm', isDm: true, memberPubkeys: [PEER] } as Parameters<
        typeof marmotRumorToDmRow
      >[1]['group'],
      rumor: expected,
    }),
  ).toMatchObject({ replyTo: parent });
});

describe('sendMarmotDm', () => {
  it('keeps a structured rumor byte-identical so content-addressed ids (polls) match', async () => {
    const sent = fakeSession();
    const poll = {
      pubkey: ME,
      kind: 1068,
      created_at: 1_700_000_000,
      tags: [
        ['p', PEER],
        ['option', '0', 'Oink'],
        ['polltype', 'singlechoice'],
      ],
      content: 'Best snack?',
    };
    const ready = jest.fn();
    const result = await sendMarmotDm(ME, PEER, poll, { onRumorReady: ready });
    expect(sent[0].rumor.id).toBe(getEventHash(poll));
    expect(ready).toHaveBeenCalledWith({
      eventId: getEventHash(poll),
      kind: 1068,
      relays: ['wss://r1', 'wss://r2'],
    });
    expect(result.success).toBe(true);
    expect(result.delivery?.relayResults).toEqual({ 'wss://r1': 'ok', 'wss://r2': 'failed' });
  });

  it('sends app text (kind 14) as Marmot chat (kind 9) but reports the app kind', async () => {
    const sent = fakeSession();
    const ready = jest.fn();
    await sendMarmotDm(ME, PEER, { kind: 14, content: 'oink' }, { onRumorReady: ready });
    expect(sent[0].rumor.kind).toBe(9);
    expect(ready.mock.calls[0][0].kind).toBe(14);
  });

  it('gives identical text to different recipients different ids (p tag kept)', async () => {
    const sent = fakeSession();
    const created_at = 1_700_000_000;
    const other = 'c'.repeat(64);
    await sendMarmotDm(ME, PEER, { kind: 14, content: 'oink', tags: [['p', PEER]], created_at });
    await sendMarmotDm(ME, other, { kind: 14, content: 'oink', tags: [['p', other]], created_at });
    expect(sent[0].rumor.id).not.toBe(sent[1].rumor.id);
    expect(sent[0].rumor.tags).toEqual([['p', PEER]]);
  });

  it('explains a missing key package instead of failing opaquely', async () => {
    fakeSession({
      getOrCreateDm: async () => {
        throw new MarmotNoKeyPackageError(PEER);
      },
    });
    const result = await sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
    // Flagged so the 1:1 composer re-sends it over NIP-17 instead.
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/open their Marmot app/),
      marmotUnreachable: 'noKeyPackage',
    });
  });

  it('flags an unusable (older-Marmot) key package as outdated', async () => {
    fakeSession({
      getOrCreateDm: async () => {
        throw new MarmotUnusableKeyPackageError(PEER);
      },
    });
    const result = await sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/expired, or uses an older version of Marmot/),
      marmotUnreachable: 'outdatedKeyPackage',
    });
  });

  it('does not claim "not on Marmot" when the key-package lookup got no answer (#1658)', async () => {
    fakeSession({
      getOrCreateDm: async () => {
        throw new MarmotKeyPackageLookupError(PEER);
      },
    });
    const result = await sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
    // A plain, retryable failure — no NIP-17 "isn't on Marmot yet" prompt.
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/couldn't reach any relay/),
    });
  });

  it('gives up on a chat set-up that never settles instead of spinning for ever (#1658)', async () => {
    jest.useFakeTimers();
    try {
      const ready = jest.fn();
      fakeSession({ getOrCreateDm: () => new Promise(() => undefined) });
      const pending = sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' }, { onRumorReady: ready });
      await jest.advanceTimersByTimeAsync(DM_SETUP_TIMEOUT_MS);
      expect(await pending).toEqual({
        success: false,
        error: expect.stringMatching(/taking too long/),
      });
      expect(ready).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs one [MarmotDiag] line naming the stage a timed-out set-up was stuck in (#1658)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fakeSession({
        getOrCreateDm: () => {
          markDmSetup('invite queued welcomes=1');
          return new Promise(() => undefined);
        },
      });
      const pending = sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
      await jest.advanceTimersByTimeAsync(DM_SETUP_TIMEOUT_MS);
      await pending;
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('MarmotDiag'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/dm set-up bbbbbbbb timeout in \d+ms: invite queued welcomes=1/);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('names Amber when an unanswered Amber approval is what holds the set-up (#1658)', async () => {
    jest.useFakeTimers();
    try {
      const openSince = jest.spyOn(marmotSigner, 'amberRequestOpenSince').mockReturnValue(1);
      fakeSession({ getOrCreateDm: () => new Promise(() => undefined) });
      const pending = sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
      await jest.advanceTimersByTimeAsync(DM_SETUP_TIMEOUT_MS);
      expect(await pending).toEqual({
        success: false,
        error: expect.stringMatching(/Open Amber, allow Lightning Piggy/),
      });
      openSince.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still sends to the current members when adding new devices fails (#1559)', async () => {
    const syncDmDevices = jest.fn(async () => {
      throw new Error('relay down');
    });
    const sent = fakeSession({ syncDmDevices });
    const result = await sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
    expect(syncDmDevices).toHaveBeenCalledWith('marmot:dm');
    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('fails cleanly before the session has started', async () => {
    const result = await sendMarmotDm(ME, PEER, { kind: 14, content: 'hi' });
    expect(result.success).toBe(false);
  });
});

describe('marmotDelivery', () => {
  it('is delivered when any relay accepted', () => {
    expect(marmotDelivery({ a: false, b: true }, { eventId: 'e', kind: 14 })).toMatchObject({
      delivered: true,
      targetRelayCount: 2,
    });
    expect(marmotDelivery({ a: false }, { eventId: 'e', kind: 14 }).delivered).toBe(false);
  });
});

it.each([14, NWC_SHARE_KIND])(
  'persists kind %s with the timestamp built after slow first-time Marmot setup',
  async (kind) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_700_000_000_000);
      let builtAt = 0;
      fakeSession({
        getOrCreateDm: async () => {
          jest.advanceTimersByTime(60_000);
          return { id: 'marmot:dm', relays: ['wss://r1'] } as Awaited<
            ReturnType<MarmotSession['getOrCreateDm']>
          >;
        },
        sendRumor: async (_group, rumor) => {
          builtAt = rumor.created_at;
          jest.advanceTimersByTime(60_000);
          return { 'wss://r1': true };
        },
      });
      const append = jest.fn().mockResolvedValue(undefined);
      await sendSharedDm({
        peer: PEER,
        text: 'shared content',
        protocol: 'marmot',
        kind,
        send: () => sendMarmotDm(ME, PEER, { kind, content: 'shared content' }),
        append,
      });
      const local = append.mock.calls[0][1];
      expect(builtAt).toBe(1_700_000_060);
      expect(local.createdAt).toBe(builtAt);
      expect(
        mergeConversationMessages(
          [local],
          [{ ...local, id: 'echo', createdAt: builtAt }],
          DM_CONV_CAP,
        ),
      ).toHaveLength(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  },
);
