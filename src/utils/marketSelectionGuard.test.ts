import type { MarketProduct } from '../data/marketProducts';
import type { MarketMerchant } from './marketMerchants';
import {
  initialSelectionGuard,
  merchantRelays,
  reconcileSelection,
  SELLER_ABSENT_LOADS,
  withSelectedCurrency,
  withSelectedMerchant,
  type SelectionGuard,
  type SelectionInput,
} from './marketSelectionGuard';

const EDEN = 'e'.repeat(64);
const EDEN_RELAY = 'wss://relay.family.example';
const MARKET_RELAY = 'wss://relay.plebeian.market';
const edenOption: MarketMerchant = { id: EDEN, label: 'Eden', count: 3, curated: false };

const input = (overrides: Partial<SelectionInput> = {}): SelectionInput => ({
  mode: 'wotFriends',
  load: null,
  answeredRelays: [MARKET_RELAY, EDEN_RELAY],
  merchant: EDEN,
  merchantOption: edenOption,
  merchantRelays: [EDEN_RELAY],
  currency: null,
  currencyPresent: false,
  ...overrides,
});

/** Run a sequence of renders through the guard, collecting clears. */
function run(steps: Partial<SelectionInput>[], mode: SelectionInput['mode'] = 'wotFriends') {
  let guard: SelectionGuard = initialSelectionGuard(mode);
  const clears: { merchant: boolean; currency: boolean }[] = [];
  for (const step of steps) {
    const verdict = reconcileSelection(guard, input(step));
    guard = verdict.guard;
    clears.push({ merchant: verdict.clearMerchant, currency: verdict.clearCurrency });
  }
  return { guard, clears, clearedMerchant: clears.some((c) => c.merchant) };
}

const absent = { merchantOption: undefined, merchantRelays: [] };

it("keeps the merchant through a load in which their relay didn't answer", () => {
  const { clearedMerchant, guard } = run([
    {}, // chosen while on screen: label + relays remembered
    { ...absent, load: 'wotFriends:1', answeredRelays: [MARKET_RELAY] },
    { ...absent, load: 'wotFriends:2', answeredRelays: [MARKET_RELAY] },
    { ...absent, load: 'wotFriends:3', answeredRelays: [MARKET_RELAY] },
  ]);
  expect(clearedMerchant).toBe(false);
  expect(guard.merchant).toMatchObject({ id: EDEN, label: 'Eden', misses: 0 });
});

it(`clears the merchant after ${SELLER_ABSENT_LOADS} consecutive loads their relays answered without them`, () => {
  const { clears } = run([
    {},
    { ...absent, load: 'wotFriends:1' },
    { ...absent, load: 'wotFriends:2' },
  ]);
  expect(clears.map((c) => c.merchant)).toEqual([false, false, true]);
});

it('judges each load once, however often the screen re-renders', () => {
  const { clearedMerchant } = run([
    {},
    { ...absent, load: 'wotFriends:1' },
    { ...absent, load: 'wotFriends:1' },
    { ...absent, load: 'wotFriends:1' },
  ]);
  expect(clearedMerchant).toBe(false);
});

it('resets the count when the merchant comes back', () => {
  const { clearedMerchant } = run([
    {},
    { ...absent, load: 'wotFriends:1' },
    { load: 'wotFriends:2' },
    { ...absent, load: 'wotFriends:3' },
  ]);
  expect(clearedMerchant).toBe(false);
});

it('ignores loads that are not settled and complete', () => {
  const { clearedMerchant } = run([{}, { ...absent }, { ...absent }, { ...absent }]);
  expect(clearedMerchant).toBe(false);
});

it('clears a missing merchant on the first load after a seller-scope change', () => {
  const { clears } = run(
    [{ mode: 'wotFriends' }, { ...absent, mode: 'preferred', load: 'preferred:1' }],
    'wotFriends',
  );
  expect(clears[1].merchant).toBe(true);
});

it('keeps a merchant that exists in the new scope', () => {
  const { clearedMerchant } = run([{}, { mode: 'preferred', load: 'preferred:1' }], 'wotFriends');
  expect(clearedMerchant).toBe(false);
});

it('counts an absence when the merchant was never seen (unknown relays)', () => {
  const { clears } = run([
    { ...absent, load: 'wotFriends:1', answeredRelays: [MARKET_RELAY] },
    { ...absent, load: 'wotFriends:2', answeredRelays: [MARKET_RELAY] },
  ]);
  expect(clears.map((c) => c.merchant)).toEqual([false, true]);
});

it('clears a missing currency after two loads, or at once on a scope change', () => {
  const currency = { merchant: null, currency: 'EUR', currencyPresent: false };
  expect(
    run([
      { ...currency, load: 'wotFriends:1' },
      { ...currency, load: 'wotFriends:2' },
    ]).clears.map((c) => c.currency),
  ).toEqual([false, true]);
  expect(run([{ ...currency, mode: 'preferred', load: 'preferred:1' }]).clears[0].currency).toBe(
    true,
  );
});

it('returns the same guard when nothing changed, so the screen does not re-render', () => {
  const first = reconcileSelection(initialSelectionGuard('wotFriends'), input());
  expect(reconcileSelection(first.guard, input()).guard).toBe(first.guard);
});

it("collects the relays that served a merchant's listings", () => {
  const listing = (pubkey: string, seenOn: string[]) =>
    ({
      id: pubkey + seenOn[0],
      listing: { event: { pubkey }, seenOn },
    }) as unknown as MarketProduct;
  expect(
    merchantRelays(
      [listing(EDEN, [EDEN_RELAY]), listing(EDEN, [MARKET_RELAY]), listing('f'.repeat(64), ['x'])],
      EDEN,
    ),
  ).toEqual([MARKET_RELAY, EDEN_RELAY].sort());
});

it('keeps a chosen chip rendered while it has nothing in the catalogue', () => {
  expect(withSelectedMerchant([], EDEN, 'Eden')).toEqual([
    { id: EDEN, label: 'Eden', count: 0, curated: false },
  ]);
  expect(withSelectedMerchant([edenOption], EDEN, 'Eden')).toEqual([edenOption]);
  expect(withSelectedMerchant([], EDEN, null)[0].label).toMatch(/^npub1/);
  expect(withSelectedCurrency(['GBP'], 'EUR')).toEqual(['GBP', 'EUR']);
  expect(withSelectedCurrency(['GBP'], null)).toEqual(['GBP']);
});
