import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRecap } from '../js/recap.js';

const round = (label, votes, first = null, deck = 'fib') => ({ label, deck, first, votes: Object.entries(votes).map(([name, vote]) => ({ id: name.toLowerCase(), name, vote })) });

test('counts rounds, consensus and average agreement', () => {
  const r = computeRecap([round(1, { Ana: '5', Bo: '5' }), round(2, { Ana: '3', Bo: '8' }), round(3, {})]);
  assert.equal(r.rounds, 2);
  assert.equal(r.consensus, 1);
  assert.equal(r.agreement, 75);
  assert.deepEqual(r.list.map((x) => x.result), ['5', '5']);
});

test('awards go to whoever did it most, ties shared', () => {
  const r = computeRecap([
    round(1, { Ana: '1', Bo: '3', Cy: '13' }, 'bo'),
    round(2, { Ana: 'coffee', Bo: '?', Cy: '5' }, 'bo'),
    round(3, { Ana: 'coffee', Bo: '5', Cy: '5' }, 'cy'),
  ]);
  const by = Object.fromEntries(r.awards.map((a) => [a.key, a]));
  assert.deepEqual(by.first.names, ['Bo']);
  assert.equal(by.first.line, 'first to vote 2 times');
  assert.deepEqual(by.coffee.names, ['Ana']);
  assert.deepEqual(by.unsure.names, ['Bo']);
  assert.deepEqual(by.edge.names, ['Ana', 'Cy']);
  assert.deepEqual(by.match.names, ['Cy']);
});

test('nothing to award in an empty session', () => {
  const r = computeRecap([]);
  assert.equal(r.rounds, 0);
  assert.equal(r.agreement, null);
  assert.deepEqual(r.awards, []);
});

test('t-shirt rounds show sizes', () => {
  assert.equal(computeRecap([round(1, { Ana: 'M', Bo: 'L' }, null, 'tshirt')]).list[0].result, 'L');
});

test('the wild card is the lone outlier, not the crowd at the other end', () => {
  const r = computeRecap([round(1, { Ana: '3', Bo: '3', Cy: '3', Dee: '5', Raj: '13' })]);
  const edge = r.awards.find((a) => a.key === 'edge');
  assert.deepEqual(edge.names, ['Raj']);
  assert.equal(edge.line, 'stood apart in a big spread once');
});

test('two people far apart are both wild cards', () => {
  const r = computeRecap([round(1, { Ana: '1', Bo: '5', Cy: '5', Dee: '13' })]);
  assert.deepEqual(r.awards.find((a) => a.key === 'edge').names, ['Ana', 'Dee']);
});

test('no wild card when the spread is split down the middle', () => {
  const r = computeRecap([round(1, { Ana: '2', Bo: '2', Cy: '13', Dee: '13' })]);
  assert.equal(r.awards.find((a) => a.key === 'edge'), undefined);
});
