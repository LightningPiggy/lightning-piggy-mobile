// Local Repair choices survive later activity in an old group and app restarts.
// These markers affect outbound selection only; old groups keep receiving.
import type { MarmotKvBackend } from './marmotStore';

export class DmSuperseded {
  private readonly ids = new Set<string>();
  constructor(
    private readonly backend: MarmotKvBackend,
    /** A Repair replaced the group `id` (app id); it gets no more sends. */
    private readonly onSuperseded?: (id: string) => void,
  ) {}

  async load(): Promise<void> {
    for (const id of await this.backend.keys('dmSuperseded')) this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  async restart<T extends { id: string }>(
    existing: readonly T[],
    create: () => Promise<T>,
  ): Promise<T> {
    const fresh = await create();
    await this.mark(existing.map((g) => g.id));
    return fresh;
  }

  async mark(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.backend.set('dmSuperseded', id, '1');
      this.ids.add(id);
      this.onSuperseded?.(id);
    }
  }
}
