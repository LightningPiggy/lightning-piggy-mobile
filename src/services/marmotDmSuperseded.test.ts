import { DmSuperseded } from './marmotDmSuperseded';
import { pickDm } from './marmotDmChoice';
import { createMemoryMarmotBackend } from './marmotStore';

it('persists Repair across restart, prefers the fresh group and falls back if it disappears', async () => {
  const backend = createMemoryMarmotBackend();
  const old = { id: 'old', createdAt: 1, activityAt: 999 };
  const fresh = { id: 'fresh', createdAt: 2, activityAt: 2 };
  await new DmSuperseded(backend).restart([old], async () => fresh);
  const restored = new DmSuperseded(backend);
  await restored.load();
  expect(pickDm([old, fresh], (id) => restored.has(id))).toBe(fresh);
  expect(pickDm([old], (id) => restored.has(id))).toBe(old);
});

it('does not supersede the working group when Repair fails', async () => {
  const markers = new DmSuperseded(createMemoryMarmotBackend());
  await expect(
    markers.restart([{ id: 'old' }], async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(markers.has('old')).toBe(false);
});
