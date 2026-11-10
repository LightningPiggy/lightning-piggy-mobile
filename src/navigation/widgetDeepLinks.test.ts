import { buildWidgetDeepLink, parseWidgetDeepLink } from './widgetDeepLinks';

const ID = '3f2b7c1e-9a4d-4e8b-b1c2-0a9d8e7f6c5b';

describe('widget deep links', () => {
  it.each(['receive', 'send', 'scan'] as const)('round-trips %s', (action) => {
    const url = buildWidgetDeepLink(action, ID);
    expect(url).toBe(`lightningpiggy://${action}?wallet=${ID}`);
    expect(parseWidgetDeepLink(url)).toEqual({ action, walletId: ID });
  });

  it('builds a link without a wallet', () => {
    expect(buildWidgetDeepLink('scan', null)).toBe('lightningpiggy://scan');
    expect(parseWidgetDeepLink('lightningpiggy://scan')).toEqual({
      action: 'scan',
      walletId: null,
    });
  });

  it('tolerates case, a trailing slash, other params and a fragment', () => {
    expect(parseWidgetDeepLink(`LightningPiggy://Send/?x=1&wallet=${ID}#top`)).toEqual({
      action: 'send',
      walletId: ID,
    });
    expect(parseWidgetDeepLink(`  lightningpiggy://receive?wallet=${ID}  `)?.action).toBe(
      'receive',
    );
  });

  it('keeps the action but drops a malformed wallet id', () => {
    for (const bad of ['%E0%A4%A', 'a%20b', '..%2F..', 'x'.repeat(200), '<script>']) {
      expect(parseWidgetDeepLink(`lightningpiggy://receive?wallet=${bad}`)).toEqual({
        action: 'receive',
        walletId: null,
      });
    }
  });

  it.each([
    null,
    undefined,
    '',
    'lightningpiggy://hunt/30408%3Aabc%3Ad',
    'lightningpiggy://receive-all',
    'lightningpiggy://pay?wallet=abc',
    'https://lightningpiggy.com/receive?wallet=abc',
    'lightning:lnbc1...',
  ])('is not a widget link: %p', (url) => {
    expect(parseWidgetDeepLink(url)).toBeNull();
  });
});
