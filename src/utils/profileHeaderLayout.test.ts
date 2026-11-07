import { profileHeaderLayout, profileStickyPhase } from './profileHeaderLayout';

describe('profileHeaderLayout', () => {
  it('uses the regular size on a wide phone at the default font scale', () => {
    const l = profileHeaderLayout(430, 1);
    expect(l.compact).toBe(false);
    expect(l.avatarSize).toBe(96);
    expect(l.iconSize).toBe(40);
  });

  it('goes compact on a ~400 dp phone or with a large system font', () => {
    expect(profileHeaderLayout(360, 1).compact).toBe(true);
    expect(profileHeaderLayout(411, 1.3).compact).toBe(true);
    expect(profileHeaderLayout(430, 1.6).compact).toBe(true);
  });

  it('puts the action row fully below the banner with a clear gap, centred on the avatar', () => {
    for (const [width, font] of [
      [320, 1],
      [360, 1],
      [411, 1],
      [411, 1.3],
      [576, 1],
      [800, 1],
    ]) {
      const l = profileHeaderLayout(width, font);
      // Gap between the banner's bottom edge and the buttons' tops.
      expect(l.actionTop - l.overlap).toBeGreaterThanOrEqual(10);
      expect(l.actionTop - l.overlap).toBeLessThanOrEqual(12);
      // Roughly centred on the part of the avatar below the banner.
      const buttonsCentre = l.actionTop + l.iconSize / 2;
      const avatarBelowCentre = (l.overlap + l.avatarOuter) / 2;
      expect(Math.abs(buttonsCentre - avatarBelowCentre)).toBeLessThanOrEqual(8);
      // The avatar still overlaps the banner.
      expect(l.overlap).toBeGreaterThan(20);
    }
  });

  it('fits the compact row on a 360 dp phone at the default font scale', () => {
    const l = profileHeaderLayout(360, 1);
    expect(l.actionRowWidth).toBeLessThanOrEqual(l.availableWidth);
  });

  it('stays regular when there is no Follow pill (own / phone contact)', () => {
    expect(profileHeaderLayout(411, 1, 3, false).compact).toBe(false);
  });
});

describe('profileStickyPhase', () => {
  const inset = 24; // status bar; the bar bottom is then 24 + 44 = 68
  it('shows nothing while the banner is under the buttons', () => {
    expect(profileStickyPhase(0, inset, 500)).toBe(0);
    expect(profileStickyPhase(-40, inset, 500)).toBe(0); // pull-to-refresh
    expect(profileStickyPhase(131, inset, 500)).toBe(0);
  });

  it('shows the solid bar once the banner has scrolled away', () => {
    expect(profileStickyPhase(132, inset, 500)).toBe(1);
    expect(profileStickyPhase(400, inset, null)).toBe(1);
  });

  it('pins the tabs when they reach the bar, accounting for a tall cutout', () => {
    expect(profileStickyPhase(432, inset, 500)).toBe(2);
    expect(profileStickyPhase(431, inset, 500)).toBe(1);
    // A 48 dp cutout inset pins the tabs 24 dp earlier.
    expect(profileStickyPhase(408, 48, 500)).toBe(2);
    expect(profileStickyPhase(407, 48, 500)).toBe(1);
  });
});
