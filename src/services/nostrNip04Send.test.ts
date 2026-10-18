import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { sendNip04Message } from './nostrNip04Send';
import { getMemoisedSecretKey } from '../contexts/nostrSecretKeyCache';
import { publishWrapsTrackingRelays } from './nostrDmPublish';
import { pendingDelivery } from '../utils/dmDeliveryStatus';

jest.mock('../contexts/nostrSecretKeyCache', () => ({ getMemoisedSecretKey: jest.fn() }));
jest.mock('./amberService', () => ({
  requestNip04Encrypt: jest.fn(),
  requestEventSignature: jest.fn(),
}));
jest.mock('./nostrConnectService', () => ({
  requestNip04Encrypt: jest.fn(),
  requestEventSignature: jest.fn(),
}));
jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./nostrDmPublish', () => ({ publishWrapsTrackingRelays: jest.fn() }));

it('encrypts and signs kind 4, announces its identity before publishing, and forwards delivery', async () => {
  const secret = generateSecretKey();
  const recipientSecret = generateSecretKey();
  const sender = getPublicKey(secret);
  const recipient = getPublicKey(recipientSecret);
  const relays = ['wss://relay.example'];
  const onRumorReady = jest.fn();
  const onDeliveryFinalized = jest.fn();
  jest.mocked(getMemoisedSecretKey).mockResolvedValue(secret);
  jest
    .mocked(publishWrapsTrackingRelays)
    .mockImplementation(async (events, targets, _pool, meta, finalize) => {
      const event = events[0];
      expect(event.kind).toBe(4);
      expect(event.pubkey).toBe(sender);
      expect(event.tags).toEqual([['p', recipient]]);
      expect(verifyEvent(event)).toBe(true);
      expect(await nip04.decrypt(recipientSecret, sender, event.content)).toBe('Hello Piggy');
      expect(onRumorReady).toHaveBeenCalledWith({ eventId: event.id, kind: 4, relays });
      expect(targets).toEqual(relays);
      expect(meta).toEqual({ eventId: event.id, kind: 4 });
      const delivery = pendingDelivery({ eventId: event.id, kind: 4, relays });
      finalize?.(delivery);
      return { wrapOutcomes: [], wrapsPublished: 1, errors: [], delivery };
    });
  const result = await sendNip04Message({
    senderPubkey: sender,
    recipientPubkey: recipient,
    plaintext: 'Hello Piggy',
    signerType: 'nsec',
    relays,
    hooks: { onRumorReady, onDeliveryFinalized },
  });
  expect(result.wrapsPublished).toBe(1);
  expect(onDeliveryFinalized).toHaveBeenCalledWith(result.delivery);
});

it('refuses to publish a signer-returned event whose recipient was changed', async () => {
  const amberService = jest.requireMock('./amberService');
  const secret = generateSecretKey();
  const sender = getPublicKey(secret);
  const recipient = getPublicKey(generateSecretKey());
  const attacker = getPublicKey(generateSecretKey());
  amberService.requestNip04Encrypt.mockResolvedValue('ciphertext?iv=abc');
  amberService.requestEventSignature.mockImplementation(async (json: string) => {
    const unsigned = JSON.parse(json);
    const tampered = finalizeEvent({ ...unsigned, tags: [['p', attacker]] }, secret);
    return { event: JSON.stringify(tampered) };
  });
  jest.mocked(publishWrapsTrackingRelays).mockClear();
  await expect(
    sendNip04Message({
      senderPubkey: sender,
      recipientPubkey: recipient,
      plaintext: 'hi',
      signerType: 'amber',
      relays: ['wss://relay.example'],
    }),
  ).rejects.toThrow('Signer returned an invalid or modified event');
  expect(publishWrapsTrackingRelays).not.toHaveBeenCalled();
});
