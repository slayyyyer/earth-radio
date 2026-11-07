import { DAY_MS, isValidDateString } from './data.js';

/**
 * Share links are client-side hashes so the app stays fully static:
 *   #date=2026-11-06&t=53280&event=us7000abcd
 * `t` is a UTC offset in seconds from midnight.
 */

export function parseShareState(hash = '') {
  let params;
  try {
    params = new URLSearchParams(String(hash).replace(/^#/, ''));
  } catch {
    return { date: null, offsetMs: null, eventId: null };
  }

  const dateParam = params.get('date') ?? '';
  const date = isValidDateString(dateParam) ? dateParam : null;
  const rawTime = params.get('t');
  let offsetMs = null;

  if (rawTime !== null && rawTime.trim() !== '') {
    const seconds = Number(rawTime);
    if (Number.isFinite(seconds)) {
      offsetMs = Math.max(0, Math.min(DAY_MS, Math.round(seconds * 1000)));
    }
  }

  const rawEvent = (params.get('event') ?? '').trim();
  const eventId = rawEvent ? rawEvent.slice(0, 200) : null;

  return { date, offsetMs, eventId };
}

export function buildShareHash({ date, offsetMs = 0, eventId = null } = {}) {
  const params = new URLSearchParams();
  if (isValidDateString(date)) params.set('date', date);
  if (Number.isFinite(offsetMs) && offsetMs > 0) {
    params.set('t', String(Math.round(offsetMs / 1000)));
  }
  if (eventId) params.set('event', String(eventId));
  return `#${params.toString()}`;
}
