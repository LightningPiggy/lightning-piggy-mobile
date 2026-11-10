import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
import { createMapPinChassis } from './mapPinChassis';

// Presentation for the shared MapLibre mini-map (LibreMiniMap). Extracted
// per the standing "styles live in their own file" convention (CLAUDE.md →
// File size and modularity) — also keeps the component under the 1,000-line
// cap once the friends-sharing + me-avatar markers landed.
export const createLibreMiniMapStyles = (colors: Palette) =>
  StyleSheet.create({
    // Matches ExploreMiniMap's container styling exactly so the swap is
    // visually neutral. Fixed height + horizontal margins + corner
    // radius + overflow:hidden to clip the map to the rounded corners.
    container: {
      height: 200,
      marginHorizontal: 16,
      marginBottom: 18,
      borderRadius: 14,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      position: 'relative',
    },
    // Fill variant for MapScreen / LocationPickerSheet — no fixed height,
    // no margins, no corner radius. The parent owns layout.
    containerFill: {
      flex: 1,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      position: 'relative',
    },
    map: { flex: 1 },
    // Wrapper that centres the dot inside the pulsing halo. Without it
    // Marker would anchor the top-left of the halo at the lng/lat, off
    // by half the halo diameter.
    userMarkerWrap: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Blue dot at the same 22 px diameter as the merchant / cache /
    // event pin chassis so the GPS marker reads as a peer rather than a
    // smaller secondary element. The accuracy halo sits behind it.
    // No zIndex so merchant / cache / event pins layered on top of the
    // user dot remain tappable. The user-dot Marker is decorative — it
    // has no onPress — so being underneath a clickable pin is the right
    // visual + tap behaviour. (Previously zIndex:2 made the dot capture
    // taps on co-located pins like Bee Happy Farm.)
    userDot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: '#2D88FF',
      borderWidth: 2,
      borderColor: colors.white,
    },
    // "Me" dot wearing my own avatar — a bit larger than the 22 px blue
    // dot so the face is legible, with the white ring + blue backing so it
    // still reads as "me" and the accuracy halo lines up behind it.
    userAvatarDot: {
      width: 32,
      height: 32,
      borderRadius: 16,
      overflow: 'hidden',
      backgroundColor: '#2D88FF',
      borderWidth: 2,
      borderColor: colors.white,
    },
    userAvatarImage: {
      ...StyleSheet.absoluteFill,
      borderRadius: 16,
    },
    // Subtle "I'm here" pulse around the user dot. The geographic
    // accuracy halo (rendered as a MapLibre fill layer behind the
    // marker) is the precision indicator; this pulse is purely a
    // helps-find-yourself affordance.
    userDotPulse: {
      position: 'absolute',
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(45, 136, 255, 0.22)',
    },
    // Shared pin chassis — circular white-bordered chip carrying the
    // category Lucide glyph. Spreads the shared `createMapPinChassis` so
    // CacheMapMarker's cache pin and these merchant / event pins stay
    // visually in sync by construction.
    pin: createMapPinChassis(colors),
    pinLn: { backgroundColor: colors.brandPink },
    pinOnchain: { backgroundColor: '#F7931A' },
    pinPiglet: { backgroundColor: colors.brandPink },
    pinCache: { backgroundColor: colors.cachePurple },
    pinEvent: { backgroundColor: colors.eventViolet },
    // Peer avatar chip. 28 px circle, white ring so it stands off the
    // map tiles; the silhouette + photo are centred and clipped to the
    // circle via overflow:hidden.
    profileMarker: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 2,
      borderColor: colors.white,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    profileMarkerImage: {
      ...StyleSheet.absoluteFill,
      borderRadius: 14,
    },
    zoomColumn: {
      position: 'absolute',
      top: 10,
      left: 10,
      gap: 6,
    },
    zoomButton: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: 'rgba(255,255,255,0.95)',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    openBadge: {
      position: 'absolute',
      bottom: 10,
      right: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: 'rgba(236, 0, 140, 0.92)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 100,
    },
    openBadgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },
    crosshairWrap: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      marginTop: -18,
      marginLeft: -18,
    },
    // 34 px clears the MapLibre attribution logo + © OSM text strip
    // that the native SDK pins to the bottom-left edge. Without this
    // bump the recenter / legend buttons overlap the attribution and
    // it reads as a layout bug.
    recenterButton: {
      position: 'absolute',
      bottom: 34,
      left: 10,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    // Legend sits above recenter when both exist (interactive mode);
    // otherwise sits at the bottom-left on its own.
    legendButtonAboveRecenter: {
      position: 'absolute',
      bottom: 76,
      left: 10,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    legendButton: {
      position: 'absolute',
      bottom: 34,
      left: 10,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
  });

export type LibreMiniMapStyles = ReturnType<typeof createLibreMiniMapStyles>;
