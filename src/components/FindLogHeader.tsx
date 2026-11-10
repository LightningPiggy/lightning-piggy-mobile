import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useTranslation } from '../contexts/LocaleContext';
import { CACHE_LOG_LIMIT } from '../services/nostrPlacesPublisher';

// "Find log (N)" heading on a Piglet's detail screen. The found-log backfill
// stops at CACHE_LOG_LIMIT (#1789), so once the count reaches it the number
// is a floor, not a total — show "500+" rather than pass it off as exact.
const FindLogHeader: React.FC<{ count: number; style: StyleProp<TextStyle> }> = ({
  count,
  style,
}) => {
  const t = useTranslation();
  return (
    <Text style={style}>
      {count >= CACHE_LOG_LIMIT
        ? t('findLogHeader.titleCapped', { total: CACHE_LOG_LIMIT })
        : t('findLogHeader.title', { total: count })}
    </Text>
  );
};

export default FindLogHeader;
