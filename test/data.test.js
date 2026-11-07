import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY_MS,
  DataError,
  addUtcDays,
  buildQueryUrl,
  formatClock,
  formatEventTimestamp,
  isValidDateString,
  normalizeFeatures,
} from '../src/data.js';

const DATE = '2026-11-06';
const START = Date.parse(`${DATE}T00:00:00Z`);

function feature(overrides = {}) {
  const { properties = {}, geometry = {}, ...rest } = overrides;
  return {
    id: 'us7000abcd',
    ...rest,
    properties: {
      type: 'earthquake',
      time: START + 1_000,
      mag: 4.2,
      place: '  Somewhere offshore  ',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
      ...properties,
    },
    geometry: {
      coordinates: [170.25, -20.5, 32.1],
      ...geometry,
    },
  };
}

test('date helpers handle leap years, month ends, and UTC weeks', () => {
  assert.equal(isValidDateString('2026-11-06'), true);
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2026-02-29'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('2026-1-01'), false);
  assert.equal(addUtcDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addUtcDays('2026-03-01', -1), '2026-02-28');
});

test('formatClock is tabular and clamps to the final second', () => {
  assert.equal(formatClock(0), '00:00:00');
  assert.equal(formatClock(59_999), '00:00:59');
  assert.equal(formatClock(3_600_000, false), '01:00');
  assert.equal(formatClock(DAY_MS - 1), '23:59:59');
  assert.equal(formatClock(DAY_MS), '23:59:59');
  assert.equal(
    formatEventTimestamp(Date.UTC(2026, 10, 6, 13, 4, 5)),
    '2026-11-06 13:04:05 UTC',
  );
});

test('buildQueryUrl requests the whole next-day window', () => {
  const url = new URL(buildQueryUrl(DATE));

  assert.equal(url.origin, 'https://earthquake.usgs.gov');
  assert.equal(url.pathname, '/fdsnws/event/1/query');
  assert.equal(url.searchParams.get('starttime'), DATE);
  assert.equal(url.searchParams.get('endtime'), '2026-11-07');
  assert.equal(url.searchParams.get('minmagnitude'), '2.5');
  assert.equal(url.searchParams.get('orderby'), 'time-asc');
});

test('normalizeFeatures keeps valid earthquakes and cleans their fields', () => {
  const events = normalizeFeatures(
    {
      features: [
        feature(),
        feature({
          id: 'us-later',
          properties: {
            type: 'earthquake',
            time: START + DAY_MS - 1,
            mag: 2.5,
            place: '',
            url: 'http://not-https.example/event',
          },
          geometry: { coordinates: [200, 100, -4] },
        }),
        feature({
          id: 'not-an-earthquake',
          properties: { type: 'explosion' },
        }),
        feature({
          id: 'too-small',
          properties: { type: 'earthquake', mag: 2.4 },
        }),
        feature({
          id: 'outside-day',
          properties: { type: 'earthquake', time: START + DAY_MS },
        }),
        feature({
          id: 'bad-coordinates',
          geometry: { coordinates: ['west', -20] },
        }),
      ],
    },
    DATE,
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'us7000abcd');
  assert.equal(events[0].place, 'Somewhere offshore');
  assert.equal(events[0].offset, 1_000);
  assert.equal(events[0].depthKm, 32.1);

  assert.equal(events[1].id, 'us-later');
  assert.equal(events[1].place, 'Unknown location');
  assert.equal(events[1].lon, 180);
  assert.equal(events[1].lat, 90);
  assert.equal(events[1].depthKm, 0);
  assert.match(events[1].url, /earthquake\.usgs\.gov\/earthquakes\/eventpage\//);
});

test('normalizeFeatures rejects a malformed collection', () => {
  assert.throws(() => normalizeFeatures(null, DATE), DataError);
  assert.throws(
    () => normalizeFeatures({ features: 'no' }, DATE),
    DataError,
  );
  assert.deepEqual(normalizeFeatures({ features: [] }, DATE), []);
});
