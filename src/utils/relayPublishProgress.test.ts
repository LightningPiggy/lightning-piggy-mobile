import { publishPhase, publishProgressRow } from './relayPublishProgress';
it('waits for a signer then publishes and never leaves the finished state', () => {
  expect(publishPhase('waiting', {})).toBe('waiting');
  expect(publishPhase('waiting', { signed: true })).toBe('publishing');
  expect(publishPhase('publishing', { finished: true })).toBe('finished');
  expect(publishPhase('waiting', { finished: true })).toBe('finished');
  expect(publishPhase('finished', { signed: true })).toBe('finished');
});
it.each([
  [
    { url: 'wss://relay', ok: true },
    { url: 'wss://relay', status: 'accepted' },
  ],
  [
    { url: 'wss://relay', ok: false, message: 'blocked: payment required' },
    { url: 'wss://relay', status: 'rejected', reason: 'blocked: payment required' },
  ],
  [
    { url: 'wss://relay', ok: false, message: 'timed out' },
    { url: 'wss://relay', status: 'noResponse' },
  ],
  [
    { url: 'wss://relay', ok: false, message: 'connection failure: closed' },
    { url: 'wss://relay', status: 'noResponse' },
  ],
  [
    { url: 'wss://relay', ok: false, message: 'missing publish result' },
    { url: 'wss://relay', status: 'noResponse' },
  ],
] as const)('maps a destination result without losing its reason', (input, expected) => {
  expect(publishProgressRow(input)).toEqual(expected);
});
