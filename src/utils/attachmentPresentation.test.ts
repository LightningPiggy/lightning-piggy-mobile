import {
  attachmentTypeLabel,
  formatAttachmentSize,
  clampAttachmentAspect,
} from './attachmentPresentation';
it.each([
  ['application/pdf', 'a.pdf', 'PDF'],
  ['application/msword', 'a.doc', 'Word'],
  ['application/vnd.ms-excel', 'a.xls', 'Excel'],
  ['application/vnd.ms-powerpoint', 'a.ppt', 'PowerPoint'],
  ['text/plain; charset=utf-8', 'a.txt', 'Text'],
  ['application/zip', 'a.zip', 'ZIP'],
  ['audio/mpeg', 'a.mp3', 'Audio'],
  ['video/mp4', 'a.mp4', 'Video'],
  ['application/octet-stream', 'a.epub', 'EPUB'],
  ['unknown', 'file', ''],
])('labels %s', (mime, name, label) => expect(attachmentTypeLabel(mime, name)).toBe(label));
it.each([
  [0, '0'],
  [430, '430'],
  [1000, '1 KB'],
  [1200000, '1.2 MB'],
  [2e9, '2 GB'],
  [undefined, null],
  [-1, null],
  [NaN, null],
])('formats %s', (size, expected) => expect(formatAttachmentSize(size)).toBe(expected));
it.each([
  [1200, 800, 1.5],
  [600, 400, 1.5],
  [1, 10, 0.6],
  [10, 1, 1.8],
  [0, 0, 1],
  [NaN, 1, 1],
  [Infinity, 1, 1],
])('clamps %s/%s', (w, h, expected) => expect(clampAttachmentAspect(w, h)).toBe(expected));
