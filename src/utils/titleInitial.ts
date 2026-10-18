/** Placeholder letter for an image-less title: skips leading tags such as
 * "[TEST]" and punctuation so "[TEST] Little Piggy" reads "L", not "[". */
export function titleInitial(title: string): string {
  const untagged = title.replace(/^\s*(?:[[(][^\])]*[\])]\s*)+/u, '');
  const match = (untagged || title).match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '?';
}
