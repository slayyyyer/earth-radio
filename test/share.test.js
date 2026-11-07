import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShareHash, parseShareState } from '../src/share.js';
import { DAY_MS } from '../src/data.js';

test('parseShareState reads a date, playhead, and event', () => {
  const state = parseShareState('#date=2026-11-06&t=53280&event=us7000abcd');

  assert.deepEqual(state, {
    date: '2026-11-06',
    offsetMs: 53_280_000,
    eventId: 'us7000abcd',
  });
});

test('parseShareState rejects invalid dates and times', () => {
  assert.deepEqual(parseShareState('#date=2026-02-29&t=nah'), {
    date: null,
    offsetMs: null,
    eventId: null,
  });
  assert.deepEqual(parseShareState(''), {
    date: null,
    offsetMs: null,
    eventId: null,
  });
});

test('parseShareState clamps the playhead to the UTC day', () => {
  assert.equal(parseShareState('#date=2026-11-06&t=-42').offsetMs, 0);
  assert.equal(parseShareState('#date=2026-11-06&t=999999').offsetMs, DAY_MS);
  assert.equal(
    parseShareState('#date=2026-11-06&t=86400').offsetMs,
    DAY_MS,
  );
});

test('buildShareHash omits zero time and encodes event IDs', () => {
  assert.equal(
    buildShareHash({ date: '2026-11-06', offsetMs: 0 }),
    '#date=2026-11-06',
  );
  assert.equal(
    buildShareHash({
      date: '2026-11-06',
      offsetMs: 4_999,
      eventId: 'us 7000&abc',
    }),
    '#date=2026-11-06&t=5&event=us+7000%26abc',
  );
});

test('share state round-trips with a valid date', () => {
  const hash = buildShareHash({
    date: '2026-11-06',
    offsetMs: 3_661_000,
    eventId: 'us7000abcd',
  });
  assert.deepEqual(parseShareState(hash), {
    date: '2026-11-06',
    offsetMs: 3_661_000,
    eventId: 'us7000abcd',
  });
});

test('an invalid date produces an empty hash', () => {
  const hash = buildShareHash({ date: 'not-a-date', offsetMs: 10 });
  assert.equal(hash, '#t=0');
  assert.equal(parseShareState(hash).date, null);
});
