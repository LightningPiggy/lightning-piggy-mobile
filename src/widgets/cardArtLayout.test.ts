import { artSizeOrSquare, containSize, coverSize } from './cardArtLayout';

describe('cardArtLayout', () => {
  it('covers the card while keeping the art in proportion', () => {
    const box = coverSize({ width: 1200, height: 800 }, { width: 172, height: 172 });
    expect(box.height).toBe(172);
    expect(box.width / box.height).toBeCloseTo(1.5, 1);
  });

  it('fits a wide wordmark inside the box without squashing it', () => {
    const box = containSize({ width: 512, height: 153 }, { width: 150, height: 150 });
    expect(box.width).toBe(150);
    expect(box.width / box.height).toBeCloseTo(512 / 153, 1);
  });

  it('treats an unknown art size as square', () => {
    expect(artSizeOrSquare(undefined)).toEqual({ width: 1, height: 1 });
    expect(artSizeOrSquare({ width: 0, height: 10 })).toEqual({ width: 1, height: 1 });
  });
});
