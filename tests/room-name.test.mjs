import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomSlug, parseRoomHash } from '../js/room-name.js';

test('same name in different spellings is one room', () => {
  assert.equal(roomSlug('abcd'), 'abcd');
  assert.equal(roomSlug(' ABCD '), 'abcd');
  assert.equal(roomSlug('Sprint 43  Planning!'), 'sprint-43-planning');
  assert.equal(roomSlug('sprint-43-planning'), 'sprint-43-planning');
  assert.equal(roomSlug('Planificare Ședință'), 'planificare-sedinta');
});

test('names with nothing usable give no slug', () => {
  assert.equal(roomSlug('  !!! '), '');
  assert.equal(roomSlug(''), '');
  assert.equal(roomSlug(null), '');
});

test('long names are cut without a trailing dash', () => {
  const s = roomSlug('a'.repeat(39) + ' b');
  assert.equal(s.length, 39);
  assert.ok(!s.endsWith('-'));
});

test('hash parsing: private token, named room, nothing', () => {
  assert.deepEqual(parseRoomHash('#r=aVCVSv6XqdH5-B6F'), { token: 'aVCVSv6XqdH5-B6F' });
  assert.deepEqual(parseRoomHash('#room=abcd'), { token: 'room:abcd', slug: 'abcd' });
  assert.deepEqual(parseRoomHash('#room=Sprint%2043'), { token: 'room:sprint-43', slug: 'sprint-43' });
  // a malformed private link is refused rather than opening a guessable named room
  assert.equal(parseRoomHash('#r=abcd'), null);
  assert.equal(parseRoomHash(''), null);
  assert.equal(parseRoomHash('#foo=bar'), null);
});
