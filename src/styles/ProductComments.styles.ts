import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/**
 * Styles for {@link ProductComments} — the comments tab body: a new-comment
 * compose box (or sign-in prompt) and the list of top-level comment rows
 * ({@link ProductCommentItem}, incl. its Edit / Delete actions and the
 * in-place {@link ProductCommentEditor}).
 */
export const createProductCommentsStyles = (colors: Palette) =>
  StyleSheet.create({
    form: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      gap: 10,
      marginBottom: 16,
    },
    input: {
      minHeight: 56,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: 10,
      color: colors.textBody,
      textAlignVertical: 'top',
      fontSize: 14,
    },
    submit: {
      backgroundColor: colors.brandPink,
      borderRadius: 999,
      paddingVertical: 10,
      alignItems: 'center',
    },
    submitDisabled: { opacity: 0.6 },
    submitText: { color: colors.white, fontWeight: '800', fontSize: 14 },
    signInCard: {
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.divider,
      borderRadius: 12,
      paddingVertical: 18,
      alignItems: 'center',
      marginBottom: 16,
    },
    signInText: { color: colors.brandPink, fontWeight: '700', fontSize: 14 },
    reply: { marginLeft: 20, borderLeftWidth: 2, borderLeftColor: colors.divider, paddingLeft: 8 },
    item: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 12,
      gap: 6,
      marginBottom: 10,
    },
    itemHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    when: { fontSize: 12, color: colors.textSupplementary },
    // The card while it is the in-place editor (#1524).
    itemEditing: { borderWidth: 1, borderColor: colors.brandPink },
    editor: { gap: 10 },
    editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    editCancel: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.divider,
      paddingVertical: 8,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editCancelText: { color: colors.textBody, fontWeight: '700', fontSize: 13 },
    editSave: {
      backgroundColor: colors.brandPink,
      borderRadius: 999,
      paddingVertical: 8,
      paddingHorizontal: 16,
      minWidth: 120,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editSaveText: { color: colors.white, fontWeight: '800', fontSize: 13 },
    itemText: { fontSize: 14, color: colors.textBody, lineHeight: 20 },
    state: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      paddingVertical: 20,
    },
    loading: { paddingVertical: 24 },
    showMore: { alignItems: 'center', paddingVertical: 12 },
    showMoreText: { color: colors.brandPink, fontWeight: '700', fontSize: 14 },
  });

export type ProductCommentsStyles = ReturnType<typeof createProductCommentsStyles>;
