import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
  Keyboard,
  Platform,
} from 'react-native';
import { idleScheduler } from '../utils/idleScheduler';
import { Image } from 'expo-image';
import { UserRound, UsersRound } from 'lucide-react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetTextInput,
  BottomSheetFlatList,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { useNostrContacts } from '../contexts/NostrContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createFriendPickerSheetStyles } from '../styles/FriendPickerSheet.styles';
import AlphabetBar from './AlphabetBar';
import { isSupportedImageUrl } from '../utils/imageUrl';

export interface PickedFriend {
  pubkey: string;
  name: string;
  picture: string | null;
  lightningAddress: string | null;
}

// Internal-only: PickedFriend plus precomputed sort keys. We never
// expose these to onSelect callers (they only ever see PickedFriend);
// they exist purely so the sort comparator + alphabet helpers don't
// re-derive them on every comparison or keystroke.
type SortedFriend = PickedFriend & { nameAlpha: string; nameLower: string };

// Many Nostr contacts prepend emoji/flags/zaps, OR spell their name with
// stylized Unicode variants (𝙰𝚂𝙲𝙾𝚃, ᴄʏʙᴇʀɢᴜʏ, 𝔼𝕣𝕪𝕟) that aren't in the
// plain A-Z range. NFKD-normalize first so compatibility forms fold down
// to their Latin base, then find the first A-Z.
const firstAlpha = (name: string): string => {
  const normalized = name.normalize('NFKD').toUpperCase();
  const m = normalized.match(/[A-Z]/);
  return m ? m[0] : '#';
};

// Cached at module scope so the open-path doesn't construct a fresh
// Intl.Collator per comparison (5-10× slower than reusing one). Same
// pattern as FriendsScreen. See issue #245.
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (friend: PickedFriend) => void;
  title?: string;
  subtitle?: string;
  // Optional. When provided, renders a "New group" affordance at the top
  // of the list (above the friend rows). Tapping it dismisses the sheet
  // and calls `onNewGroup` so the caller can open CreateGroupSheet. Lets
  // the Messages-tab "+" FAB surface group creation alongside 1:1 — see
  // PR #227.
  onNewGroup?: () => void;
  // Optional. Hide these pubkeys from the picker — used by
  // GroupMembersSheet so existing members aren't selectable (otherwise
  // adding them silently no-ops in addMembersToGroup).
  excludePubkeys?: readonly string[];
  // Optional. Extra rows above the friends, given the live search text —
  // the "Share to Lightning Piggy" picker lists the user's groups here (#1692).
  listHeader?: (query: string) => React.ReactNode;
}

const FriendPickerSheet: React.FC<Props> = ({
  visible,
  onClose,
  onSelect,
  title,
  subtitle,
  onNewGroup,
  excludePubkeys,
  listHeader,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createFriendPickerSheetStyles(colors), [colors]);
  const resolvedTitle = title ?? t('friendPickerSheet.sendToFriend');
  const sheetRef = useRef<BottomSheetModal>(null);
  // BottomSheetFlatList's ref exposes the wrapped FlatList's scrollToIndex
  // (and other imperative helpers). Typing it precisely runs into @gorhom's
  // generic constraints; any-ref keeps the call site clean.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listRef = useRef<any>(null);
  const snapPoints = useMemo(() => ['85%'], []);
  // Keep the drag handle clear of Android's notification-shade trigger
  // zone (<48 DP from the top) while still letting the sheet grow past
  // the 75% snap when `keyboardBehavior="interactive"` lifts it up to
  // keep the focused input visible above the keyboard. 60 DP is above
  // the notification threshold but leaves plenty of room for keyboard
  // expansion (sheet can still reach ~94% of the screen).
  const topInset = 60;
  const { contacts } = useNostrContacts();
  const [search, setSearch] = useState('');
  const [currentLetter, setCurrentLetter] = useState<string | null>(null);
  // Canonical bottom-sheet + keyboard pattern from TROUBLESHOOTING.adoc
  // (see NostrLoginSheet.tsx): track keyboard height and pad the list's
  // contentContainerStyle dynamically. Without it, the list content
  // hides behind the keyboard or the sheet appears to collapse.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Drive the expensive filter off a deferred copy of `search`. Android's
  // IME can drop characters if the synchronous work triggered by each
  // keystroke (re-sorting the list + re-rendering every FlatList row)
  // runs faster than composition updates. `useDeferredValue` keeps the
  // input responsive and lets the list catch up when it can.
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (visible) {
      setSearch('');
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  // Defer list construction and avatar decodes until JS is idle. Native
  // Reanimated transitions are independent of this idle callback, so they
  // may still be running when the list mounts.
  const [listReady, setListReady] = useState(false);
  useEffect(() => {
    if (!visible) {
      setListReady(false);
      return;
    }
    const handle = idleScheduler.runWhenIdle(() => setListReady(true));
    return () => handle.cancel();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Step 1: build + sort the friends list. Pre-computes `nameAlpha` and
  // `nameLower` once per friend so the sort comparator does O(1) string
  // compares instead of re-running `firstAlpha()` (NFKD + uppercase +
  // regex, ~0.5 ms each) and `.toLowerCase()` for every comparison.
  // With 50 contacts × ~280 comparisons × 4 firstAlpha calls per
  // comparison, the previous implementation did 1100+ NFKD normalizes
  // synchronously while the bottom-sheet open animation was running —
  // which is what made the (+) FAB tap feel slow. See issue #245.
  // Only re-runs when `contacts` or `excludePubkeys` change (NOT every
  // keystroke). SortedFriend keeps the precomputed sort keys around so
  // `availableLetters` and `handleLetterPress` can read them too,
  // instead of recomputing firstAlpha 50× per keystroke.
  const sortedFriends = useMemo<SortedFriend[]>(() => {
    const exclude = excludePubkeys ? new Set(excludePubkeys) : null;
    const enriched: SortedFriend[] = [];
    for (const c of contacts) {
      const name = (c.profile?.displayName || c.profile?.name || c.petname || '').trim();
      // Contacts with no resolved name aren't useful in the picker —
      // they can't be reliably identified by the user. Also drop any
      // caller-excluded pubkeys (e.g. existing group members) so they
      // don't silently no-op in addMembersToGroup.
      if (name.length === 0) continue;
      if (exclude?.has(c.pubkey)) continue;
      enriched.push({
        pubkey: c.pubkey,
        name,
        picture: c.profile?.picture ?? null,
        lightningAddress: c.profile?.lud16 ?? null,
        nameAlpha: firstAlpha(name),
        nameLower: name.toLowerCase(),
      });
    }
    enriched.sort((a, b) => {
      if (a.nameAlpha !== b.nameAlpha) return NAME_COLLATOR.compare(a.nameAlpha, b.nameAlpha);
      return NAME_COLLATOR.compare(a.nameLower, b.nameLower);
    });
    return enriched;
  }, [contacts, excludePubkeys]);

  // Step 2: filter the pre-sorted list by `deferredSearch`. Substring
  // match is O(n) per keystroke with no allocations — the sort doesn't
  // re-run, only this filter pass does. Precomputed `nameLower` is
  // reused for the substring match.
  const friends = useMemo<SortedFriend[]>(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return sortedFriends;
    return sortedFriends.filter(
      (f) =>
        f.nameLower.includes(q) ||
        (f.lightningAddress && f.lightningAddress.toLowerCase().includes(q)),
    );
  }, [sortedFriends, deferredSearch]);

  const availableLetters = useMemo(() => {
    const letters = new Set<string>();
    // Precomputed nameAlpha — no firstAlpha() recomputation per friend.
    for (const f of friends) letters.add(f.nameAlpha);
    return Array.from(letters).sort();
  }, [friends]);

  const handleLetterPress = useCallback(
    (letter: string) => {
      const index = friends.findIndex((f) => f.nameAlpha === letter);
      if (index < 0) return;
      setCurrentLetter(letter);
      listRef.current?.scrollToIndex?.({ index, animated: false, viewPosition: 0 });
    },
    [friends],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: PickedFriend }) => (
      <TouchableOpacity
        style={styles.row}
        onPress={() => onSelect(item)}
        activeOpacity={0.6}
        accessibilityLabel={t('friendPickerSheet.sendToName', { name: item.name })}
        testID={`friend-picker-${item.pubkey.slice(0, 8)}`}
      >
        <View style={styles.avatar}>
          {/* Always render the silhouette so it shows whether `picture`
              is missing OR the Image fails to load (broken URL, offline,
              etc). When `picture` is set, the Image stacks on top via
              absoluteFill and covers the silhouette once it loads. */}
          <View style={styles.avatarFallback}>
            <UserRound size={28} color={colors.textBody} strokeWidth={1.75} />
          </View>
          {item.picture && isSupportedImageUrl(item.picture) ? (
            <Image
              source={{ uri: item.picture }}
              style={[StyleSheet.absoluteFill, styles.avatarImage]}
              // Canonical avatar caching policy — see issue #245.
              cachePolicy="memory-disk"
              recyclingKey={item.picture}
              // First frame only — see #243.
              autoplay={false}
            />
          ) : null}
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          {item.lightningAddress ? (
            <Text style={styles.address} numberOfLines={1}>
              {item.lightningAddress}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    ),
    // `styles` and `colors` are theme-derived; without them the callback
    // closes over a stale theme after a light/dark switch and rows render
    // with the previous palette until the list remounts.
    [onSelect, styles, colors, t],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      enableContentPanningGesture={false}
      enableOverDrag={false}
      // v5 defaults `enableDynamicSizing` to true → sheet height tracks
      // content height, which collapses to ~0 when Android `adjustResize`
      // shrinks the window as the keyboard opens (gorhom#1602). Turning
      // it off locks the sheet to its explicit snap point.
      enableDynamicSizing={false}
      topInset={topInset}
      // Stack on top of the ReceiveSheet rather than dismissing it —
      // @gorhom's default "switch" makes the parent modal dismiss, which
      // cascades to the parent's early-return `if (!visible) return null`
      // and unmounts this modal before it finishes animating in.
      stackBehavior="push"
    >
      {/* Flex column so the sticky header takes its content height and the
       *  list fills the rest. Previous setup nested the search input inside
       *  BottomSheetFlatList's ListHeaderComponent, which swallowed focus
       *  taps because the FlatList's own gesture handler intercepted them. */}
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <View style={styles.titleText}>
              <Text style={styles.title}>{resolvedTitle}</Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
          </View>
          <BottomSheetTextInput
            style={styles.searchInput}
            placeholder={t('friendPickerSheet.searchFriends')}
            placeholderTextColor={colors.textSupplementary}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            testID="friend-picker-search"
          />
        </View>
        <View style={styles.listWithBar}>
          {/* `listReady` flips true via idleScheduler once JS work +
              touch interactions are idle (which empirically lines up
              with the sheet open animation finishing). Until then this
              area is intentionally blank — nothing for the JS thread
              to render while it's busy with the open animation. See
              `useEffect([visible])` above. */}
          {listReady && availableLetters.length > 0 ? (
            <AlphabetBar
              letters={availableLetters}
              currentLetter={currentLetter}
              onLetterPress={handleLetterPress}
            />
          ) : null}
          {listReady ? (
            <BottomSheetFlatList<PickedFriend>
              ref={listRef}
              data={friends}
              keyExtractor={(f: PickedFriend) => f.pubkey}
              renderItem={renderItem}
              ListHeaderComponent={
                <>
                  {listHeader?.(deferredSearch)}
                  {onNewGroup ? (
                    <TouchableOpacity
                      style={styles.row}
                      onPress={onNewGroup}
                      accessibilityLabel={t('friendPickerSheet.createNewGroup')}
                      testID="friend-picker-new-group"
                    >
                      <View style={styles.newGroupIcon}>
                        <UsersRound size={28} color={colors.brandPink} />
                      </View>
                      <View style={styles.info}>
                        <Text style={styles.newGroupName}>{t('friendPickerSheet.newGroup')}</Text>
                      </View>
                    </TouchableOpacity>
                  ) : null}
                </>
              }
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 80 : 40 },
              ]}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              onScrollToIndexFailed={(info: {
                index: number;
                highestMeasuredFrameIndex: number;
                averageItemLength: number;
              }) => {
                const offset = info.averageItemLength * info.index;
                listRef.current?.scrollToOffset?.({ offset, animated: false });
                setTimeout(() => {
                  listRef.current?.scrollToIndex?.({
                    index: info.index,
                    animated: false,
                    viewPosition: 0,
                  });
                }, 50);
              }}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>
                    {contacts.length === 0
                      ? t('friendPickerSheet.noFollowsYet')
                      : search
                        ? t('friendPickerSheet.noSearchMatch')
                        : t('friendPickerSheet.noResolvedProfiles')}
                  </Text>
                </View>
              }
            />
          ) : null}
        </View>
      </View>
    </BottomSheetModal>
  );
};

export default FriendPickerSheet;
