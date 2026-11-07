import {
  MAX_ENTRIES,
  __resetFailedMediaForTests,
  forgetFailedMedia,
  hasFailedMedia,
  rememberFailedMedia,
} from './failedMediaMemory';

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
