import { createReplyTimeoutError, isUnansweredError, isWalletAnswer } from './nwcErrors';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('isUnansweredError (#1768)', () => {
  it.each([
    ['our typed reply timeout', createReplyTimeoutError()],
    ['SDK Nip47ReplyTimeoutError', withCode('reply timeout: event abc', 'INTERNAL')],
    ['SDK Nip47PublishTimeoutError', withCode('Publish timeout: abc', 'INTERNAL')],
    ['SDK Nip47PublishError', withCode('Failed to publish: boom', 'INTERNAL')],
    ['SDK Nip47NetworkError', withCode('Failed to connect to wss://r.example', 'OTHER')],
  ])('%s → unanswered', (_label, error) => {
    expect(isUnansweredError(error)).toBe(true);
    expect(isWalletAnswer(error)).toBe(false);
  });

  it('a NIP-47 wallet error is an answer', () => {
    for (const code of ['NOT_IMPLEMENTED', 'INSUFFICIENT_BALANCE', 'NOT_FOUND', 'INTERNAL']) {
      const error = withCode('wallet said no', code);
      expect(isUnansweredError(error)).toBe(false);
      expect(isWalletAnswer(error)).toBe(true);
    }
  });

  it('a local error without a NIP-47 code is neither', () => {
    const error = new Error('Not connected');
    expect(isUnansweredError(error)).toBe(false);
    expect(isWalletAnswer(error)).toBe(false);
    expect(isWalletAnswer(undefined)).toBe(false);
  });
});
