import {
  MAX_ENTRIES,
  TTL_MS,
  __resetFailedMediaForTests,
  clearFailedMedia,
  forgetFailedMedia,
  hasFailedMedia,
  isPermanentMediaFailure,
  rememberFailedMedia,
} from './failedMediaMemory';

afterEach(() => jest.restoreAllMocks());

describe('expiry', () => {
  it(`forgets a URL ${TTL_MS / 60000} minutes after it was remembered`, () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const url = 'https://example.com/not-mirrored-yet.jpg';
    rememberFailedMedia(url);
    now.mockReturnValue(1_000_000 + TTL_MS - 1);
    expect(hasFailedMedia(url)).toBe(true);
    now.mockReturnValue(1_000_000 + TTL_MS);
    expect(hasFailedMedia(url)).toBe(false);
    // Deleted on read: even a clock that steps back can't revive it.
    now.mockReturnValue(1_000_000);
    expect(hasFailedMedia(url)).toBe(false);
  });

  it('re-remembering restarts the clock', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const url = 'https://example.com/a.jpg';
    rememberFailedMedia(url);
    now.mockReturnValue(TTL_MS - 1);
    rememberFailedMedia(url);
    now.mockReturnValue(TTL_MS + 1);
    expect(hasFailedMedia(url)).toBe(true);
  });
});

it('clearFailedMedia forgets everything (account switch / logout)', () => {
  rememberFailedMedia('https://example.com/a.jpg');
  rememberFailedMedia('https://example.com/b.jpg');
  clearFailedMedia();
  expect(hasFailedMedia('https://example.com/a.jpg')).toBe(false);
  expect(hasFailedMedia('https://example.com/b.jpg')).toBe(false);
});

describe('isPermanentMediaFailure', () => {
  it.each([
    ['Remote fetch failed (404)', true],
    ['Remote fetch failed (410)', true],
    ['Remote fetch failed (403)', true],
    ['Remote body exceeds limit', true],
    ['Blocked remote URL', true],
    ['Unvalidated remote redirect', true],
    ['Missing redirect location', true],
    ['Too many remote redirects', true],
    ['Remote fetch failed (408)', false],
    ['Remote fetch failed (429)', false],
    ['Remote fetch failed (500)', false],
    ['Remote fetch failed (503)', false],
    ['Remote fetch timed out', false],
    ['Network request failed', false],
    ['Media cache cancelled', false],
  ])('%s → %s', (message, expected) => {
    expect(isPermanentMediaFailure(new Error(message))).toBe(expected);
  });

  it('treats a non-Error rejection as transient', () => {
    expect(isPermanentMediaFailure('404')).toBe(false);
    expect(isPermanentMediaFailure(undefined)).toBe(false);
  });
});

beforeEach(() => __resetFailedMediaForTests());

it('remembers and forgets a URL', () => {
  const url = 'https://example.com/a.jpg';
  expect(hasFailedMedia(url)).toBe(false);
  rememberFailedMedia(url);
  expect(hasFailedMedia(url)).toBe(true);
  forgetFailedMedia(url);
  expect(hasFailedMedia(url)).toBe(false);
});

it('drops the oldest URL once past the bound', () => {
  for (let i = 0; i <= MAX_ENTRIES; i++) rememberFailedMedia(`https://example.com/${i}.jpg`);
  expect(hasFailedMedia('https://example.com/0.jpg')).toBe(false);
  expect(hasFailedMedia('https://example.com/1.jpg')).toBe(true);
  expect(hasFailedMedia(`https://example.com/${MAX_ENTRIES}.jpg`)).toBe(true);
});

it('re-remembering a URL makes it the newest, so it outlives older entries', () => {
  for (let i = 0; i < MAX_ENTRIES; i++) rememberFailedMedia(`https://example.com/${i}.jpg`);
  rememberFailedMedia('https://example.com/0.jpg');
  rememberFailedMedia('https://example.com/new.jpg');
  expect(hasFailedMedia('https://example.com/0.jpg')).toBe(true);
  expect(hasFailedMedia('https://example.com/1.jpg')).toBe(false);
});
