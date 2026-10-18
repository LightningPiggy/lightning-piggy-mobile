import { titleInitial } from './titleInitial';

it.each([
  ['[TEST] Little Piggy Test Item', 'L'],
  ['(Sale) [TEST] widget', 'W'],
  ['bitcoin medallion', 'B'],
  ['  "Quoted" title', 'Q'],
  ['[TEST]', 'T'],
  ['123 Main', '1'],
  ['', '?'],
  ['…', '?'],
])('titleInitial(%j) → %s', (title, expected) => {
  expect(titleInitial(title)).toBe(expected);
});
