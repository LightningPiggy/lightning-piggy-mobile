// Sizes the card artwork for the "Same as in the app" widget style (#1849). The widget library scales an image to exactly
// imageWidth × imageHeight before applying its resize mode, so the box we pass must already have the art's own proportions.

export interface Size {
  width: number;
  height: number;
}

/** Full-bleed art: the smallest box with the art's proportions that covers the whole card (the overflow is cropped). */
export function coverSize(art: Size, frame: Size): Size {
  const scale = Math.max(frame.width / art.width, frame.height / art.height);
  return { width: Math.round(art.width * scale), height: Math.round(art.height * scale) };
}

/** Mascots and logos: the largest box with the art's proportions that fits inside `box`. */
export function containSize(art: Size, box: Size): Size {
  const scale = Math.min(box.width / art.width, box.height / art.height);
  return {
    width: Math.max(1, Math.round(art.width * scale)),
    height: Math.max(1, Math.round(art.height * scale)),
  };
}

/** Art proportions we can trust; unknown sizes are treated as square. */
export function artSizeOrSquare(
  size: { width?: number | null; height?: number | null } | null | undefined,
): Size {
  const width = size?.width;
  const height = size?.height;
  return width && height && width > 0 && height > 0 ? { width, height } : { width: 1, height: 1 };
}
