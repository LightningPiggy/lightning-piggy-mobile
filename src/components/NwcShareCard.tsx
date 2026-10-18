import { useChatCardWidth } from '../styles/chatCardWidth';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Wallet, ShieldAlert, Plus } from 'lucide-react-native';
import { useTranslation } from '../contexts/LocaleContext';
import { formatTime } from '../utils/messageContent';
import type { Palette } from '../styles/palettes';
import type { NwcShareCard as NwcShareCardData } from '../utils/nwcShareMessage';
import { createNwcShareCardStyles } from '../styles/NwcShareCard.styles';

interface Props {
  card: NwcShareCardData;
  /** The viewer's own outgoing copy — hides the Add affordance. */
  fromMe: boolean;
  createdAt: number;
  colors: Palette;
  /** Recipient taps Add → parent re-confirms the trust warning and imports. */
  onAdd: (card: NwcShareCardData) => void;
}

/**
 * "Add NWC Wallet" conversation card. Renders a peer-shared NWC wallet as a QR
 * of the connection string, the wallet's name (if given), a prominent
 * trust warning, and an Add button that runs the existing NWC import path. The
 * bearer connection string only ever reaches this card via an encrypted NIP-17
 * DM — it is never a public event. The viewer's own sent copy (`fromMe`) shows
 * the same card WITHOUT an Add button (they already hold the wallet).
 */
const NwcShareCard: React.FC<Props> = ({ card, fromMe, createdAt, colors, onAdd }) => {
  const t = useTranslation();
  const cardWidth = useChatCardWidth();
  const styles = useMemo(() => createNwcShareCardStyles(colors, cardWidth), [colors, cardWidth]);

  return (
    <View style={[styles.row, fromMe ? styles.rowRight : styles.rowLeft]}>
      <View style={styles.card} testID="nwc-share-card">
        <View style={styles.headerRow}>
          <View style={styles.headerIcon}>
            <Wallet size={18} color={colors.brandPink} />
          </View>
          <Text style={styles.headerLabel} numberOfLines={2}>
            {t('nwcShareCard.title')}
          </Text>
        </View>

        {card.walletName ? (
          <Text style={styles.walletName} numberOfLines={1}>
            {card.walletName}
          </Text>
        ) : null}

        <View style={styles.qrWrap}>
          {/* Reuses the app's QR renderer (react-native-qrcode-svg), same as
              ReceiveSheet. `quietZone` keeps the code scannable on the card. */}
          <QRCode value={card.nwcUrl} size={180} quietZone={4} />
        </View>

        <View style={styles.warningBox}>
          <ShieldAlert size={18} color={colors.white} />
          <Text style={styles.warningText} testID="nwc-share-warning">
            {t('nwcShareCard.trustWarning')}
          </Text>
        </View>

        {fromMe ? (
          <Text style={styles.sharedCaption}>{t('nwcShareCard.youShared')}</Text>
        ) : (
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => onAdd(card)}
            accessibilityLabel={t('nwcShareCard.add')}
            testID="nwc-share-add"
          >
            <Plus size={18} color={colors.white} />
            <Text style={styles.addButtonText}>{t('nwcShareCard.add')}</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.time}>{formatTime(createdAt)}</Text>
      </View>
    </View>
  );
};

export default NwcShareCard;
