import { buildRemoveWalletPrompt, type RemoveWalletPromptInput } from './removeWalletPrompt';

const formatAmount = (n: number) => n.toLocaleString('en-US');

function input(
  wallet: Partial<RemoveWalletPromptInput['wallet']>,
  hasCoinosRecovery: boolean | null = false,
  mnemonicStored: boolean | null = false,
): RemoveWalletPromptInput {
  return {
    wallet: { alias: 'Savings', walletType: 'nwc', balance: null, ...wallet },
    hasCoinosRecovery,
    mnemonicStored,
    formatAmount,
  };
}

describe('buildRemoveWalletPrompt', () => {
  it.each(['mnemonic', 'generated'] as const)(
    'warns about the recovery phrase for a %s on-chain wallet',
    (method) => {
      const p = buildRemoveWalletPrompt(
        input({ walletType: 'onchain', onchainImportMethod: method, balance: 21000 }),
      );
      expect(p.risk).toBe('phrase');
      expect(p.paragraphs).toEqual([
        { key: 'removeWalletPrompt.withPhrase', params: { alias: 'Savings' } },
        { key: 'removeWalletPrompt.balance', params: { amount: '21,000' } },
      ]);
      // No in-app screen re-shows a phrase, so nothing to view first.
      expect(p.offerViewRecovery).toBe(false);
    },
  );

  it('warns about the CoinOS login and offers to view it first', () => {
    const p = buildRemoveWalletPrompt(input({ balance: 500 }, true));
    expect(p.risk).toBe('coinos');
    expect(p.paragraphs).toEqual([
      { key: 'removeWalletPrompt.withCoinosLogin', params: { alias: 'Savings' } },
      { key: 'removeWalletPrompt.balance', params: { amount: '500' } },
    ]);
    expect(p.offerViewRecovery).toBe(true);
  });

  it('keeps the plain message for watch-only and URL-imported NWC wallets', () => {
    for (const p of [
      buildRemoveWalletPrompt(
        input({ walletType: 'onchain', onchainImportMethod: 'xpub', balance: 9 }),
      ),
      buildRemoveWalletPrompt(input({ balance: 9 }, false)),
    ]) {
      expect(p).toEqual({ risk: 'none', paragraphs: [], offerViewRecovery: false });
    }
  });

  it('warns for a legacy on-chain wallet whose import method is not filled in yet', () => {
    const p = buildRemoveWalletPrompt(
      input({ walletType: 'onchain', onchainImportMethod: undefined }, false, true),
    );
    expect(p.risk).toBe('phrase');
    expect(p.paragraphs[0].key).toBe('removeWalletPrompt.withPhrase');
  });

  it('warns about a phrase when the mnemonic read failed', () => {
    const p = buildRemoveWalletPrompt(
      input({ walletType: 'onchain', onchainImportMethod: 'xpub' }, false, null),
    );
    expect(p.risk).toBe('phrase');
  });

  it('warns about a CoinOS login when the recovery read failed', () => {
    const p = buildRemoveWalletPrompt(input({}, null));
    expect(p.risk).toBe('coinos');
    expect(p.offerViewRecovery).toBe(true);
  });

  it('ignores CoinOS recovery info on an on-chain wallet', () => {
    const p = buildRemoveWalletPrompt(
      input({ walletType: 'onchain', onchainImportMethod: 'xpub' }, true),
    );
    expect(p.risk).toBe('none');
  });

  it.each([
    ['unknown', { balance: null }],
    ['empty', { balance: 0 }],
    ['hidden', { balance: 1000, hideBalance: true }],
  ])('omits the balance line when it is %s', (_label, wallet) => {
    const p = buildRemoveWalletPrompt(input(wallet, true));
    expect(p.paragraphs.map((x) => x.key)).toEqual(['removeWalletPrompt.withCoinosLogin']);
  });
});
