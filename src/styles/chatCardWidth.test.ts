import {
  CHAT_IMAGE_MAX_ASPECT,
  CHAT_IMAGE_MIN_ASPECT,
  chatCardWidth,
  chatImageAspectRatio,
} from './chatCardWidth';

it('keeps real aspect ratios inside the bounds', () => {
  expect(chatImageAspectRatio(1200, 800)).toBe(1.5);
  expect(chatImageAspectRatio(800, 800)).toBe(1);
});

it('clamps forged extreme dimensions', () => {
  expect(chatImageAspectRatio(1, 1_000_000)).toBe(CHAT_IMAGE_MIN_ASPECT);
  expect(chatImageAspectRatio(1_000_000, 1)).toBe(CHAT_IMAGE_MAX_ASPECT);
});

it('starts square for invalid dimensions', () => {
  expect(chatImageAspectRatio(0, 100)).toBe(1);
  expect(chatImageAspectRatio(NaN, 100)).toBe(1);
  expect(chatImageAspectRatio(100, -5)).toBe(1);
});

it('caps the card width on wide screens', () => {
  expect(chatCardWidth(400)).toBeCloseTo(312);
  expect(chatCardWidth(1200)).toBe(320);
});
