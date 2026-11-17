import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputSelectionChangeEvent } from 'react-native';
import {
  applyMentionPick,
  encodeMentions,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
  type MentionPick,
  type MentionQuery,
} from '../utils/chatMentions';

type Selection = { start: number; end: number };

/** Remembered picks per composer: beyond this, the oldest ones the draft no
 * longer uses are dropped (never one whose @Name is still in the text). */
const MAX_PICKS = 20;

function trimPicks(picks: MentionPick[], draft: string): MentionPick[] {
  let excess = picks.length - MAX_PICKS;
  if (excess <= 0) return picks;
  return picks.filter((p) => {
    if (excess > 0 && !draft.includes(`@${p.label}`)) {
      excess--;
      return false;
    }
    return true;
  });
}

const sameQuery = (a: MentionQuery | null, b: MentionQuery | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.query === b.query && a.end === b.end);

/**
 * Group-composer @mentions (#1295). Typing `@` opens a picker of the group's
 * members, filtered as you type; picking one writes `@Name ` into the draft
 * and remembers who it was. On send, `encode` swaps each picked `@Name` for
 * the member's NIP-27 `nostr:npub…` reference.
 *
 * Re-renders only when the `@query` under the cursor changes — the cursor
 * itself lives in a ref, so ordinary typing costs nothing extra.
 */
export function useMentionComposer<T extends MentionCandidate>({
  draft,
  setDraft,
  members,
  selfPubkey,
  enabled = true,
}: {
  draft: string;
  setDraft: (text: string) => void;
  members: readonly T[];
  selfPubkey: string | null | undefined;
  enabled?: boolean;
}) {
  const cursor = useRef(draft.length);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const picks = useRef<MentionPick[]>([]);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  // Set right after a pick so the cursor lands after the inserted name; the
  // next native selection event hands control back to the input.
  const [forcedSelection, setForcedSelection] = useState<Selection | undefined>(undefined);

  const recompute = useCallback(
    (text: string) => {
      const next = enabled ? findMentionQuery(text, cursor.current) : null;
      setQuery((prev) => (sameQuery(prev, next) ? prev : next));
    },
    [enabled],
  );

  // Picks outlive a cleared draft on purpose: a failed send puts the text
  // back, and its @Names must still encode on the retry. Only labels still in
  // the text are ever replaced, so stale picks are harmless.
  useEffect(() => {
    recompute(draft);
  }, [draft, recompute]);

  const onSelectionChange = useCallback(
    (e: TextInputSelectionChangeEvent) => {
      const { start, end } = e.nativeEvent.selection;
      cursor.current = start === end ? end : -1;
      setForcedSelection(undefined);
      recompute(draftRef.current);
    },
    [recompute],
  );

  const candidates = useMemo(
    () => (query ? filterMentionCandidates(members, query.query, selfPubkey) : []),
    [query, members, selfPubkey],
  );

  const pick = useCallback(
    (member: T) => {
      const current = findMentionQuery(draftRef.current, cursor.current) ?? query;
      if (!current) return;
      const name = member.name.trim() || member.pubkey.slice(0, 8);
      // Two members with the same display name: keep their labels apart, or
      // both @Names would encode to whoever was picked last.
      const clash = picks.current.some((p) => p.label === name && p.pubkey !== member.pubkey);
      const label = clash ? `${name} (${member.pubkey.slice(0, 4)})` : name;
      const next = applyMentionPick(draftRef.current, current, label);
      picks.current = trimPicks(
        [...picks.current.filter((p) => p.label !== label), { label, pubkey: member.pubkey }],
        next.text,
      );
      cursor.current = next.cursor;
      setDraft(next.text);
      setForcedSelection({ start: next.cursor, end: next.cursor });
      setQuery(null);
    },
    [query, setDraft],
  );

  const encode = useCallback((text: string) => encodeMentions(text, picks.current), []);

  return {
    /** Members to offer (empty = picker hidden). */
    candidates,
    pick,
    encode,
    onSelectionChange,
    selection: forcedSelection,
  };
}
