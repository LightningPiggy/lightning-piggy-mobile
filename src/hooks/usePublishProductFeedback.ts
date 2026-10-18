import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useMemo, useState } from 'react';
import type { Event as NostrEvent } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS, publishSignedEvent } from '../services/nostrService';
import { COMMENT_KIND, buildCommentTags, type CommentRoot } from '../utils/productComments';
import { buildReviewDeletion, buildReviewEvent, type ParsedReview } from '../utils/productReviews';
import {
  buildCommentDeletion,
  buildCommentEdit,
  type UnsignedTemplate,
} from '../utils/commentEdits';

export interface UsePublishProductFeedback {
  /** Publish (or replace — same address = an edit) your review of a product. */
  /** `notBefore`: the earliest `created_at` (after a deletion of this address). */
  publishReview: (input: {
    coord: string;
    stars: number;
    content?: string;
    notBefore?: number;
  }) => Promise<NostrEvent>;
  /** Publish a NIP-09 kind-5 deletion request for your review (`a` + `e`). */
  deleteReview: (review: Pick<ParsedReview, 'id' | 'pubkey'>, coord: string) => Promise<NostrEvent>;
  /** Publish a comment on the product, or a reply to another comment. */
  publishComment: (input: {
    root: CommentRoot;
    content: string;
    reply?: CommentRoot;
  }) => Promise<NostrEvent>;
  /**
   * Edit your comment: publish its replacement, then a kind-5 for `original`.
   * Resolves with the replacement (null = nothing changed). Rejects only if
   * the replacement didn't go out; `oldDeleted` is false when it did but the
   * kind-5 didn't (readers still hide the old one via the `edit` tag).
   */
  editComment: (
    original: NostrEvent,
    content: string,
  ) => Promise<{ replacement: NostrEvent; oldDeleted: boolean } | null>;
  /** Publish a NIP-09 kind-5 deletion request for your comment. */
  deleteComment: (comment: NostrEvent) => Promise<void>;
  publishing: boolean;
  canPublish: boolean;
}

/**
 * Sign + publish review (kind 31555) and comment (kind 1111) events using the
 * app's existing signer plumbing (`useNostr().signEvent`, which handles both
 * nsec and Amber) and the user's write relays. Throws when not signed in so
 * the caller can surface a sign-in prompt.
 */
export function usePublishProductFeedback(): UsePublishProductFeedback {
  const { signEvent, relays, isLoggedIn, signerType } = useNostr();
  const [publishing, setPublishing] = useState(false);

  const writeRelays = useMemo(() => {
    const r = relays.filter((x) => x.write).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);

  const publish = useCallback(
    async (template: UnsignedTemplate, notBefore = 0): Promise<NostrEvent> => {
      setPublishing(true);
      try {
        const signed = await signEvent({
          kind: template.kind,
          created_at: Math.max(Math.floor(Date.now() / 1000), notBefore),
          tags: template.tags,
          content: template.content,
        });
        if (!signed) throw new Error('Not signed in');
        await publishSignedEvent(signed, writeRelays);
        return signed as NostrEvent;
      } finally {
        setPublishing(false);
      }
    },
    [signEvent, writeRelays],
  );

  const publishReview = useCallback(
    (input: { coord: string; stars: number; content?: string; notBefore?: number }) =>
      publish(buildReviewEvent(input), input.notBefore),
    [publish],
  );

  const deleteReview = useCallback(
    (review: Pick<ParsedReview, 'id' | 'pubkey'>, coord: string) =>
      publish(buildReviewDeletion(review, coord)),
    [publish],
  );

  const publishComment = useCallback(
    (input: { root: CommentRoot; content: string; reply?: CommentRoot }) =>
      publish({
        kind: COMMENT_KIND,
        content: input.content.trim(),
        tags: buildCommentTags(input.root, input.reply),
      }),
    [publish],
  );

  const deleteComment = useCallback(
    async (comment: NostrEvent) => {
      await publish(buildCommentDeletion(comment));
    },
    [publish],
  );

  const editComment = useCallback(
    async (original: NostrEvent, content: string) => {
      const template = buildCommentEdit(original, content);
      if (!template) return null;
      const replacement = await publish(template);
      const oldDeleted = await publish(buildCommentDeletion(original)).then(
        () => true,
        () => false,
      );
      return { replacement, oldDeleted };
    },
    [publish],
  );

  // Gate on a signer that can actually sign (mirrors useMarketCheckout.canOrder):
  // `signEvent` returns null for an unsupported signer type, which would
  // otherwise show the compose form and then fail every submit silently.
  const canPublish = Boolean(isLoggedIn && ['nsec', 'amber', 'nip46'].includes(signerType ?? ''));
  return {
    publishReview,
    deleteReview,
    publishComment,
    editComment,
    deleteComment,
    publishing,
    canPublish,
  };
}
