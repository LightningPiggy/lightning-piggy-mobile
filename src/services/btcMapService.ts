/**
 * Read-only consumer of Bitcoin-accepting merchant data sourced from
 * BTC Map's v4 REST API. BTC Map curates merchants from the OSM
 * commons (see project memory `BTC Map runs the commons (Nathan)`) —
 * we never write back.
 *
 * Transport: the `/v4/places/search` endpoint with `lat` + `lon` +
 * `radius_km`. BTC Map's docs explicitly recommend it for
 * "client apps without cache, which need to fetch the places on demand
 * for a small region (usually user map viewport) … you can call it
 * every time user moves the map." A 50 km radius around the user is
 * ~16 KB / ~0.2 s — versus the ~2 MB / 28k-row worldwide `/v4/places`
 * dump we used to download, cache to disk, and bbox-filter in memory.
 *
 * History: this file previously hit `/v3/places?bbox=…` (gone), then
 * Overpass, then the worldwide `/v4/places` dump + a 7-day file cache +
 * delta-sync. All of that is replaced by the per-viewport search call.
 * The last successful result is still persisted (now tiny) so the
 * offline-cold-start path has something to show. `callers pass a
 * `Bbox` (their map viewport); we convert it to the centre + a radius
 * that reaches the far corner, so the circle fully covers the
 * rectangle (with a little overshoot — extra merchants just outside
 * the viewport, which is fine).
 *
 * Closes part of #467.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { haversineMetres } from '../utils/geohash';

// Base URL for the BTC Map v4 API. Production points at api.btcmap.org,
// but a developer can swap to a local fork or tunneled endpoint by
// setting `EXPO_PUBLIC_BTC_MAP_API_BASE` in `.env` before starting
// Metro — useful while testing the in-flight upstream bbox PR. The
// value must include the `/v4` path segment but no trailing slash.
const BTC_MAP_API_BASE =
  process.env.EXPO_PUBLIC_BTC_MAP_API_BASE?.replace(/\/$/, '') ?? 'https://api.btcmap.org/v4';
const BTCMAP_V4_PLACES_URL = `${BTC_MAP_API_BASE}/places`;
const BTCMAP_V4_SEARCH_URL = `${BTC_MAP_API_BASE}/places/search`;

// Slim field list for the bulk dataset fetch. Pulled fields are
// strictly what the list / rail / map markers need:
//   - id / lat / lon : required by reshape
//   - osm:name : title (also used by the PlacesScreen search index)
//   - icon : rail glyph
//   - boosted_until : sort tie-break + "Featured" badge
//   - categories : PlacesScreen category-chip filter + search index
//   - osm:payment:lightning + osm:payment:bitcoin : payment chip
//   - osm:addr:street + osm:addr:city : address line + search index
//
// Rich fields (verified_at, lightning_address, cuisine, wheelchair,
// contact:*, opening_hours, etc.) land on PlaceDetail via a per-id
// lazy fetch (see fetchPlaceRich). Trimming this list cut the bulk
// response from ~22 MB / 7 s → ~5 MB / ~2 s on cold launch — see
// scripts/perf-explore-cold-start.sh.
const V4_FIELDS = [
  'id',
  'lat',
  'lon',
  'icon',
  'boosted_until',
  'categories',
  'osm:name',
  'osm:payment:lightning',
  'osm:payment:bitcoin',
  'osm:addr:street',
  'osm:addr:city',
].join(',');

// Rich field list — used by the per-id fetch from PlaceDetail. Mirrors
// what the detail screen actually renders (cuisine, wheelchair, contact
// links, opening hours, etc.).
const V4_FIELDS_RICH = [
  'id',
  'lat',
  'lon',
  'verified_at',
  'description',
  'icon',
  'osm_url',
  'categories',
  'boosted_until',
  'comments_count',
  'osm:cuisine',
  'osm:wheelchair',
  'osm:wheelchair:description',
  'osm:takeaway',
  'osm:delivery',
  'osm:outdoor_seating',
  'osm:brand',
  'osm:level',
  'osm:addr:floor',
  'osm:contact:twitter',
  'osm:contact:instagram',
  'osm:contact:telegram',
  'osm:contact:whatsapp',
  'phone',
  'email',
  'opening_hours',
  'osm:contact:facebook',
  'osm:name',
  'osm:description',
  'osm:addr:street',
  'osm:addr:city',
  'osm:addr:postcode',
  'osm:payment:bitcoin',
  'osm:payment:lightning',
  'osm:payment:lightning_contactless',
  'osm:payment:onchain',
  'osm:phone',
  'osm:website',
  'website',
  'osm:contact:phone',
  'osm:contact:website',
  'osm:contact:email',
  'osm:opening_hours',
  'osm:payment:lightning_address',
  'osm:lud16',
  'created_at',
  'updated_at',
].join(',');

// 5 s is enough for a healthy BTC Map v4 search response (~200-800 ms
// typical). Anything beyond that signals the API is degraded or the
// device is offline — in which case we'd rather bail fast and fall back
// to the in-memory + on-disk lastResult cache than keep the merchants
// rail in the loading shimmer. Previously this sat at 20 s, which
// produced a 14 s blank-rail freeze on every cold start where the
// network was even slightly slow (#566).
const FETCH_TIMEOUT_MS = 5_000;
// Legacy AsyncStorage key for the old worldwide dump — only referenced
// now to evict any stale multi-MB blob left over from a prior install.
const DATASET_STORAGE_KEY = '@lp:btcmap-dataset-v4u';
// Legacy file-cache name for the old worldwide dump — deleted on first
// run so it stops eating sandbox space.
const LEGACY_DATASET_FILE = 'btcmap-dataset-v4u.json';

export interface BtcMapPlace {
  id: number;
  lat: number;
  lon: number;
  /** OSM tags pulled through (un-prefixed). We surface the shape we
   * care about and leave the rest as Record so callers can dig for
   * additional keys. */
  tags: Record<string, string> & {
    name?: string;
    'addr:street'?: string;
    'addr:city'?: string;
    'addr:postcode'?: string;
    'payment:bitcoin'?: 'yes' | 'no';
    'payment:lightning'?: 'yes' | 'no';
    'payment:lightning_contactless'?: 'yes' | 'no';
    'payment:onchain'?: 'yes' | 'no';
    'contact:phone'?: string;
    'contact:website'?: string;
    'contact:email'?: string;
    /** Lightning Address. Several conventions exist in OSM tags; we read
     * the first one we find. */
    'payment:lightning_address'?: string;
    lud16?: string;
    opening_hours?: string;
  };
  /**
   * Last time a community member confirmed the merchant still accepts
   * Bitcoin. Surfaced as "Verified N days ago" in MerchantDetail.
   */
  verified_at?: string | null;
  /**
   * Free-text summary of the merchant. BTC Map curates this when set;
   * otherwise we fall back to the OSM `description` tag. Empty string
   * is normalised to null so the UI can branch on truthiness cleanly.
   */
  description?: string | null;
  /**
   * BTC Map's curated category glyph name — e.g. `storefront`, `chalet`,
   * `cafe`, `bar`, `lodging`. Used by the UI to pick a matching Lucide
   * icon for the place row / detail header. Null when BTC Map hasn't
   * categorised the merchant.
   */
  icon?: string | null;
  /**
   * Direct link to the merchant's OpenStreetMap node. Surfaced as a
   * "Suggest an edit on OpenStreetMap →" affordance — the OSM web UI
   * is the canonical place to fix bad tags / addresses / payment flags.
   */
  osm_url?: string | null;
  /**
   * Curated category list (e.g. `["cafe", "restaurant"]`). The v4
   * `/v4/places/search` endpoint no longer returns an explicit
   * `categories` field, so `reshape` falls back to the single `icon`
   * token (the v4 category/type indicator) — `["restaurant"]` etc.
   * Null only when the place has neither categories nor an icon.
   */
  categories?: string[] | null;
  /**
   * Top-level curated contact fields. BTC Map normalises these from
   * OSM + their own hand-fills, so we prefer them over `tags['contact:*']`
   * (which is often empty even when the curated field is set). Null when
   * not provided.
   */
  phone?: string | null;
  email?: string | null;
  opening_hours?: string | null;
  /**
   * Social profile URLs pulled from OSM `contact:<network>` tags.
   * Surfaced as a chip row on the contact section. Each is optional
   * and often null. `tags['contact:<network>']` carries the same value
   * if a caller would rather read straight from the bag.
   */
  facebookUrl?: string | null;
  twitterUrl?: string | null;
  instagramUrl?: string | null;
  telegramUrl?: string | null;
  whatsappUrl?: string | null;
  /**
   * Unix-seconds timestamps for the listing lifecycle. Surfaced as
   * "Listed since" / "Last updated" hints on the detail page.
   */
  createdAt?: string | null;
  updatedAt?: string | null;
  /**
   * ISO timestamp until which the listing is "boosted" — BTC Map's
   * paid-feature mechanism. Surfaced as a "Featured" pill + a sort
   * tie-break (boosted wins within the same distance band).
   */
  boostedUntil?: string | null;
  /**
   * Number of community notes attached to the merchant on BTC Map.
   * Currently surfaced as a copy line ("N community notes"); could
   * link out to BTC Map's comments page in a follow-up.
   */
  commentsCount?: number | null;
}

/**
 * Bounding box in `[minLon, minLat, maxLon, maxLat]` order — a caller's
 * map viewport. Converted to a centre + radius for the `/v4/places/search`
 * call (see `bboxToSearch`).
 */
export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

// In-memory cache of the most recent search result. Serves four
// purposes: (1) `fetchPlaceById` can resolve a tapped place without a
// network round-trip, (2) an offline / failed fetch falls back to it,
// (3) it's persisted to disk so an offline cold start still shows the
// last-seen region, (4) `peekCachedPlacesSync` lets ExploreHomeScreen
// paint the rail on the very first render (before any await resolves).
// It's small (one viewport, ~tens of places) so none of the old
// worldwide-dump problems (SQLITE_FULL, 19 s hydrate) apply.
let lastResult: BtcMapPlace[] = [];
// The user's lat/lon at the time `lastResult` was fetched. Persisted
// alongside the places so the cold-start path can sort + filter the
// cached rail before GPS resolves (otherwise `sortedMerchants` is
// empty until `pos` lands, which on a real device can be 100s of ms
// to a few seconds — the original symptom that prompted this fix).
let lastAnchor: { lat: number; lon: number } | null = null;
// Unix-ms timestamp of the last successful fetch. Feeds the
// `fetchNearestPlaces` SWR short-circuit: re-use the cached set when
// the user is close to the anchor AND the cache is recent. Null when
// nothing's been fetched yet, or when the persisted blob predates the
// field (older envelopes omit it — treated as expired, re-fetch).
let lastFetchedAtMs: number | null = null;

// Tier ladder for `fetchNearestPlaces`. Start at 25 km — covers a
// dense urban user in one round-trip (~10-30 KB) and stops there if it
// returns enough. Widen to 100 km for semi-rural users (Longstanton at
// 25 km has 7 places; at 100 km has 161). 500 km is the safety net for
// the truly remote so the rail still populates rather than stay empty.
// Each tier costs roughly its predecessor + the new ring's merchant
// density, so urban callers never pay for the wider tiers.
const NEAREST_RADIUS_TIERS_KM = [25, 100, 500] as const;

// Cache freshness rule for the `fetchNearestPlaces` short-circuit. Both
// conditions must hold to skip the network: caller is within 5 km of
// the anchor (cached set is still spatially relevant) AND the cache is
// younger than 1 h (gives BTC Map an hour to surface new merchants).
// Pull-to-refresh bypasses both via the `force` option.
const FRESH_ANCHOR_DISTANCE_M = 5_000;
const FRESH_TTL_MS = 60 * 60 * 1000;

// Convert a viewport bbox into the `lat` / `lon` / `radius_km` the
// `/v4/places/search` endpoint wants. Centre is the bbox midpoint; the
// radius reaches the far corner so the search circle fully covers the
// rectangle (with a little overshoot — extra merchants just outside the
// viewport, which callers are fine with). Radius is clamped to a sane
// floor so a pinpoint-zoomed map still returns something, and to a
// ceiling so a continental zoom-out can't request (and JSON.parse, on
// the JS thread) a huge slice of the worldwide dataset — an unclamped
// zoom-out fetched 6,344 merchants in one call and was half of the
// #1067 crash. 250 km ≈ a whole metro region plus its hinterland;
// past that the map is a density overview, not a merchant browser.
const MAX_VIEWPORT_SEARCH_RADIUS_KM = 250;
const bboxToSearch = (b: Bbox): { lat: number; lon: number; radiusKm: number } => {
  const lat = (b.minLat + b.maxLat) / 2;
  // Wrapped longitude midpoint: an antimeridian-crossing bbox
  // (minLon > maxLon) would centre near 0° with a plain (min+max)/2 and
  // fetch the wrong part of the world. Same treatment as bboxCentre /
  // geohashPrefixesForBbox.
  const rawLon = b.minLon > b.maxLon ? (b.minLon + b.maxLon + 360) / 2 : (b.minLon + b.maxLon) / 2;
  const lon = ((rawLon + 540) % 360) - 180;
  // Radius reaches the FARTHEST corner (they differ once the centre's
  // latitude is off-equator, and haversine's trig wraps Δlon correctly
  // across the dateline).
  const cornerMetres = Math.max(
    haversineMetres({ lat, lon }, { lat: b.maxLat, lon: b.maxLon }),
    haversineMetres({ lat, lon }, { lat: b.maxLat, lon: b.minLon }),
    haversineMetres({ lat, lon }, { lat: b.minLat, lon: b.maxLon }),
    haversineMetres({ lat, lon }, { lat: b.minLat, lon: b.minLon }),
  );
  const radiusKm = Math.min(
    MAX_VIEWPORT_SEARCH_RADIUS_KM,
    Math.max(1, Math.ceil(cornerMetres / 1000)),
  );
  return { lat, lon, radiusKm };
};

// v4 returns each tag as `osm:<key>` at the top level. Reshape into the
// historical `BtcMapPlace.tags` map so downstream code (acceptsLightning,
// formatAddress, etc.) keeps working without per-call rewrites.
const reshape = (raw: Record<string, unknown>): BtcMapPlace | null => {
  const id = raw['id'];
  const lat = raw['lat'];
  const lon = raw['lon'];
  if (typeof id !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') return null;
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('osm:')) tags[k.slice(4)] = v;
  }
  // The `/v4/places/search` endpoint returns a *curated* shape — top-level
  // `name`, `address`, `website`, `phone`, … — and ignores `osm:`-prefixed
  // field requests entirely. The bulk `/v4/places` + per-id endpoints use
  // the raw `osm:` tags. Fold the curated top-level fields into `tags` so
  // everything downstream (rail cards, formatAddress, contact rows) works
  // regardless of which endpoint produced the record. `osm:` values, when
  // present, win — they're the raw source of truth.
  const foldCurated = (curatedKey: string, tagKey: string): void => {
    const v = raw[curatedKey];
    if (typeof v === 'string' && v.trim().length > 0 && !tags[tagKey]) {
      tags[tagKey] = v.trim();
    }
  };
  foldCurated('name', 'name');
  foldCurated('address', 'addr:full');
  foldCurated('website', 'contact:website');
  foldCurated('phone', 'contact:phone');
  foldCurated('email', 'contact:email');
  foldCurated('opening_hours', 'opening_hours');
  foldCurated('facebook', 'contact:facebook');
  foldCurated('twitter', 'contact:twitter');
  foldCurated('instagram', 'contact:instagram');
  foldCurated('telegram', 'contact:telegram');
  const verified_at =
    typeof raw['verified_at'] === 'string' ? (raw['verified_at'] as string) : null;
  // Prefer the curated top-level description; fall back to the raw OSM
  // tag if BTC Map hasn't normalised one for this place. Trim and treat
  // empty strings as missing.
  const rawDesc =
    typeof raw['description'] === 'string'
      ? (raw['description'] as string)
      : typeof tags['description'] === 'string'
        ? tags['description']
        : null;
  const description = rawDesc && rawDesc.trim().length > 0 ? rawDesc.trim() : null;
  const icon = typeof raw['icon'] === 'string' ? (raw['icon'] as string) : null;
  // Bulk / per-id endpoints return `osm_url`; the search endpoint returns
  // `osm_id` (e.g. `node:12098197068`). Derive the URL from the id when
  // only the latter is present so the "View on OSM" / verify links work
  // from search-sourced records too.
  const osmIdRaw = typeof raw['osm_id'] === 'string' ? (raw['osm_id'] as string) : null;
  const osmIdMatch = osmIdRaw?.match(/^(node|way|relation):(\d+)$/i);
  const osm_url =
    typeof raw['osm_url'] === 'string'
      ? (raw['osm_url'] as string)
      : osmIdMatch
        ? `https://www.openstreetmap.org/${osmIdMatch[1].toLowerCase()}/${osmIdMatch[2]}`
        : null;
  // BTC Map's v4 `/v4/places/search` endpoint stopped returning `categories`
  // (the field is absent on every record now) — verified live against the API.
  // It does return a single `icon` token (`restaurant`, `cafe`, `diamond`…) as
  // the v4 category/type indicator. Fall back to deriving categories from that
  // icon when `categories` is missing/empty, so the Explore/Map/Places filter
  // populates again (#860). Keep using `categories` verbatim if the API ever
  // restores it — fall back, don't replace.
  // Normalize each token the same way other string fields are (trim + drop
  // empty/whitespace-only) so blank tokens can't leak into `place.categories`
  // and become blank filter chips / unstable `key={cat}` + testIDs downstream.
  const normalizeTokens = (tokens: string[]): string[] =>
    tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  const explicitCategories = Array.isArray(raw['categories'])
    ? normalizeTokens(
        (raw['categories'] as unknown[]).filter((x): x is string => typeof x === 'string'),
      )
    : [];
  const iconCategories = icon ? normalizeTokens([icon]) : [];
  const derivedCategories = explicitCategories.length > 0 ? explicitCategories : iconCategories;
  const categories = derivedCategories.length > 0 ? derivedCategories : null;
  // Curated top-level fields > OSM-prefixed tag fallbacks. BTC Map
  // ships these only when their team or the OSM tag has them populated;
  // an empty string is normalised to null so the UI can branch cleanly.
  const pickStr = (k: string): string | null => {
    const v = raw[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return null;
  };
  const phone = pickStr('phone') ?? tags['contact:phone'] ?? tags['phone'] ?? null;
  const email = pickStr('email') ?? tags['contact:email'] ?? null;
  const opening_hours = pickStr('opening_hours') ?? tags['opening_hours'] ?? null;
  const facebookUrl = tags['contact:facebook'] ?? null;
  const twitterUrl = tags['contact:twitter'] ?? null;
  const instagramUrl = tags['contact:instagram'] ?? null;
  const telegramUrl = tags['contact:telegram'] ?? null;
  const whatsappUrl = tags['contact:whatsapp'] ?? null;
  const commentsCount =
    typeof raw['comments_count'] === 'number' ? (raw['comments_count'] as number) : null;
  const createdAt = pickStr('created_at');
  const updatedAt = pickStr('updated_at');
  const boostedUntil = pickStr('boosted_until');
  return {
    id,
    lat,
    lon,
    tags,
    verified_at,
    description,
    icon,
    osm_url,
    categories,
    phone,
    email,
    opening_hours,
    facebookUrl,
    twitterUrl,
    instagramUrl,
    telegramUrl,
    whatsappUrl,
    createdAt,
    updatedAt,
    boostedUntil,
    commentsCount,
  };
};

// File-system cache of the last successful search result. Lives in the
// document sandbox (survives app upgrades). Tiny now (~one viewport's
// worth of places) — the old worldwide-dump file (and its SQLITE_FULL /
// slow-hydrate problems) is gone; we evict it on first run.
const lastResultFile = () => new File(Paths.document, 'btcmap-last-result.json');

// Persisted shape of the last successful search result. Wrapping the
// raw array in an envelope lets us record the user position that
// anchored the search so the next cold start can paint a sorted rail
// before GPS resolves. Older blobs were a bare BtcMapPlace[] — when
// we read one we treat anchor as null and let the live fetch overwrite.
//
// `fetchedAtMs` was added later to gate the SWR short-circuit; older
// envelopes omit it, which we read as "expired" (re-fetch immediately).
// Field is optional so the schema stays at v: 1.
interface PersistedLastResult {
  v: 1;
  anchor: { lat: number; lon: number } | null;
  places: BtcMapPlace[];
  fetchedAtMs?: number;
}

// Drop the legacy worldwide-dump cache (file + AsyncStorage row) so it
// stops eating sandbox space. Fire-and-forget, runs once.
let legacyEvicted = false;
const evictLegacyCache = (): void => {
  if (legacyEvicted) return;
  legacyEvicted = true;
  try {
    const legacy = new File(Paths.document, LEGACY_DATASET_FILE);
    if (legacy.exists) legacy.delete();
  } catch {
    // best-effort
  }
  AsyncStorage.removeItem(DATASET_STORAGE_KEY).catch(() => {});
};

const persistLastResult = (
  places: BtcMapPlace[],
  anchor: { lat: number; lon: number } | null,
  fetchedAtMs: number | null,
): void => {
  try {
    const f = lastResultFile();
    if (f.exists) f.delete();
    f.create();
    const envelope: PersistedLastResult = {
      v: 1,
      anchor,
      places,
      ...(fetchedAtMs !== null ? { fetchedAtMs } : {}),
    };
    f.writeSync(JSON.stringify(envelope));
  } catch {
    // Persist failures are non-fatal — `lastResult` still serves the
    // session; next launch just re-fetches.
  }
};

// Hydrate `lastResult` + `lastAnchor` from disk. Two paths use it:
//   1. The offline-cold-start fallback inside `fetchPlacesInBbox` when
//      the network call fails.
//   2. The Explore hub's first render — `peekCachedPlacesSync` reads
//      the synchronous mirror after this resolves, so cold launches
//      paint cached merchants instantly instead of waiting for GPS +
//      a network round-trip.
// One-shot — `hydratePromise` is reused on every subsequent call.
let hydratePromise: Promise<void> | null = null;
const hydrateLastResult = async (): Promise<void> => {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const f = lastResultFile();
      if (!f.exists) return;
      // [PerfBlock] hydrating the merchant cache file means a single
      // synchronous JSON.parse on whatever was written last time
      // (the search result can be 100s of KB for dense urban bboxes).
      // Suspected contributor to the post-mount JS-thread freeze
      // tracked in #554 — bracket so we can confirm.
      const __t0 = performance.now();
      const raw = await f.text();
      const __tParse = performance.now();
      const parsed = JSON.parse(raw) as PersistedLastResult | BtcMapPlace[];
      const __tDone = performance.now();
      // v1 envelope shape — anchor + places. Older builds wrote a bare
      // BtcMapPlace[] (no anchor); treat that as places-only and let
      // the next fetch backfill the anchor.
      let placeCount = 0;
      if (Array.isArray(parsed)) {
        if (lastResult.length === 0) lastResult = parsed;
        placeCount = parsed.length;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.places)) {
        if (lastResult.length === 0) lastResult = parsed.places;
        if (!lastAnchor && parsed.anchor) lastAnchor = parsed.anchor;
        if (lastFetchedAtMs === null && typeof parsed.fetchedAtMs === 'number') {
          lastFetchedAtMs = parsed.fetchedAtMs;
        }
        placeCount = parsed.places.length;
      }
      const readMs = Math.round(__tParse - __t0);
      const parseMs = Math.round(__tDone - __tParse);
      if (readMs + parseMs > 100) {
        console.log(
          `[PerfBlock] hydrateLastResult: ${placeCount} places, read ${readMs}ms + parse ${parseMs}ms (raw ${raw.length}B)`,
        );
      }
    } catch {
      // Corrupt cache shouldn't break anything — happy path re-fetches.
    }
  })();
  return hydratePromise;
};

/**
 * Kick the (one-shot, memoised) merchant-cache hydration. Previously this fired
 * at module-import time — but `ExploreHomeScreen` imports this file, and that
 * screen is an eager tab root, so the import-time `void hydrateLastResult()`
 * ran a synchronous `JSON.parse` of a 100s-of-KB cache file ON THE COLD-START
 * CRITICAL PATH (audit HIGH 1 fallback). Moving the kick behind this exported
 * function lets the Explore hub trigger it on first focus instead, off the
 * boot path. Returns the shared promise so callers can re-seed once it
 * resolves. Idempotent — safe to call repeatedly.
 */
export const kickPlacesHydration = (): Promise<void> => hydrateLastResult();

/**
 * The last successful search result — in memory, or hydrated from disk
 * on a cold start. Lets a screen paint instantly (stale-while-
 * revalidate) before `fetchPlacesInBbox` returns the fresh set.
 */
export const getCachedPlaces = async (): Promise<BtcMapPlace[]> => {
  if (lastResult.length === 0) await hydrateLastResult();
  return lastResult;
};

// Synchronous peek at the in-memory mirror. Used by `useState`
// initialisers on the Explore hub so the first render already shows
// cached merchants — no `useEffect → setState` round-trip. Returns
// an empty array until module-import hydration finishes; the existing
// async `getCachedPlaces()` path covers the still-warming-up case.
export const peekCachedPlacesSync = (): BtcMapPlace[] => lastResult;

// The user position that anchored `peekCachedPlacesSync`. Surfaced so
// the Explore hub can sort + filter the cached rail by distance from
// the last known location — before GPS resolves. Returns null when
// we've never successfully fetched (first-ever launch, no prior
// persist) or when the cached blob predates the v1 envelope shape.
export const peekCachedAnchorSync = (): { lat: number; lon: number } | null => lastAnchor;

// Unix-ms timestamp of the last successful fetch, read off the in-memory
// mirror. Lets a cache-first screen decide whether its synchronously-
// seeded snapshot is stale (and so worth a visible background refresh)
// without an async round-trip. Null until a fetch has succeeded this
// session or the persisted envelope (which may predate the field) has
// hydrated.
export const peekCachedFetchedAtSync = (): number | null => lastFetchedAtMs;

/**
 * Outcome of a viewport fetch that distinguishes a *genuine* result from
 * a fallback-to-cache. `fetchPlacesInBbox` collapses errors into the last
 * cached array, so its return value alone can't tell "0 places in this
 * area" (authoritative empty) from "the network blipped" (stale cache).
 * Cache-first callers (the Places screen's reconciliation) need that
 * distinction so a real empty area can legitimately clear the list while
 * a transient failure keeps whatever was on screen.
 *
 *   - `ok: true`  — the search endpoint responded; `places` is its
 *     authoritative result (which may legitimately be `[]`).
 *   - `ok: false` — the fetch failed/aborted; `places` is the stale
 *     fallback (in-memory mirror or hydrated disk cache, possibly `[]`).
 */
export interface FetchPlacesResult {
  ok: boolean;
  places: BtcMapPlace[];
}

/**
 * Fetch merchants for a viewport, returning a {@link FetchPlacesResult}
 * that distinguishes an authoritative response (`ok: true`, even when
 * empty) from an offline/error fallback to cache (`ok: false`). Converts
 * the caller's `bbox` to a centre + radius and hits BTC Map's
 * `/v4/places/search` endpoint — the one their docs recommend calling
 * "every time user moves the map". ~16 KB / ~0.2 s for a 50 km radius.
 *
 * The result is cached in memory (`lastResult`) and persisted to disk.
 * On a network failure we fall back to whatever's cached so the rail
 * isn't empty offline. Callers should still debounce map-pan / zoom.
 */
export const fetchPlacesInBboxResult = async (bbox: Bbox): Promise<FetchPlacesResult> => {
  evictLegacyCache();
  const { lat, lon, radiusKm } = bboxToSearch(bbox);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url =
      `${BTCMAP_V4_SEARCH_URL}?lat=${lat}&lon=${lon}&radius_km=${radiusKm}` +
      `&fields=${encodeURIComponent(V4_FIELDS)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`BTC Map v4 search ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>[];
    const places = (Array.isArray(json) ? json : [])
      .map(reshape)
      .filter((p): p is BtcMapPlace => p !== null);
    lastResult = places;
    // Anchor the cache at the centre of the requested viewport. Next
    // cold start uses this to sort + filter the rail before GPS lands.
    lastAnchor = { lat, lon };
    lastFetchedAtMs = Date.now();
    persistLastResult(places, lastAnchor, lastFetchedAtMs);
    // Authoritative — an empty `places` here means "no merchants in this
    // viewport", not "the request failed".
    return { ok: true, places };
  } catch {
    // Offline / timeout / server error — fall back to the last cached
    // result (in memory, or hydrated from disk on a cold start). Flagged
    // `ok: false` so cache-first callers keep the shown list rather than
    // treating the fallback as an authoritative empty.
    if (lastResult.length === 0) await hydrateLastResult();
    return { ok: false, places: lastResult };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch merchants for a viewport, returning just the place array. Thin
 * wrapper over {@link fetchPlacesInBboxResult} that drops the `ok` flag —
 * on a network failure the array is the last cached result, so callers
 * that don't need to distinguish empty-vs-error (Map, Explore rail,
 * geofence) stay unchanged. Cache-first callers should prefer
 * {@link fetchPlacesInBboxResult} so a genuine empty area can clear.
 */
export const fetchPlacesInBbox = async (bbox: Bbox): Promise<BtcMapPlace[]> =>
  (await fetchPlacesInBboxResult(bbox)).places;

// Single-radius shot at `/v4/places/search`. Returns null on a network
// failure so the caller can decide whether to widen, retry, or fall
// back to cache. The slim `V4_FIELDS` set is reused — same fields as
// `fetchPlacesInBbox`, so the rail + mini-map work identically.
const fetchPlacesAtRadius = async (
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<BtcMapPlace[] | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url =
      `${BTCMAP_V4_SEARCH_URL}?lat=${lat}&lon=${lon}&radius_km=${radiusKm}` +
      `&fields=${encodeURIComponent(V4_FIELDS)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>[];
    return (Array.isArray(json) ? json : [])
      .map(reshape)
      .filter((p): p is BtcMapPlace => p !== null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch a small set of merchants centred on the user, walking radii
 * 25 → 100 → 500 km until at least `minCount` come back. Returns the
 * first tier that satisfies the floor (or whatever the final 500 km
 * tier returned, even if it's still short — better an under-populated
 * rail than an empty one).
 *
 * SWR short-circuit: when `lastAnchor` is within 5 km of the caller
 * AND the cached set is younger than 1 h, returns the cache without
 * touching the network. Pull-to-refresh callers pass `{ force: true }`
 * to bypass.
 *
 * Designed for the Explore hub's "Places near you" rail + the
 * decorative mini-map. PlacesScreen / HuntScreen keep using the
 * viewport-driven `fetchPlacesInBbox` — they have a map the user
 * actively pans, so list ↔ map coupling matters there.
 */
export const fetchNearestPlaces = async (
  lat: number,
  lon: number,
  minCount = 10,
  opts: { force?: boolean } = {},
): Promise<BtcMapPlace[]> => {
  evictLegacyCache();

  if (!opts.force && lastAnchor && lastFetchedAtMs !== null && lastResult.length > 0) {
    const distMetres = haversineMetres(lastAnchor, { lat, lon });
    const ageMs = Date.now() - lastFetchedAtMs;
    if (distMetres <= FRESH_ANCHOR_DISTANCE_M && ageMs <= FRESH_TTL_MS) {
      return lastResult;
    }
  }

  for (let i = 0; i < NEAREST_RADIUS_TIERS_KM.length; i++) {
    const radiusKm = NEAREST_RADIUS_TIERS_KM[i];
    const places = await fetchPlacesAtRadius(lat, lon, radiusKm);
    if (places === null) continue;
    const isLastTier = i === NEAREST_RADIUS_TIERS_KM.length - 1;
    if (places.length >= minCount || isLastTier) {
      lastResult = places;
      lastAnchor = { lat, lon };
      lastFetchedAtMs = Date.now();
      persistLastResult(places, lastAnchor, lastFetchedAtMs);
      return places;
    }
  }

  // Every tier failed (network down across all attempts). Fall back to
  // whatever was cached so the rail isn't blank offline.
  if (lastResult.length === 0) await hydrateLastResult();
  return lastResult;
};

/**
 * Resolve a place by id. Checks the last search result first (the
 * tapped place is almost always in the viewport that surfaced it),
 * then falls back to a per-id `/v4/places/{id}` fetch via
 * `fetchPlaceRich`.
 */
export const fetchPlaceById = async (id: number): Promise<BtcMapPlace | null> => {
  const hit = lastResult.find((p) => p.id === id);
  if (hit) return hit;
  if (lastResult.length === 0) {
    await hydrateLastResult();
    const cached = lastResult.find((p) => p.id === id);
    if (cached) return cached;
  }
  return fetchPlaceRich(id);
};

/**
 * Resolve a Lightning Address from a place's OSM tags. Tries common
 * tag variants in order; returns null if none present.
 */
export const lightningAddressOf = (place: BtcMapPlace): string | null =>
  place.tags['payment:lightning_address'] ?? place.tags.lud16 ?? null;

/**
 * Fetch the rich field set for a single place by id. PlaceDetail
 * opens with the slim listing already in memory, then overlays the
 * rich shape (cuisine, contact links, opening_hours, …) onto it once
 * this resolves. Returns null on any failure — the slim record is
 * still usable.
 */
export const fetchPlaceRich = async (id: number): Promise<BtcMapPlace | null> => {
  try {
    const url = `${BTCMAP_V4_PLACES_URL}/${id}?fields=${encodeURIComponent(V4_FIELDS_RICH)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return reshape(json);
  } catch {
    return null;
  }
};

/**
 * Extract the OSM `<type>:<id>` token (e.g. `node:12062799158`) from a
 * place's `osm_url`. BTC Map URL routes use this shape — both the
 * verify-location form and the merchant landing page expect it. Returns
 * null when the URL doesn't match (malformed entries, ways/relations
 * we don't yet support).
 */
const osmRef = (place: BtcMapPlace): string | null => {
  if (!place.osm_url) return null;
  const m = place.osm_url.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/i);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : null;
};

/**
 * BTC Map's community-verification form. Submitting it flags the merchant
 * to a "Shadowy Supertagger" who then pushes the new `survey:date` /
 * `check_date` tag back to OpenStreetMap; BTC Map re-ingests OSM every
 * ~10 minutes so the verify date refreshes on its own.
 *
 * No auth needed in our app — we just hand off to the existing web form.
 */
export const btcMapVerifyUrl = (place: BtcMapPlace): string | null => {
  const ref = osmRef(place);
  return ref ? `https://btcmap.org/verify-location?id=${ref}` : null;
};

/**
 * Public BTC Map landing page for the merchant — friendlier UX than the
 * raw OSM node URL for non-OSM users, and surfaces the "Suggest an
 * edit" / "Verify" affordances BTC Map already builds.
 */
export const btcMapMerchantUrl = (place: BtcMapPlace): string | null => {
  const ref = osmRef(place);
  return ref ? `https://btcmap.org/merchant/${ref}` : null;
};

export const acceptsLightning = (place: BtcMapPlace): boolean =>
  place.tags['payment:lightning'] === 'yes' ||
  place.tags['payment:lightning_contactless'] === 'yes';

/**
 * True when the listing has paid BTC Map to feature it for a window
 * that hasn't expired yet. Drives the "Featured" pill + a tie-break
 * in distance-sorted lists.
 */
export const isBoosted = (place: BtcMapPlace): boolean => {
  if (!place.boostedUntil) return false;
  const t = Date.parse(place.boostedUntil);
  return Number.isFinite(t) && t > Date.now();
};

export const acceptsOnchain = (place: BtcMapPlace): boolean =>
  place.tags['payment:onchain'] === 'yes' || place.tags['payment:bitcoin'] === 'yes';

/**
 * Human-readable address synthesised from the tags BTC Map / OSM
 * exposes. Falls back to lat/lon if no address tags are set.
 */
export const formatAddress = (place: BtcMapPlace): string => {
  // `addr:full` is the curated single-line address from `/v4/places/search`.
  // The bulk / per-id endpoints instead expose the raw `addr:*` component
  // tags — join those. Fall back to coordinates when neither is present.
  if (place.tags['addr:full']) return place.tags['addr:full'];
  const parts = [place.tags['addr:street'], place.tags['addr:city'], place.tags['addr:postcode']]
    .filter(Boolean)
    .join(', ');
  return parts || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
};

/**
 * Days since the place was last community-verified, or null if never
 * verified. UI surfaces this as "Verified 3 days ago" — when null we
 * display nothing rather than implying staleness.
 */
export const daysSinceVerified = (place: BtcMapPlace): number | null => {
  if (!place.verified_at) return null;
  const ts = Date.parse(place.verified_at);
  if (Number.isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1_000));
};

// Warm the offline-fallback cache from disk and evict the legacy
// worldwide dump. Cheap, fire-and-forget — called by ExploreHomeScreen
// on mount so the disk read overlaps location resolution. The happy
// path always hits the network; this only matters when the first
// `fetchPlacesInBbox` call fails (offline cold start).
export const prefetchDataset = (): void => {
  evictLegacyCache();
  hydrateLastResult().catch(() => {});
};

/**
 * Test-only escape hatch — `lastResult` + the hydrate promise survive
 * across unit-test invocations otherwise.
 */
export const __resetCacheForTest = (): void => {
  lastResult = [];
  lastAnchor = null;
  lastFetchedAtMs = null;
  hydratePromise = null;
  legacyEvicted = false;
  try {
    const f = lastResultFile();
    if (f.exists) f.delete();
  } catch {
    // best-effort
  }
};

/**
 * Public force-refresh — drops the cached result so the next
 * `fetchPlacesInBbox` re-hits the search endpoint. Called from the
 * pull-to-refresh handler on the Explore hub so newly-boosted listings
 * (or fresh verifications) show up immediately.
 */
export const refreshDataset = async (): Promise<void> => {
  lastResult = [];
  lastAnchor = null;
  lastFetchedAtMs = null;
  hydratePromise = null;
  try {
    const f = lastResultFile();
    if (f.exists) f.delete();
  } catch {
    // Best-effort — even if the wipe fails the next fetch overwrites it.
  }
};
