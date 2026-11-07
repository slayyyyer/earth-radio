/**
 * USGS data access.
 *
 * One UTC calendar day is requested from the USGS FDSN event query API and
 * normalized into small, predictable event objects. Successful responses are
 * cached in localStorage per date, so returning to a day is instant and works
 * offline. A failed fetch falls back to a cached copy when one exists.
 */

const API_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const CACHE_PREFIX = 'earth-radio.cache.v1.';
const CACHE_INDEX_KEY = 'earth-radio.cache.v1.index';
const MAX_CACHED_DAYS = 10;
const CACHE_VERSION = 1;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MIN_MAGNITUDE = 2.5;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Format a Date as a UTC YYYY-MM-DD string. */
export function toUtcDateString(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
}

/** The default day: yesterday in UTC. */
export function defaultUtcDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return toUtcDateString(date);
}

export function todayUtcDate() {
  return toUtcDateString(new Date());
}

export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

/** UTC midnight for a YYYY-MM-DD date. */
export function dayStartMs(dateString) {
  return Date.parse(`${dateString}T00:00:00Z`);
}

export function addUtcDays(dateString, days) {
  const date = new Date(dayStartMs(dateString));
  date.setUTCDate(date.getUTCDate() + days);
  return toUtcDateString(date);
}

export function formatDateMeta(dateString) {
  const date = new Date(dayStartMs(dateString));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  })
    .format(date)
    .toUpperCase();
}

/** HH:MM:SS, tabular and UTC. Values clamp to the 24 hour range. */
export function formatClock(ms, withSeconds = true) {
  const totalSeconds = Math.max(
    0,
    Math.min(86_399, Math.floor(ms / 1000)),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return withSeconds
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(hours)}:${pad2(minutes)}`;
}

export function formatEventTimestamp(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )} UTC`;
}

/**
 * The USGS API treats a date-only endtime as the *start* of that date, so the
 * full 24 hours are requested by passing the next UTC day. Events are then
 * filtered to [dayStart, dayStart + 24h) locally. This is the equivalent of
 * the commonly written "endtime=<date>+1" but is valid ISO 8601.
 */
export function buildQueryUrl(dateString) {
  const end = addUtcDays(dateString, 1);
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: dateString,
    endtime: end,
    minmagnitude: String(MIN_MAGNITUDE),
    orderby: 'time-asc',
  });
  return `${API_URL}?${params.toString()}`;
}

/**
 * Convert a USGS GeoJSON FeatureCollection into the app's event shape.
 * Only earthquakes with valid coordinates, time, and magnitude are kept.
 */
export function normalizeFeatures(geojson, dateString) {
  if (!geojson || !Array.isArray(geojson.features)) {
    throw new DataError('USGS sent an unexpected response. Try again in a moment.');
  }

  const start = dayStartMs(dateString);
  const events = [];

  for (const feature of geojson.features) {
    const properties = feature?.properties ?? {};
    const coordinates = feature?.geometry?.coordinates;

    if (properties.type && properties.type !== 'earthquake') continue;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;

    const [lon, lat, rawDepth] = coordinates;
    const time = Number(properties.time);
    const mag = Number(properties.mag);
    const depthKm = Number.isFinite(Number(rawDepth)) ? Number(rawDepth) : 0;

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!Number.isFinite(time) || !Number.isFinite(mag)) continue;
    if (mag < MIN_MAGNITUDE) continue;

    const offset = time - start;
    if (offset < 0 || offset >= DAY_MS) continue;

    const id =
      typeof feature.id === 'string' && feature.id
        ? feature.id
        : `${time}-${lat.toFixed(3)}-${lon.toFixed(3)}`;
    const usgsUrl =
      typeof properties.url === 'string' && properties.url.startsWith('https://')
        ? properties.url
        : `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(id)}`;

    events.push({
      id,
      time,
      mag,
      place:
        typeof properties.place === 'string' && properties.place.trim()
          ? properties.place.trim()
          : 'Unknown location',
      url: usgsUrl,
      lon: Math.max(-180, Math.min(180, lon)),
      lat: Math.max(-90, Math.min(90, lat)),
      depthKm: Math.max(0, depthKm),
      offset,
    });
  }

  // The API already sorts by time, but the app relies on this ordering.
  events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return events;
}

function cacheKey(dateString) {
  return `${CACHE_PREFIX}${dateString}`;
}

function readCacheIndex() {
  try {
    const raw = localStorage.getItem(CACHE_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isValidDateString)
      : [];
  } catch {
    return [];
  }
}

function writeCacheIndex(dates) {
  try {
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(dates));
  } catch {
    // Private mode / disabled storage is not fatal: caching is a convenience.
  }
}

function removeCachedDate(dateString) {
  try {
    localStorage.removeItem(cacheKey(dateString));
  } catch {
    // ignore
  }
}

function readCache(dateString) {
  try {
    const raw = localStorage.getItem(cacheKey(dateString));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.v !== CACHE_VERSION ||
      parsed.date !== dateString ||
      !Array.isArray(parsed.events)
    ) {
      return null;
    }
    return {
      events: parsed.events.filter(
        (event) =>
          event &&
          typeof event.id === 'string' &&
          Number.isFinite(event.time) &&
          Number.isFinite(event.mag) &&
          Number.isFinite(event.offset),
      ),
      fetchedAt: Number(parsed.fetchedAt) || 0,
    };
  } catch {
    return null;
  }
}

function rememberCachedDate(dateString) {
  const index = readCacheIndex().filter((date) => date !== dateString);
  index.unshift(dateString);
  const removed = index.splice(MAX_CACHED_DAYS);
  for (const date of removed) removeCachedDate(date);
  writeCacheIndex(index);
}

function writeCache(dateString, events) {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    date: dateString,
    fetchedAt: Date.now(),
    events,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      localStorage.setItem(cacheKey(dateString), payload);
      rememberCachedDate(dateString);
      return;
    } catch {
      // Almost certainly a quota error. Evict the oldest day and try again.
      const index = readCacheIndex().filter((date) => date !== dateString);
      const oldest = index.pop();
      if (!oldest) return;
      removeCachedDate(oldest);
      writeCacheIndex(index);
    }
  }
}

export class DataError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DataError';
    this.cause = cause;
  }
}

/**
 * Load a day, from localStorage when possible.
 *
 * @param {string} dateString YYYY-MM-DD (UTC)
 * @param {{force?: boolean, signal?: AbortSignal}} options
 * @returns {Promise<{events: object[], cached: boolean, stale?: boolean, fetchedAt: number}>}
 */
export async function loadDay(dateString, { force = false, signal } = {}) {
  if (!isValidDateString(dateString)) {
    throw new DataError('That date could not be read. Pick a UTC date and try again.');
  }

  const cached = readCache(dateString);
  // Today is still in progress. Always try the live feed first, while keeping
  // yesterday's cached copy as the offline fallback.
  const isToday = dateString === todayUtcDate();
  if (cached && !force && !isToday) {
    return {
      events: cached.events,
      cached: true,
      fetchedAt: cached.fetchedAt,
    };
  }

  try {
    const response = await fetch(buildQueryUrl(dateString), {
      signal,
      headers: { Accept: 'application/geo+json, application/json' },
    });

    if (!response.ok) {
      throw new DataError(
        `USGS returned ${response.status}. Try again in a moment.`,
      );
    }

    let geojson;
    try {
      geojson = await response.json();
    } catch (error) {
      throw new DataError(
        'USGS sent a response that could not be read. Try again in a moment.',
        error,
      );
    }

    const events = normalizeFeatures(geojson, dateString);
    writeCache(dateString, events);

    return { events, cached: false, fetchedAt: Date.now() };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;

    if (cached) {
      return {
        events: cached.events,
        cached: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        error,
      };
    }

    if (error instanceof DataError) throw error;

    if (error instanceof TypeError) {
      throw new DataError(
        "Couldn't reach USGS. Check your connection and try again.",
        error,
      );
    }

    throw new DataError(
      'USGS could not be read right now. Try again in a moment.',
      error,
    );
  }
}
