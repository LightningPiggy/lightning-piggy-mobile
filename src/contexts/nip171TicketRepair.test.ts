import { deleteDmMessagesByIds, selectDmEventIdsOfKind } from '../services/dmDb';
import { querySyncAbortable } from '../services/relayQuery';
import { repairMisfiledNip171Tickets } from './nip171TicketRepair';

jest.mock('../services/dmDb', () => ({
  selectDmEventIdsOfKind: jest.fn(async () => ['w1', 'w2']),
  deleteDmMessagesByIds: jest.fn(async () => undefined),
}));
jest.mock('../services/nip171Groups', () => ({ ingestNip171Ticket: jest.fn(async () => true) }));
jest.mock('../services/nostrService', () => ({ pool: {} }));
jest.mock('../services/relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: jest.fn(() => ({
    kind: 1014,
    pubkey: 'g',
    created_at: 1,
    tags: [],
    content: '',
  })),
}));

const key = new Uint8Array(32);

describe('repairMisfiledNip171Tickets', () => {
  it('removes only the rows whose ticket it recovered', async () => {
    (querySyncAbortable as jest.Mock).mockResolvedValueOnce([{ id: 'w1' }]);
    expect(await repairMisfiledNip171Tickets('me', key, ['wss://r'])).toBe(1);
    expect(deleteDmMessagesByIds).toHaveBeenCalledWith('me', ['w1']);
  });

  it('keeps every row when the relays return nothing', async () => {
    (deleteDmMessagesByIds as jest.Mock).mockClear();
    (querySyncAbortable as jest.Mock).mockResolvedValueOnce([]);
    expect(await repairMisfiledNip171Tickets('other', key, ['wss://r'])).toBe(0);
    expect(deleteDmMessagesByIds).not.toHaveBeenCalled();
  });

  it('tries again later when there was nothing to repair yet', async () => {
    jest.mocked(selectDmEventIdsOfKind).mockResolvedValueOnce([]);
    expect(await repairMisfiledNip171Tickets('later', key, ['wss://r'])).toBe(0);
    (querySyncAbortable as jest.Mock).mockResolvedValueOnce([{ id: 'w1' }]);
    expect(await repairMisfiledNip171Tickets('later', key, ['wss://r'])).toBe(1);
  });

  it('runs once per account per session', async () => {
    expect(await repairMisfiledNip171Tickets('me', key, ['wss://r'])).toBe(0);
  });
});
