import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { idleScheduler } from '../utils/idleScheduler';
import { ExploreMiniMap } from './ExploreMiniMap';
import { loadExploreCamera, cacheExplorePins } from '../services/exploreMapState';

let mockFocused = true;
let mockMounts = 0;
let mockMapProps: Record<string, unknown>;
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../contexts/UserLocationContext', () => ({ useUserLocation: () => ({ pos: null }) }));
jest.mock('../services/exploreMapState', () => ({
  peekExploreCamera: jest.fn(() => null),
  loadExploreCamera: jest.fn(async () => null),
  peekExplorePins: jest.fn(() => ({ merchants: [], caches: [], events: [] })),
  cacheExplorePins: jest.fn(),
  saveExploreCamera: jest.fn(),
}));
jest.mock('./LibreMiniMap', () => ({
  LibreMiniMap: (props: Record<string, unknown>) => {
    const React = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    React.useEffect(() => {
      mockMounts++;
    }, []);
    mockMapProps = props;
    return <View testID="native-map" />;
  },
}));

const empty = { merchants: [], caches: [], events: [] };
const props = {
  ...empty,
  locationDenied: false,
  fallbackAnchor: { lat: 1, lon: 2, accuracy: null },
  onTapMap: jest.fn(),
  onOpenLegend: jest.fn(),
  onSelectMerchant: jest.fn(),
  onSelectCache: jest.fn(),
  onSelectEvent: jest.fn(),
};
let jobs: (() => void)[];
let cancels: jest.Mock[];
beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  mockMounts = 0;
  jobs = [];
  cancels = [];
  jest.spyOn(idleScheduler, 'runWhenIdle').mockImplementation((callback) => {
    jobs.push(callback as () => void);
    const cancel = jest.fn();
    cancels.push(cancel);
    return { cancel, then: jest.fn(), done: jest.fn() } as unknown as ReturnType<
      typeof idleScheduler.runWhenIdle
    >;
  });
});
afterEach(() => jest.restoreAllMocks());

it('paints a placeholder then restores persisted camera before native mount', async () => {
  jest.mocked(loadExploreCamera).mockResolvedValueOnce({ lat: 51, lon: -1, zoom: 17 });
  const ui = render(<ExploreMiniMap {...props} />);
  expect(ui.queryByTestId('native-map')).toBeNull();
  expect(ui.getByTestId('explore-minimap')).toBeTruthy();
  await waitFor(() => expect(ui.getByTestId('native-map')).toBeTruthy());
  expect(mockMapProps).toMatchObject({ lat: 51, lon: -1, defaultZoom: 17 });
});
it('keeps the same native map and pins across blur and refocus', async () => {
  const ui = render(<ExploreMiniMap {...props} />);
  await waitFor(() => expect(mockMounts).toBe(1));
  act(() => jobs.forEach((job) => job()));
  mockFocused = false;
  ui.rerender(<ExploreMiniMap {...props} />);
  expect(ui.queryByTestId('native-map')).toBeTruthy();
  mockFocused = true;
  ui.rerender(<ExploreMiniMap {...props} />);
  expect(mockMounts).toBe(1);
});
it('defers pins and clustering input until interactions and cancels superseded work', async () => {
  const merchants = [{ id: 7, lat: 1, lon: 2, tags: {}, verified_at: null }];
  const ui = render(<ExploreMiniMap {...props} merchants={merchants} />);
  await waitFor(() => expect(ui.getByTestId('native-map')).toBeTruthy());
  expect(mockMapProps.merchants).toEqual([]);
  act(() => jobs[jobs.length - 1]());
  expect(mockMapProps.merchants).toBe(merchants);
  expect(cacheExplorePins).toHaveBeenCalledWith({
    merchants,
    caches: props.caches,
    events: props.events,
  });
  ui.rerender(<ExploreMiniMap {...props} merchants={[]} />);
  expect(cancels[0]).toHaveBeenCalled();
  // Until the deferred replacement lands, render the last pins.
  expect(mockMapProps.merchants).toBe(merchants);
  ui.unmount();
  expect(cancels[cancels.length - 1]).toHaveBeenCalled();
});
