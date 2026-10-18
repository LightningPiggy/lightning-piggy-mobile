import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { PiggyBank, MapPin } from 'lucide-react-native';
import type { ParsedCache } from '../services/nostrPlacesService';
import type { Palette } from '../styles/palettes';
import { createExploreHomeRailStyles } from '../styles/ExploreHomeRail.styles';
import { formatDistance } from '../utils/geohash';
import { LpPayoutBadge } from './LpPayoutBadge';

const CacheCard: React.FC<{
  cache: ParsedCache;
  distance: number;
  onPress: () => void;
  colors: Palette;
  styles: ReturnType<typeof createExploreHomeRailStyles>;
}> = ({ cache, distance, onPress, colors, styles }) => (
  <TouchableOpacity style={styles.card} onPress={onPress} testID={`cache-card-${cache.d}`}>
    <View style={styles.cardThumbWrap}>
      {cache.imageUrl ? (
        <Image
          source={{ uri: cache.imageUrl }}
          style={styles.cardThumb}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        // Same-shape placeholder so cards align visually whether or
        // not the hider attached a hint photo. LP Piggies get a pink
        // panel + piggy glyph; vanilla NIP-GC caches get a slate
        // panel + map-pin glyph.
        <View
          style={[
            styles.cardThumb,
            styles.cardThumbPlaceholder,
            cache.isLpPiggy ? styles.cardIconLightning : styles.cardIconStandard,
          ]}
        >
          {cache.isLpPiggy ? (
            <PiggyBank size={32} color={colors.white} strokeWidth={2} />
          ) : (
            <MapPin size={32} color={colors.white} strokeWidth={2} />
          )}
        </View>
      )}
      <LpPayoutBadge
        isLpPiggy={cache.isLpPiggy}
        payoutSats={cache.payoutSats}
        offset={{ top: 4, right: 4 }}
      />
    </View>
    <Text style={styles.cardTitle} numberOfLines={2}>
      {cache.name}
    </Text>
    <Text style={styles.cardSub} numberOfLines={1}>
      {cache.isLpPiggy ? 'Piglet' : 'NIP-GC cache'}
      {Number.isFinite(distance) ? ` · ${formatDistance(distance)}` : ''}
    </Text>
    <Text style={styles.cardSubSmall} numberOfLines={1}>
      {cache.cacheType ?? 'traditional'} · {cache.size ?? 'micro'}
    </Text>
  </TouchableOpacity>
);

export default React.memo(CacheCard);
