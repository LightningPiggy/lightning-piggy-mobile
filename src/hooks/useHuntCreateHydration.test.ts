import { useRef, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLocale } from '../contexts/LocaleContext';
import i18n, { createI18nInstance } from '../i18n';
import { useHuntCreateHydration, type HuntCreateStage } from './useHuntCreateHydration';
import { loadPiggies, type HiddenPiggy } from '../services/piggyStorageService';
import type { ExploreNavigation, HuntCacheFallback } from '../navigation/types';
import Toast from '../components/BrandedToast';

jest.mock('../contexts/LocaleContext', () => ({ useLocale: () => ({ t: mockTranslate }) }));
jest.mock('../services/piggyStorageService', () => ({ loadPiggies: jest.fn() }));
jest.mock('../components/BrandedToast', () => ({ __esModule: true, default: { show: jest.fn() } }));

let mockTranslate: ReturnType<typeof useLocale>['t'];
const load = jest.mocked(loadPiggies);
const navigation = { goBack: jest.fn() } as unknown as ExploreNavigation;
const otherSetters = {
  setCrossDeviceEdit: jest.fn(),
  setIsLpPiggyEdit: jest.fn(),
  setIsPublic: jest.fn(),
  setLastWrittenLock: jest.fn(),
  setHintPhotoUrl: jest.fn(),
  setWaitMinutesText: jest.fn(),
  setUsesText: jest.fn(),
  setPin: jest.fn(),
  setDifficulty: jest.fn(),
  setTerrain: jest.fn(),
  setCacheSize: jest.fn(),
  setCacheType: jest.fn(),
  setExpiryDays: jest.fn(),
};
const piggy: HiddenPiggy = {
  id: 'piggy',
  lnurlw: 'lnurl',
  createdAt: 100000,
  isPublic: true,
  name: 'Saved name',
  description: 'Saved description',
  hint: 'Saved hint',
  maxWithdrawableMsat: 21000,
};

function changeLocale(locale: 'en' | 'es') {
  i18n.locale = locale;
  const instance = createI18nInstance(locale);
  mockTranslate = (scope, options) => instance.t(scope, options);
}

function setup(
  initialProps: {
    editingId: string | null;
    fallbackCache: HuntCacheFallback | null;
    pubkey: string | null;
  } = { editingId: 'piggy', fallbackCache: null, pubkey: 'author' },
) {
  return renderHook(
    (props: typeof initialProps) => {
      const { t } = useLocale();
      const [name, setCacheName] = useState('');
      const [description, setCacheDescription] = useState('');
      const [hint, setCacheHint] = useState('');
      const [lnurl, setLnurl] = useState('');
      const [amount, setAmountSatsText] = useState('');
      const [stage, setStage] = useState<HuntCreateStage>({ kind: 'idle' });
      const originalCreatedAt = useRef<number | null>(null);
      const piggyIdRef = useRef<string | null>(null);
      const amountManuallyEdited = useRef(false);
      useHuntCreateHydration({
        ...props,
        ...otherSetters,
        navigation,
        originalCreatedAt,
        piggyIdRef,
        amountManuallyEdited,
        setAmountSatsText,
        setCacheName,
        setCacheDescription,
        setCacheHint,
        setLnurl,
        setStage,
      });
      return {
        name,
        description,
        hint,
        lnurl,
        amount,
        stage,
        setCacheName,
        setCacheDescription,
        setCacheHint,
        setLnurl,
        label: t('huntCreateScreen.cantEditPiglet'),
      };
    },
    { initialProps },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  changeLocale('en');
  load.mockResolvedValue([piggy]);
});
afterEach(() => changeLocale('en'));

it('preserves unsaved name, description, hint and LNURL edits when translated UI rerenders', async () => {
  const h = setup();
  await waitFor(() => expect(h.result.current.name).toBe('Saved name'));
  act(() => {
    h.result.current.setCacheName('Draft name');
    h.result.current.setCacheDescription('Draft description');
    h.result.current.setCacheHint('Draft hint');
    h.result.current.setLnurl('draft-lnurl');
  });
  const oldLabel = h.result.current.label;
  await act(async () => {
    changeLocale('es');
    h.rerender({ editingId: 'piggy', fallbackCache: null, pubkey: 'author' });
  });
  expect(h.result.current.label).not.toBe(oldLabel);
  expect(h.result.current).toMatchObject({
    name: 'Draft name',
    description: 'Draft description',
    hint: 'Draft hint',
    lnurl: 'draft-lnurl',
  });
  expect(load).toHaveBeenCalledTimes(1);
});

it('finishes pending hydration across language changes and still hydrates a different edited record', async () => {
  let finish!: (all: HiddenPiggy[]) => void;
  load.mockImplementationOnce(() => new Promise((done) => (finish = done)));
  const h = setup();
  await act(async () => {
    changeLocale('es');
    h.rerender({ editingId: 'piggy', fallbackCache: null, pubkey: 'author' });
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => finish([piggy]));
  expect(h.result.current.name).toBe('Saved name');
  load.mockResolvedValue([{ ...piggy, id: 'other', name: 'Other piggy' }]);
  await act(async () => {
    h.rerender({ editingId: 'other', fallbackCache: null, pubkey: 'author' });
  });
  expect(h.result.current.name).toBe('Other piggy');
  expect(load).toHaveBeenCalledTimes(2);
});

it('still waits for signer identity before hydrating the cross-device event', async () => {
  load.mockResolvedValue([]);
  const fallbackCache: HuntCacheFallback = {
    coord: 'coord',
    hiderPubkey: 'author',
    d: 'piggy',
    name: 'Published name',
    description: 'Published description',
    hint: 'Published hint',
    createdAt: 100,
    geohash: null,
    difficulty: null,
    terrain: null,
    size: null,
    cacheType: null,
    imageUrl: null,
    expiresAt: null,
    waitSeconds: null,
    uses: null,
    isLpPiggy: true,
    payoutSats: 21,
  };
  const h = setup({ editingId: 'piggy', fallbackCache, pubkey: null });
  await act(async () => {});
  expect(h.result.current.name).toBe('');
  expect(Toast.show).not.toHaveBeenCalled();
  expect(navigation.goBack).not.toHaveBeenCalled();
  await act(async () => h.rerender({ editingId: 'piggy', fallbackCache, pubkey: 'author' }));
  expect(h.result.current).toMatchObject({ name: 'Published name', amount: '21', lnurl: '' });
  act(() => h.result.current.setCacheName('Cross-device draft'));
  await act(async () => {
    changeLocale('es');
    h.rerender({ editingId: 'piggy', fallbackCache, pubkey: 'author' });
  });
  expect(h.result.current.name).toBe('Cross-device draft');
  // No signer, no owner: records are only read once the account is known (#1781).
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith('author');
});

it('does not report a local draft missing before the signer resolves', async () => {
  load.mockResolvedValue([piggy]);
  const h = setup({ editingId: 'piggy', fallbackCache: null, pubkey: null });
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();
  expect(Toast.show).not.toHaveBeenCalled();
  expect(navigation.goBack).not.toHaveBeenCalled();
  await act(async () => h.rerender({ editingId: 'piggy', fallbackCache: null, pubkey: 'author' }));
  expect(load).toHaveBeenCalledWith('author');
  expect(h.result.current.name).toBe('Saved name');
});

it("closes a create wizard holding one account's LNURL when the account switches (#1781)", async () => {
  const h = setup({ editingId: null, fallbackCache: null, pubkey: null });
  await act(async () => h.rerender({ editingId: null, fallbackCache: null, pubkey: 'author' }));
  expect(navigation.goBack).not.toHaveBeenCalled();
  await act(async () => h.rerender({ editingId: null, fallbackCache: null, pubkey: 'other' }));
  expect(navigation.goBack).toHaveBeenCalledTimes(1);
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'info',
    text1: 'Hide a Piglet closed because you switched accounts. Nothing was saved.',
  });
  await act(async () => h.rerender({ editingId: null, fallbackCache: null, pubkey: 'third' }));
  expect(navigation.goBack).toHaveBeenCalledTimes(1);
});
