import {
  MAX_ENTRIES,
  __resetFailedMediaForTests,
  forgetFailedMedia,
  hasFailedMedia,
  isPermanentMediaFailure,
  rememberFailedMedia,
} from './failedMediaMemory';

describe('isPermanentMediaFailure', () => {
  it.each([
    ['Remote fetch failed (404)', true],
    ['Remote fetch failed (410)', true],
    ['Remote fetch failed (403)', true],
    ['Remote body exceeds limit', true],
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
