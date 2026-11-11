import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonFor } from '../js/season.js';

test('Halloween runs from 15 October to 10 November', () => {
  assert.equal(seasonFor(new Date(2026, 9, 14)), 'none');
  assert.equal(seasonFor(new Date(2026, 9, 15)), 'halloween');
  assert.equal(seasonFor(new Date(2026, 9, 31)), 'halloween');
  assert.equal(seasonFor(new Date(2026, 10, 10)), 'halloween');
});

test('Christmas runs from 11 November to 6 January, across the new year', () => {
  assert.equal(seasonFor(new Date(2026, 10, 11)), 'christmas');
  assert.equal(seasonFor(new Date(2026, 11, 25)), 'christmas');
  assert.equal(seasonFor(new Date(2027, 0, 1)), 'christmas');
  assert.equal(seasonFor(new Date(2027, 0, 6)), 'christmas');
  assert.equal(seasonFor(new Date(2027, 0, 7)), 'none');
});

test('the address can force a season', () => {
  assert.equal(seasonFor(new Date(2026, 5, 1), '?season=halloween'), 'halloween');
  assert.equal(seasonFor(new Date(2026, 5, 1), '?season=christmas'), 'christmas');
  assert.equal(seasonFor(new Date(2026, 9, 31), '?debug&season=none'), 'none');
  assert.equal(seasonFor(new Date(2026, 5, 1), '?season=xmas'), 'none');
});
