import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NavigationState } from '@react-navigation/native';
import {
  NAV_STATE_KEY,
  clearPersistedNavigationState,
  loadPersistedNavigationState,
  persistNavigationState,
  sanitizeNavigationState,
} from './navigationStatePersistence';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// A minimal but valid-shape NavigationState — fields React Navigation
// actually populates at runtime. The util doesn't introspect it beyond
// "is an object", so this is enough to round-trip.
const sampleState = {
  index: 0,
  key: 'stack-1',
  routeNames: ['Main'],
  routes: [{ key: 'Main-1', name: 'Main' }],
  stale: false,
  type: 'stack',
} as unknown as NavigationState;

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('navigationStatePersistence — round-trip', () => {
  it('returns undefined when nothing is saved', async () => {
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('saves and loads the state', async () => {
    await persistNavigationState(sampleState);
    const loaded = await loadPersistedNavigationState();
    expect(loaded).toEqual(sampleState);
  });

  it('persists under the versioned key', async () => {
    await persistNavigationState(sampleState);
    const raw = await AsyncStorage.getItem(NAV_STATE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ version: 1, state: sampleState });
  });

  it('no-ops when state is undefined', async () => {
    await persistNavigationState(undefined);
    expect(await AsyncStorage.getItem(NAV_STATE_KEY)).toBeNull();
  });
});

describe('navigationStatePersistence — clear', () => {
  it('removes the saved state', async () => {
    await persistNavigationState(sampleState);
    await clearPersistedNavigationState();
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('is a no-op when nothing is saved', async () => {
    await clearPersistedNavigationState();
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });
});

describe('navigationStatePersistence — defensive parsing', () => {
  it('returns undefined when the saved blob is from a prior schema', async () => {
    // Manually plant a payload with the wrong version number.
    await AsyncStorage.setItem(
      NAV_STATE_KEY,
      JSON.stringify({ version: 999, state: sampleState, savedAt: Date.now() }),
    );
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('returns undefined when the saved blob is corrupt JSON', async () => {
    await AsyncStorage.setItem(NAV_STATE_KEY, '{not-json');
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('returns undefined when the saved blob is structurally wrong', async () => {
    // Valid JSON, but missing required fields — the type guard rejects it.
    await AsyncStorage.setItem(NAV_STATE_KEY, JSON.stringify({ foo: 'bar' }));
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('returns undefined when the saved state is an empty object', async () => {
    // Pre-fix, this slipped past the type guard and crashed NavigationContainer.
    await AsyncStorage.setItem(
      NAV_STATE_KEY,
      JSON.stringify({ version: 1, state: {}, savedAt: 0 }),
    );
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('returns undefined when the saved state has routes without `name`', async () => {
    await AsyncStorage.setItem(
      NAV_STATE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 0,
        state: { index: 0, routeNames: ['X'], routes: [{ key: 'k' }] },
      }),
    );
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('returns undefined when the saved state is an array (not an object)', async () => {
    await AsyncStorage.setItem(
      NAV_STATE_KEY,
      JSON.stringify({ version: 1, savedAt: 0, state: [] }),
    );
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  // NB: these use `mockRejectedValueOnce` directly on the mock fn rather than
  // `jest.spyOn(...).mockRestore()`. `spyOn` + `mockRestore` on the
  // async-storage jest mock swaps in a bare jest.fn() that drops the in-memory
  // storage backing, silently breaking setItem/getItem for EVERY later test in
  // the file. `mockRejectedValueOnce` queues one rejection then reverts to the
  // mock's default storage-backed impl on its own — no restore, no fallout.
  it('swallows AsyncStorage failures on load', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    expect(await loadPersistedNavigationState()).toBeUndefined();
  });

  it('swallows AsyncStorage failures on save', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await expect(persistNavigationState(sampleState)).resolves.toBeUndefined();
  });

  it('swallows AsyncStorage failures on clear', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await expect(clearPersistedNavigationState()).resolves.toBeUndefined();
  });
});

describe('sanitizeNavigationState — replay guard (#886)', () => {
  // Factory (not a shared const) so each test gets a pristine, deeply
  // independent fixture — a realistic nested shape: root stack → Main → tab
  // navigator, with the Home tab carrying a stale `sendToAddress` invoice and
  // an Explore stack sitting on a HuntPiggyDetail cache page.
  const makeDirtyState = (): NavigationState =>
    ({
      index: 0,
      routeNames: ['Main'],
      routes: [
        {
          key: 'Main-1',
          name: 'Main',
          state: {
            index: 0,
            routeNames: ['Home', 'Explore'],
            routes: [
              {
                key: 'Home-1',
                name: 'Home',
                params: { sendToAddress: 'lnbc5u1pstale', sendToName: 'Bob', keep: 'me' },
              },
              {
                key: 'Explore-1',
                name: 'Explore',
                state: {
                  index: 2,
                  routeNames: ['ExploreHome', 'Hunt', 'HuntPiggyDetail'],
                  routes: [
                    { key: 'EH-1', name: 'ExploreHome' },
                    { key: 'H-1', name: 'Hunt' },
                    {
                      key: 'HPD-1',
                      name: 'HuntPiggyDetail',
                      params: { coord: '37516:abc:allotment' },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }) as unknown as NavigationState;

  const homeParamsOf = (s: NavigationState | undefined): Record<string, unknown> | undefined =>
    (s as any)?.routes?.[0]?.state?.routes?.[0]?.params ?? undefined;
  const exploreStateOf = (s: NavigationState | undefined): any =>
    (s as any)?.routes?.[0]?.state?.routes?.[1]?.state;

  it('strips one-shot action params from a nested Home route', () => {
    const params = homeParamsOf(sanitizeNavigationState(makeDirtyState()));
    expect(params).toEqual({ keep: 'me' }); // transient keys gone, others kept
    expect(params).not.toHaveProperty('sendToAddress');
    expect(params).not.toHaveProperty('sendToName');
  });

  it('pops a transient HuntPiggyDetail leaf and clamps the index to the parent', () => {
    const explore = exploreStateOf(sanitizeNavigationState(makeDirtyState()));
    expect(explore.routes.map((r: any) => r.name)).toEqual(['ExploreHome', 'Hunt']);
    expect(explore.index).toBe(1); // was 2 (HuntPiggyDetail), clamped to Hunt
  });

  it('does not mutate its input (pure)', () => {
    const input = makeDirtyState();
    const snapshot = JSON.stringify(input);
    sanitizeNavigationState(input);
    expect(JSON.stringify(input)).toEqual(snapshot);
  });

  it('leaves a clean state untouched (identity for the common case)', () => {
    const clean = {
      index: 0,
      routeNames: ['Main'],
      routes: [{ key: 'Main-1', name: 'Main' }],
    } as unknown as NavigationState;
    expect(sanitizeNavigationState(clean)).toEqual(clean);
  });

  it('never empties a stack made entirely of transient routes', () => {
    const allTransient = {
      index: 0,
      routeNames: ['HuntFound'],
      routes: [{ key: 'HF-1', name: 'HuntFound', params: { lnurl: 'lnurl1stale' } }],
    } as unknown as NavigationState;
    const out = sanitizeNavigationState(allTransient) as any;
    expect(out.routes).toHaveLength(1); // kept rather than crash the navigator
    expect(out.index).toBe(0);
  });

  it('returns undefined / passthrough for empty or malformed input', () => {
    expect(sanitizeNavigationState(undefined)).toBeUndefined();
    expect(sanitizeNavigationState({} as unknown as NavigationState)).toEqual({});
  });

  it('strips a deep-link payload nested in params.state / params.params (#886 real shape)', () => {
    // Mirrors the actual persisted shape from a `navigate('Main', { screen:
    // 'Explore', params: { state: {…HuntPiggyDetail…} } })` deep link: the
    // resolved `state` tree looks clean, but the cache lives in the params
    // navigate-payload, which RN re-applies on restore.
    const state = {
      index: 0,
      routeNames: ['Main'],
      routes: [
        {
          key: 'Main-1',
          name: 'Main',
          // resolved tree is already clean (cache not in state.routes)…
          state: {
            index: 0,
            routeNames: ['Explore'],
            routes: [{ key: 'Explore-1', name: 'Explore' }],
          },
          // …but the navigate-payload in params still carries it:
          params: {
            screen: 'Explore',
            params: {
              state: {
                index: 2,
                routes: [
                  { name: 'ExploreHome' },
                  { name: 'Hunt' },
                  { name: 'HuntPiggyDetail', params: { coord: '37516:abc:allotment' } },
                ],
              },
            },
          },
        },
      ],
    } as unknown as NavigationState;
    const out = sanitizeNavigationState(state) as any;
    const payloadRoutes = out.routes[0].params.params.state.routes.map((r: any) => r.name);
    expect(payloadRoutes).toEqual(['ExploreHome', 'Hunt']); // HuntPiggyDetail popped from the payload
  });

  it('strips sendToAddress from a nested params.params navigate payload', () => {
    // navigate('Main', { screen: 'Home', params: { sendToAddress: '…' } })
    const state = {
      index: 0,
      routeNames: ['Main'],
      routes: [
        {
          key: 'Main-1',
          name: 'Main',
          params: { screen: 'Home', params: { sendToAddress: 'lnbc5u1pstale', keep: 'me' } },
        },
      ],
    } as unknown as NavigationState;
    const out = sanitizeNavigationState(state) as any;
    expect(out.routes[0].params.params).toEqual({ keep: 'me' });
    expect(out.routes[0].params.params).not.toHaveProperty('sendToAddress');
  });

  it('strips a widget button request so a cold start never reopens its sheet (#1849)', () => {
    const state = {
      index: 0,
      routeNames: ['Main'],
      routes: [
        {
          key: 'Main-1',
          name: 'Main',
          params: {
            screen: 'Home',
            params: { widgetAction: 'send', widgetWalletId: 'w1', widgetNonce: 1, keep: 'me' },
          },
        },
      ],
    } as unknown as NavigationState;
    const out = sanitizeNavigationState(state) as unknown as {
      routes: { params: { params: unknown } }[];
    };
    expect(out.routes[0].params.params).toEqual({ keep: 'me' });
  });

  it('collapses an empty-routes stack to undefined (no index -1 crash)', () => {
    // A malformed-but-JSON-valid blob with zero routes would otherwise yield
    // index = routes.length - 1 = -1 and crash NavigationContainer on mount.
    const empty = { index: 0, routeNames: [], routes: [] } as unknown as NavigationState;
    expect(sanitizeNavigationState(empty)).toBeUndefined();
  });

  it('load() heals an already-persisted stale invoice (sanitize on read)', async () => {
    await AsyncStorage.setItem(
      NAV_STATE_KEY,
      JSON.stringify({ version: 1, savedAt: 0, state: makeDirtyState() }),
    );
    const loaded = await loadPersistedNavigationState();
    expect(loaded).toBeDefined();
    expect(homeParamsOf(loaded)).not.toHaveProperty('sendToAddress');
    expect(exploreStateOf(loaded).routes.map((r: any) => r.name)).toEqual(['ExploreHome', 'Hunt']);
  });

  it('persist() writes a sanitized blob (sanitize on write)', async () => {
    await persistNavigationState(makeDirtyState());
    const raw = await AsyncStorage.getItem(NAV_STATE_KEY);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw as string);
    // Assert on the restored stack, not a substring: `routeNames` is the
    // navigator's registered-screen list and legitimately still lists
    // HuntPiggyDetail — what matters is that it's gone from `routes`.
    const explore = saved.state.routes[0].state.routes[1].state;
    expect(explore.routes.map((r: any) => r.name)).toEqual(['ExploreHome', 'Hunt']);
    expect(saved.state.routes[0].state.routes[0].params).not.toHaveProperty('sendToAddress');
  });
});
