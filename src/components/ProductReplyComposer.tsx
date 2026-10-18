import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { Event } from 'nostr-tools';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { usePublishProductFeedback } from '../hooks/usePublishProductFeedback';
import type { CommentRoot } from '../utils/productComments';
import type { ProductCommentsStyles } from '../styles/ProductComments.styles';
import { Toast } from './BrandedToast';

interface Props {
  root: CommentRoot;
  parent: Event;
  styles: ProductCommentsStyles;
  onPosted: (event: Event) => void;
  onCancel: () => void;
}
export default function ProductReplyComposer({ root, parent, styles, onPosted, onCancel }: Props) {
  const t = useTranslation();
  const { pubkey } = useNostr();
  const { publishComment } = usePublishProductFeedback();
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async () => {
    if (!text.trim() || pending.current || root instanceof URL || root.pubkey !== pubkey) return;
    pending.current = true;
    setPosting(true);
    try {
      const posted = await publishComment({ root, reply: parent, content: text });
      if (!alive.current) return;
      onPosted(posted);
      onCancel();
    } catch {
      if (alive.current)
        Toast.show({ type: 'error', text1: t('market.feedbackTabs.publishFailed') });
    } finally {
      pending.current = false;
      if (alive.current) setPosting(false);
    }
  };
  return (
    <View style={styles.form} testID={`comment-reply-form-${parent.id}`}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        editable={!posting}
        multiline
        accessibilityLabel={t('sellerActivity.replyAction')}
        testID={`comment-reply-input-${parent.id}`}
      />
      <View style={styles.editActions}>
        <TouchableOpacity
          style={styles.editCancel}
          onPress={onCancel}
          disabled={posting}
          testID={`comment-reply-cancel-${parent.id}`}
        >
          <Text style={styles.editCancelText}>{t('market.comments.cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.editSave, (!text.trim() || posting) && styles.submitDisabled]}
          onPress={() => void submit()}
          disabled={!text.trim() || posting}
          testID={`comment-reply-submit-${parent.id}`}
        >
          <Text style={styles.editSaveText}>{t('sellerActivity.replyAction')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
