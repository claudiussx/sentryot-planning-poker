import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonFor } from '../js/season.js';

test('Halloween runs from 15 October to 15 November', () => {
  assert.equal(seasonFor(new Date(2026, 9, 14)), 'none');
  assert.equal(seasonFor(new Date(2026, 9, 15)), 'halloween');
  assert.equal(seasonFor(new Date(2026, 9, 31)), 'halloween');
  assert.equal(seasonFor(new Date(2026, 10, 15)), 'halloween');
  assert.equal(seasonFor(new Date(2026, 10, 16)), 'none');
});

test('the address can force a season', () => {
  assert.equal(seasonFor(new Date(2026, 5, 1), '?season=halloween'), 'halloween');
  assert.equal(seasonFor(new Date(2026, 9, 31), '?debug&season=none'), 'none');
  assert.equal(seasonFor(new Date(2026, 5, 1), '?season=xmas'), 'none');
});
