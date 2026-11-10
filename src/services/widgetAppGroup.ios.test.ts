const mockSet = jest.fn();
const mockRemove = jest.fn();
const mockReload = jest.fn();
const mockGroups: string[] = [];
let mockBundleId: string | null = 'com.lightningpiggy.app.dev';

jest.mock('expo-application', () => ({
  get applicationId() {
    return mockBundleId;
  },
}));

jest.mock('@bacons/apple-targets', () => ({
  ExtensionStorage: class {
    static reloadWidget() {
      mockReload();
    }
    constructor(group: string) {
      mockGroups.push(group);
    }
    set = mockSet;
    remove = mockRemove;
  },
}));

import {
  APP_GROUP_CURSORS_KEY,
  APP_GROUP_SNAPSHOT_KEY,
  appGroupIdentifier,
  mirrorWidgetSnapshot,
  resetWidgetAppGroupForTests,
  wipeWidgetAppGroup,
} from './widgetAppGroup.ios';

beforeEach(() => {
  jest.clearAllMocks();
  mockGroups.length = 0;
  mockBundleId = 'com.lightningpiggy.app.dev';
  resetWidgetAppGroupForTests();
});

describe('appGroupIdentifier', () => {
  it.each([
    ['com.lightningpiggy.app', 'group.com.lightningpiggy.app'],
    ['com.lightningpiggy.app.dev', 'group.com.lightningpiggy.app.dev'],
    ['com.lightningpiggy.app.preview', 'group.com.lightningpiggy.app.preview'],
  ])('gives each variant (%s) its own group', (bundleId, group) => {
    expect(appGroupIdentifier(bundleId)).toBe(group);
  });

  it('has no group without a bundle id', () => {
    expect(appGroupIdentifier(null)).toBeNull();
  });
});

describe('mirrorWidgetSnapshot', () => {
  it('writes the snapshot JSON into this variant’s App Group, then reloads the widgets', () => {
    const json = '{"version":1,"locale":"en","wallets":[]}';
    mirrorWidgetSnapshot(json);
    expect(mockGroups).toEqual(['group.com.lightningpiggy.app.dev']);
    expect(mockSet).toHaveBeenCalledWith(APP_GROUP_SNAPSHOT_KEY, json);
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockReload.mock.invocationCallOrder[0],
    );
  });

  it('opens the App Group once', () => {
    mirrorWidgetSnapshot('{}');
    mirrorWidgetSnapshot('{}');
    expect(mockGroups).toHaveLength(1);
  });

  it('does nothing without a bundle id', () => {
    mockBundleId = null;
    mirrorWidgetSnapshot('{}');
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
  });
});

describe('wipeWidgetAppGroup', () => {
  it('removes the snapshot and the widget positions, then reloads', () => {
    wipeWidgetAppGroup();
    expect(mockRemove).toHaveBeenCalledWith(APP_GROUP_SNAPSHOT_KEY);
    expect(mockRemove).toHaveBeenCalledWith(APP_GROUP_CURSORS_KEY);
    expect(mockReload).toHaveBeenCalledTimes(1);
  });
});
