import { buildSignOutPrompt, signOutPromptVariant } from './signOutPrompt';

const base = { displayName: 'Big Piggy', backedUp: false, otherAccountCount: 0 };

describe('signOutPromptVariant', () => {
  it.each([
    ['nsec', false, 'nsec-unbacked'],
    ['nsec', true, 'nsec-backed'],
    ['amber', false, 'amber'],
    ['amber', true, 'amber'],
    ['nip46', false, 'nip46'],
    ['nip46', true, 'nip46'],
    [null, false, 'nsec-unbacked'],
    [undefined, true, 'nsec-backed'],
  ] as const)('%s / backedUp=%s -> %s', (signer, backedUp, expected) => {
    expect(signOutPromptVariant(signer, backedUp)).toBe(expected);
  });
});

describe('buildSignOutPrompt', () => {
  it('names the account in the title', () => {
    const p = buildSignOutPrompt({ ...base, signerType: 'nsec' });
    expect(p.title).toEqual({ key: 'signOutPrompt.title', params: { name: 'Big Piggy' } });
  });

  it('warns and offers a backup for an nsec account that is not backed up', () => {
    const p = buildSignOutPrompt({ ...base, signerType: 'nsec' });
    expect(p.variant).toBe('nsec-unbacked');
    expect(p.offerBackup).toBe(true);
    expect(p.confirm.key).toBe('signOutPrompt.signOutAnyway');
    expect(p.paragraphs.map((x) => x.key)).toEqual([
      'signOutPrompt.nsecUnbacked',
      'signOutPrompt.walletsRemoved',
    ]);
    expect(p.paragraphs[0].params).toEqual({ name: 'Big Piggy' });
  });

  it('uses the lighter warning without a backup action once backed up', () => {
    const p = buildSignOutPrompt({ ...base, signerType: 'nsec', backedUp: true });
    expect(p.variant).toBe('nsec-backed');
    expect(p.offerBackup).toBe(false);
    expect(p.confirm.key).toBe('signOutPrompt.signOut');
    expect(p.paragraphs[0].key).toBe('signOutPrompt.nsecBacked');
  });

  it.each([
    ['amber', 'signOutPrompt.amber'],
    ['nip46', 'signOutPrompt.nip46'],
  ] as const)('reassures %s accounts that the key stays in the signer', (signer, key) => {
    const p = buildSignOutPrompt({ ...base, signerType: signer });
    expect(p.offerBackup).toBe(false);
    expect(p.confirm.key).toBe('signOutPrompt.signOut');
    expect(p.paragraphs.map((x) => x.key)).toEqual([key, 'signOutPrompt.walletsRemoved']);
  });

  it('only mentions other accounts when there are some', () => {
    expect(buildSignOutPrompt({ ...base, signerType: 'amber' }).paragraphs).toHaveLength(2);
    const one = buildSignOutPrompt({ ...base, signerType: 'amber', otherAccountCount: 1 });
    expect(one.paragraphs[2]).toEqual({
      key: 'signOutPrompt.otherAccountOne',
      params: { count: 1 },
    });
    const many = buildSignOutPrompt({ ...base, signerType: 'nsec', otherAccountCount: 3 });
    expect(many.paragraphs.map((x) => x.key)).toEqual([
      'signOutPrompt.nsecUnbacked',
      'signOutPrompt.walletsRemoved',
      'signOutPrompt.otherAccountsMany',
    ]);
    expect(many.paragraphs[2].params).toEqual({ count: 3 });
  });
});

describe('wallet paragraph', () => {
  const keys = (wallets?: Parameters<typeof buildSignOutPrompt>[0]['wallets']) =>
    buildSignOutPrompt({ ...base, signerType: 'amber', wallets }).paragraphs;

  it('is dropped when the account has no wallets', () => {
    expect(keys([]).map((x) => x.key)).toEqual(['signOutPrompt.amber']);
  });

  it('uses a short connected-wallets line when no recovery phrase is stored', () => {
    const p = keys([
      { alias: 'Pocket money', walletType: 'nwc' },
      { alias: 'Savings', walletType: 'onchain', onchainImportMethod: 'xpub' },
    ]);
    expect(p[1]).toEqual({ key: 'signOutPrompt.walletsConnected' });
  });

  it('names every wallet whose recovery phrase is stored here', () => {
    const p = keys([
      { alias: 'Pocket money', walletType: 'nwc' },
      { alias: 'Savings', walletType: 'onchain', onchainImportMethod: 'mnemonic' },
      { alias: 'Gift', walletType: 'onchain', onchainImportMethod: 'generated' },
    ]);
    expect(p[1]).toEqual({
      key: 'signOutPrompt.walletsWithPhrase',
      params: { wallets: 'Savings, Gift' },
    });
  });

  it('falls back to the generic warning when the wallet list is unknown', () => {
    expect(keys(undefined)[1]).toEqual({ key: 'signOutPrompt.walletsRemoved' });
  });
});

describe('hidden Piglets paragraph (#1781)', () => {
  const paragraphKeys = (hasHiddenPiglets?: boolean) =>
    buildSignOutPrompt({
      ...base,
      signerType: 'amber',
      wallets: [],
      otherAccountCount: 1,
      hasHiddenPiglets,
    }).paragraphs.map((p) => p.key);

  it('warns that withdraw links and tag PINs go when the account has Piglets', () => {
    expect(paragraphKeys(true)).toEqual([
      'signOutPrompt.amber',
      'signOutPrompt.hiddenPiglets',
      'signOutPrompt.otherAccountOne',
    ]);
  });

  it('is dropped when the account has none', () => {
    expect(paragraphKeys(false)).not.toContain('signOutPrompt.hiddenPiglets');
    expect(paragraphKeys(undefined)).not.toContain('signOutPrompt.hiddenPiglets');
  });
});
