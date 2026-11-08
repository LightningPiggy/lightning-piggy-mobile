// The two forms of a Marmot chat's id, and the one place that converts
// between them. The app (group lists, routes, sends) uses `marmot:<hex>` so a
// Marmot group can't be mistaken for a NIP-17 one; the MLS state, device
// tracker and invitation queues use the raw MLS group id (hex). Convert at
// the boundary with these helpers rather than slicing prefixes by hand.

/** App-level group id prefix, distinguishing Marmot groups from NIP-17 ones. */
export const MARMOT_GROUP_ID_PREFIX = 'marmot:';

export const toAppGroupId = (mlsGroupIdHex: string) => `${MARMOT_GROUP_ID_PREFIX}${mlsGroupIdHex}`;

export const isMarmotGroupId = (id: string) => id.startsWith(MARMOT_GROUP_ID_PREFIX);

/** The MLS group id (hex) — from an app id (`marmot:<hex>`) or already raw. */
export const toMlsGroupId = (id: string) =>
  isMarmotGroupId(id) ? id.slice(MARMOT_GROUP_ID_PREFIX.length) : id;
