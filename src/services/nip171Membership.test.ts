import AsyncStorage from '@react-native-async-storage/async-storage';
import { nip171StatusStore } from './nip171Membership';

const OWNER = 'a'.repeat(64);
const KEY = `nip171_group_status_v1_${OWNER}`;

beforeEach(() => AsyncStorage.clear());

it('serialises concurrent updates so none is lost', async () => {
  await Promise.all(
    ['g1', 'g2', 'g3'].map((g) =>
      nip171StatusStore.update(OWNER, (all) => {
        all[g] = { status: 'declined', at: 1 };
      }),
    ),
  );
  expect(Object.keys(await nip171StatusStore.read(OWNER)).sort()).toEqual(['g1', 'g2', 'g3']);
});

it('writes nothing when the read fails or the record is corrupt', async () => {
  await nip171StatusStore.update(OWNER, (all) => {
    all.g1 = { status: 'left', at: 5 };
  });
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('io'));
  await expect(
    nip171StatusStore.update(OWNER, (all) => {
      all.g2 = { status: 'declined', at: 1 };
    }),
  ).rejects.toThrow('io');
  // g1's record survived: an empty stand-in didn't overwrite it.
  expect(await nip171StatusStore.read(OWNER)).toEqual({ g1: { status: 'left', at: 5 } });

  await AsyncStorage.setItem(KEY, 'not json');
  await expect(nip171StatusStore.update(OWNER, () => undefined)).rejects.toThrow();
  expect(await AsyncStorage.getItem(KEY)).toBe('not json');
  // Display reads stay lenient.
  expect(await nip171StatusStore.read(OWNER)).toEqual({});
});

it('rejects when the write fails, so the caller stops', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('full'));
  await expect(
    nip171StatusStore.update(OWNER, (all) => {
      all.g1 = { status: 'declined', at: 1 };
    }),
  ).rejects.toThrow('full');
  // The chain recovers for the next update.
  await nip171StatusStore.update(OWNER, (all) => {
    all.g2 = { status: 'declined', at: 1 };
  });
  expect(Object.keys(await nip171StatusStore.read(OWNER))).toEqual(['g2']);
});
