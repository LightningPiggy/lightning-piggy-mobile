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

  it('SDK-local coded errors are not answers (raised before anything is published)', () => {
    // Nip47UnsupportedEncryptionError is thrown locally while picking an
    // encryption; an offline wallet must not turn green on it.
    const encryption = withCode(
      'no compatible encryption or version found between wallet and client',
      'UNSUPPORTED_ENCRYPTION',
    );
    expect(isWalletAnswer(encryption)).toBe(false);
    expect(isWalletAnswer(withCode('slow down', 'RATE_LIMITED'))).toBe(false);
    expect(isWalletAnswer(withCode('made up', 'SOMETHING_ELSE'))).toBe(false);
  });

  it('a local error without a NIP-47 code is neither', () => {
    const error = new Error('Not connected');
    expect(isUnansweredError(error)).toBe(false);
    expect(isWalletAnswer(error)).toBe(false);
    expect(isWalletAnswer(undefined)).toBe(false);
  });
});
