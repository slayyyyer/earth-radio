import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPhrases,
  lowerBoundPhrase,
} from '../src/arrangement.js';

function event(id, offset, mag = 3) {
  return { id, offset, mag };
}

test('buildPhrases leaves isolated quakes as their own voices', () => {
  const phrases = buildPhrases([
    event('b', 300_001, 4),
    event('a', 0, 3),
    event('c', 600_002, 5),
  ]);

  assert.equal(phrases.length, 3);
  assert.deepEqual(
    phrases.map((phrase) => phrase.members.map((member) => member.id)),
    [['a'], ['b'], ['c']],
  );
  assert.ok(phrases.every((phrase) => phrase.isCluster === false));
});

test('buildPhrases folds three or four close quakes into one chord', () => {
  const phrases = buildPhrases([
    event('e5', 240_000, 3),
    event('e1', 0, 3),
    event('e3', 120_000, 5),
    event('e2', 60_000, 4),
    event('e4', 180_000, 6),
  ]);

  assert.equal(phrases.length, 2);
  assert.equal(phrases[0].startOffset, 0);
  assert.equal(phrases[0].isCluster, true);
  assert.deepEqual(
    phrases[0].members.map((member) => member.id),
    ['e1', 'e2', 'e3', 'e4'],
  );
  assert.equal(phrases[0].lead.id, 'e4');
  assert.equal(phrases[1].members[0].id, 'e5');
  assert.equal(phrases[1].isCluster, false);
});

test('the cluster window includes exactly five minutes', () => {
  const phrases = buildPhrases([
    event('a', 0),
    event('b', 150_000),
    event('c', 300_000),
  ]);

  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].members.length, 3);

  const outside = buildPhrases([
    event('a', 0),
    event('b', 300_001),
    event('c', 600_002),
  ]);
  assert.equal(outside.length, 3);
});

test('quiet neighbours are not dragged into a cluster', () => {
  const phrases = buildPhrases([
    event('quiet-a', 0),
    event('quiet-b', 300_000),
    event('dense-a', 900_000),
    event('dense-b', 960_000),
    event('dense-c', 1_020_000),
  ]);

  assert.equal(phrases.length, 3);
  assert.equal(phrases[0].members.length, 1);
  assert.equal(phrases[1].members.length, 1);
  assert.equal(phrases[2].members.length, 3);
  assert.equal(phrases[2].lead.offset, 900_000);
});

test('custom cluster limits and lowerBoundPhrase work together', () => {
  const phrases = buildPhrases(
    [event('a', 0), event('b', 1_000), event('c', 2_000)],
    { clusterWindowMs: 10_000, minClusterSize: 2, maxClusterSize: 2 },
  );

  assert.equal(phrases.length, 2);
  assert.equal(phrases[0].members.length, 2);
  assert.equal(phrases[1].members.length, 1);
  assert.equal(lowerBoundPhrase(phrases, -1), 0);
  assert.equal(lowerBoundPhrase(phrases, 1_000), 1);
  assert.equal(lowerBoundPhrase(phrases, 99_000), 2);
});

test('buildPhrases ignores malformed events', () => {
  const phrases = buildPhrases([
    null,
    { id: 'missing-offset', mag: 3 },
    { id: 'bad-offset', offset: Number.NaN, mag: 3 },
    event('valid', 10),
  ]);

  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].members[0].id, 'valid');
});
