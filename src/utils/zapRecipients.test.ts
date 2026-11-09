import { collectZapRecipientPubkeys } from './zapRecipients';

describe('collectZapRecipientPubkeys', () => {
  const resolveOk = jest.fn(async (_lud16: string) => 'serverpk');
  const resolveNull = jest.fn(async (_lud16: string) => null);

  beforeEach(() => {
    resolveOk.mockClear();
    resolveNull.mockClear();
  });

  it('includes the user pubkey and the resolved LNURL-server pubkey', async () => {
    const out = await collectZapRecipientPubkeys('userpk', 'me@host', resolveOk);
    expect(out).toEqual({ recipients: ['userpk', 'serverpk'], providerPubkey: 'serverpk' });
    expect(resolveOk).toHaveBeenCalledWith('me@host');
  });

  it('omits the server pubkey when the address does not resolve', async () => {
    const out = await collectZapRecipientPubkeys('userpk', 'me@host', resolveNull);
    expect(out).toEqual({ recipients: ['userpk'], providerPubkey: null });
  });

  it('skips the lud16 round-trip entirely when there is no lightning address', async () => {
    const out = await collectZapRecipientPubkeys('userpk', undefined, resolveOk);
    expect(out).toEqual({ recipients: ['userpk'], providerPubkey: null });
    expect(resolveOk).not.toHaveBeenCalled();
  });

  it('returns empty when there is neither a user pubkey nor a resolvable address', async () => {
    const out = await collectZapRecipientPubkeys(null, 'me@host', resolveNull);
    expect(out).toEqual({ recipients: [], providerPubkey: null });
  });
});
