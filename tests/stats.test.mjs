import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, nearestDeckValue, label, formatScale, ALL_CARDS, deckOf } from '../js/stats.js';

const v = (...votes) => votes.map((vote, i) => ({ id: String(i), name: `P${i}`, vote }));

test('average, median, range and suggestion', () => {
  const s = computeStats(v('3', '5', '8'));
  assert.equal(s.average, 5.3);
  assert.equal(s.median, 5);
  assert.equal(s.min, 3);
  assert.equal(s.max, 8);
  assert.equal(s.suggested, 5);
  assert.equal(s.consensus, false);
  assert.equal(s.spread, null);
});

test('even count median averages the middle pair', () => {
  assert.equal(computeStats(v('2', '3', '5', '8')).median, 4);
});

test('? and coffee are counted but excluded from the average', () => {
  const s = computeStats(v('5', '?', 'coffee', '8'));
  assert.equal(s.average, 6.5);
  assert.equal(s.unsure, 1);
  assert.equal(s.coffee, 1);
  assert.equal(s.total, 4);
  assert.equal(s.numericCount, 2);
});

test('consensus needs two equal numeric votes and no ?', () => {
  assert.equal(computeStats(v('5', '5')).consensus, true);
  assert.equal(computeStats(v('5')).consensus, false);
  assert.equal(computeStats(v('5', '5', '?')).consensus, false);
  assert.equal(computeStats(v('5', '5', 'coffee')).consensus, true);
});

test('agreement is the share of the most common numeric card', () => {
  assert.equal(computeStats(v('5', '5', '8', '3')).agreement, 50);
});

test('wide spread names the lowest and highest voter', () => {
  const s = computeStats(v('1', '3', '13'));
  assert.deepEqual(s.spread, { low: { name: 'P0', vote: '1' }, high: { name: 'P2', vote: '13' } });
});

test('no numeric votes leaves numbers null', () => {
  const s = computeStats(v('?', 'coffee'));
  assert.equal(s.average, null);
  assert.equal(s.suggested, null);
  assert.equal(s.distribution.length, 2);
});

test('invalid votes are ignored, 0 included now that the card is gone', () => {
  assert.equal(computeStats(v('7', 'banana', '3', '0')).total, 1);
});

test('nearest deck value rounds ties up', () => {
  assert.equal(nearestDeckValue(4), 5);
  assert.equal(nearestDeckValue(6.4), 5);
  assert.equal(nearestDeckValue(10.5), 13);
  assert.equal(nearestDeckValue(0.2), 0.5);
});

test('labels', () => {
  assert.equal(label('0.5'), '0.5');
  assert.equal(label('13'), '13');
});

test('t-shirt sizes: stats by position, shown as sizes', () => {
  const s = computeStats(v('S', 'M', 'L', '?'), 'tshirt');
  assert.equal(s.total, 4);
  assert.equal(s.numericCount, 3);
  assert.equal(formatScale('tshirt', s.average), 'M');
  assert.equal(formatScale('tshirt', s.suggested), 'M');
  assert.equal(formatScale('tshirt', s.min), 'S');
  assert.equal(formatScale('tshirt', s.max), 'L');
  assert.equal(s.spread, null);
  assert.ok(computeStats(v('XS', 'XL'), 'tshirt').spread);
});

test('hours: numbers in hours, cards from other decks ignored', () => {
  const s = computeStats(v('4h', '8h', '5'), 'hours');
  assert.equal(s.total, 2);
  assert.equal(s.average, 6);
  assert.equal(formatScale('hours', s.suggested), '8h');
  assert.equal(computeStats(v('M', '5'), 'fib').total, 1);
});

test('every card of every deck is a valid vote, nothing else', () => {
  assert.ok(ALL_CARDS.has('XXL') && ALL_CARDS.has('40h') && ALL_CARDS.has('0.5') && ALL_CARDS.has('coffee'));
  assert.ok(!ALL_CARDS.has('0') && !ALL_CARDS.has('banana'));
  assert.equal(deckOf('nope').id, 'fib');
});
