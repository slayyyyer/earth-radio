/**
 * Earth Radio — app orchestration.
 *
 * The timeline clock is a requestAnimationFrame clock. Visual cues follow
 * every event; audio follows a deterministic performance score that can fold
 * dense clusters into one chord-like voice. The same score is used for export.
 */

import './fonts.css';
import 'leaflet/dist/leaflet.css';
import './styles.css';

import {
  DAY_MS,
  HOUR_MS,
  addUtcDays,
  defaultUtcDate,
  formatClock,
  isValidDateString,
  loadDay,
  todayUtcDate,
} from './data.js';
import { clamp, densityAt, hourlyDensity, mapEvent } from './mapping.js';
import { AudioEngine } from './audio.js';
import { QuakeMap } from './map.js';
import { Timeline } from './timeline.js';
import { createUI } from './ui.js';
import { buildPhrases, lowerBoundPhrase } from './arrangement.js';
import { buildShareHash, parseShareState } from './share.js';
import { audioBufferToWavBlob } from './wav.js';

const BASE_SECONDS = 90;
const COMP_MS_PER_REAL_MS = DAY_MS / (BASE_SECONDS * 1000);
const MAX_CUES_PER_TICK = 24;
const initialShare = parseShareState(window.location.hash);

const state = {
  date: initialShare.date ?? defaultUtcDate(),
  events: [],
  hourly: hourlyDensity([]),
  phrases: [],
  strongEvent: null,
  playhead: 0,
  cursor: 0,
  phraseCursor: 0,
  playing: false,
  playPending: false,
  speed: 1,
  loading: false,
  loadToken: 0,
  abortController: null,
  audio: null,
  audioState: 'off',
  audioAttempt: null,
  volume: 0.8,
  muted: false,
  frameId: 0,
  lastTimestamp: 0,
  lastDensityHour: -1,
  hashSecond: -1,
  selectedEvent: null,
  exporting: false,
};

const ui = createUI({
  onStart: () => void startListening(),
  onPlayToggle: () => void togglePlayback(),
  onDateChange: (date) => void handleDateChange(date),
  onStepDate: (delta) => void stepDate(delta),
  onToday: () => void loadDate(todayUtcDate()),
  onRefresh: () => void loadDate(state.date, { force: true }),
  onSpeedChange: (speed) => setSpeed(speed),
  onRetry: () => void loadDate(state.date, { force: true }),
  onReplay: (event) => {
    if (!event) return;
    quakeMap.pulse(event);
    void replayEvent(event, { focus: true });
  },
  onLogSelect: (event, trigger) => selectEvent(event, 'log', trigger),
  onIndexSelect: (event, trigger) => selectEvent(event, 'index', trigger),
  onNextQuake: jumpToNextEvent,
  onStrongest: jumpToStrongest,
  onAudioPreferencesChange: applyAudioPreferences,
  onShare: () => void shareCurrent(),
  onShareEvent: (event) => void shareCurrent(event),
  onExport: () => void exportDayWav(),
  onDetailClose: () => {
    state.selectedEvent = null;
    syncShareHash();
  },
});

const initialPreferences = ui.getAudioPreferences();
state.volume = initialPreferences.volume;
state.muted = initialPreferences.muted;

const quakeMap = new QuakeMap(document.getElementById('map'), {
  onSelect: (event, trigger) => selectEvent(event, 'map', trigger),
  onBackground: () => ui.closeDetail({ restoreFocus: false }),
  onStatus: (status) => ui.setMapStatus(status),
});

const timeline = new Timeline(document.getElementById('timeline'), {
  tooltip: document.getElementById('timeline-tooltip'),
  onSeek: seek,
});

ui.setDate(state.date);
ui.setSpeed(1);
void loadDate(state.date, { share: initialShare });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) pause();
});

/* ------------------------------------------------------------------ data */

async function loadDate(date, { force = false, share = null } = {}) {
  if (!isValidDateString(date)) return;

  const today = todayUtcDate();
  const safeDate = date > today ? today : date;
  const token = ++state.loadToken;

  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;

  pause({ updateHash: false });
  state.date = safeDate;
  state.loading = true;
  state.events = [];
  state.phrases = [];
  state.phraseCursor = 0;
  state.strongEvent = null;
  state.playhead = 0;
  state.cursor = 0;
  state.lastDensityHour = -1;
  state.selectedEvent = null;

  quakeMap.clearEvents();
  timeline.setEvents([]);
  timeline.setEnabled(false);
  timeline.setPlayhead(0);
  ui.setClock(0);
  ui.setLoading(safeDate);

  try {
    const result = await loadDay(safeDate, {
      force,
      signal: controller.signal,
    });
    if (token !== state.loadToken) return;

    state.events = result.events;
    state.hourly = hourlyDensity(result.events);
    state.phrases = buildPhrases(result.events);
    state.strongEvent = result.events.reduce(
      (peak, event) => (!peak || event.mag > peak.mag ? event : peak),
      null,
    );
    state.playhead = 0;
    state.cursor = 0;
    state.phraseCursor = 0;
    state.loading = false;

    quakeMap.setEvents(result.events);
    timeline.setEvents(result.events);
    timeline.setEnabled(true);
    timeline.setPlayhead(0);
    ui.setClock(0);
    ui.setDay({
      date: safeDate,
      events: result.events,
      cached: result.cached,
      stale: result.stale,
      today: safeDate === today,
    });
    ui.setAudioState(state.audioState);
    syncDensity(true);

    if (share) applySharedState(share);
    syncShareHash();
  } catch (error) {
    if (error?.name === 'AbortError' || token !== state.loadToken) return;
    console.error('[Earth Radio] day load failed', error);
    state.loading = false;
    state.events = [];
    state.phrases = [];
    state.strongEvent = null;
    timeline.setEvents([]);
    timeline.setEnabled(false);
    ui.setError(
      error?.message || 'The USGS feed could not be loaded for this date.',
    );
    ui.setAudioState(state.audioState);
  } finally {
    if (token === state.loadToken) {
      state.loading = false;
      state.abortController = null;
    }
  }
}

async function handleDateChange(date) {
  if (!isValidDateString(date)) {
    ui.setDate(state.date);
    return;
  }
  if (date === state.date) return;

  const today = todayUtcDate();
  await loadDate(date > today ? today : date);
}

async function stepDate(delta) {
  const next = addUtcDays(state.date, delta);
  if (next > todayUtcDate()) return;
  await loadDate(next);
}

/* ---------------------------------------------------------------- audio */

async function ensureAudio() {
  if (state.audio) {
    try {
      await state.audio.start();
    } catch (error) {
      console.warn('[Earth Radio] could not resume audio', error);
    }
    if (state.audioState !== 'live') {
      state.audioState = 'live';
      ui.setAudioState('live');
    }
    return true;
  }

  if (state.audioAttempt) return state.audioAttempt;

  let engine = null;
  state.audioState = 'starting';
  ui.setAudioState('starting');

  state.audioAttempt = (async () => {
    try {
      engine = new AudioEngine();
      engine.setVolume(state.volume, { immediate: true });
      engine.setMuted(state.muted);
      await engine.start();
      state.audio = engine;
      state.audioState = 'live';
      state.lastDensityHour = -1;
      syncDensity(true);
      ui.setAudioState('live');
      return true;
    } catch (error) {
      console.error('[Earth Radio] audio could not start', error);
      if (engine) void engine.dispose();
      state.audioState = 'error';
      state.audio = null;
      ui.setAudioState('error');
      return false;
    } finally {
      state.audioAttempt = null;
    }
  })();

  return state.audioAttempt;
}

function applyAudioPreferences({ volume, muted }) {
  state.volume = clamp(Number(volume) || 0, 0, 1);
  state.muted = Boolean(muted);
  if (state.audio) {
    state.audio.setVolume(state.volume);
    state.audio.setMuted(state.muted);
  }
}

async function startListening() {
  if (state.audioState === 'live') {
    if (!state.playing) await play();
    return;
  }

  const started = await ensureAudio();
  if (!started) return;
  await play();
}

async function replayEvent(event, { focus = false } = {}) {
  if (!event) return;
  const started = await ensureAudio();
  if (!started || !state.audio) return;

  try {
    state.audio.trigger(mapEvent(event), state.audio.ctx.currentTime + 0.03, {
      focus,
    });
    ui.showNowSounding(event, { audition: true });
  } catch (error) {
    console.error('[Earth Radio] could not schedule replay', error);
  }
}

/* -------------------------------------------------------------- playback */

async function togglePlayback() {
  if (state.playing) {
    pause();
    return;
  }
  await play();
}

async function play() {
  if (state.playing || state.playPending || state.loading) return;
  state.playPending = true;

  try {
    if (state.playhead >= DAY_MS - 1) {
      state.playhead = 0;
      state.cursor = 0;
      state.phraseCursor = 0;
      state.selectedEvent = null;
      ui.closeDetail({ restoreFocus: false, silent: true });
      ui.setClock(0);
      timeline.setPlayhead(0);
      syncShareHash();
    }

    if (!state.audio && state.audioState !== 'error') {
      await ensureAudio();
    }
    if (state.playing || state.loading) return;

    state.playing = true;
    state.lastTimestamp = performance.now();
    state.lastDensityHour = -1;
    if (state.audio) state.audio.setActive(true);
    syncDensity(true);
    ui.setPlaying(true);
    syncShareHash();
    state.frameId = requestAnimationFrame(tick);
  } finally {
    state.playPending = false;
  }
}

function pause({ ended = false, updateHash = true } = {}) {
  if (state.frameId) {
    cancelAnimationFrame(state.frameId);
    state.frameId = 0;
  }
  state.playing = false;
  state.lastTimestamp = 0;
  if (state.audio) {
    state.audio.setActive(
      false,
      state.audio.ctx.currentTime,
      ended ? 2.2 : 0.55,
    );
  }
  ui.setPlaying(false, { isEnded: ended });
  ui.setAudioState(state.audioState);
  if (updateHash) syncShareHash();
}

function advancePlayback(deltaMs) {
  const nextPlayhead = Math.min(
    DAY_MS,
    state.playhead +
      Math.max(0, deltaMs) * COMP_MS_PER_REAL_MS * state.speed,
  );

  fireCues(state.cursor, nextPlayhead, (cue) => {
    quakeMap.pulse(cue);
    ui.addLog(cue);
  });
  firePhrases(nextPlayhead);

  state.playhead = nextPlayhead;
  timeline.setPlayhead(nextPlayhead);
  ui.setClock(nextPlayhead);
  syncDensity();

  const second = Math.floor(nextPlayhead / 1000);
  if (second !== state.hashSecond) syncShareHash();

  if (nextPlayhead >= DAY_MS) {
    pause({ ended: true, updateHash: false });
    ui.setClock(DAY_MS);
    syncShareHash();
    return true;
  }
  return false;
}

function tick(timestamp) {
  if (!state.playing) return;

  const now = Number.isFinite(timestamp) ? timestamp : performance.now();
  const delta = Math.min(
    250,
    Math.max(0, now - (state.lastTimestamp || now)),
  );
  state.lastTimestamp = now;

  if (advancePlayback(delta)) return;
  state.frameId = requestAnimationFrame(tick);
}

/**
 * Fire every visual cue between the cursor and the playhead. Capped so a
 * seek across a very dense day cannot lock the frame.
 */
function fireCues(cursor, untilOffset, onCue) {
  const cues = [];
  let index = cursor;

  while (
    index < state.events.length &&
    state.events[index].offset <= untilOffset &&
    cues.length < MAX_CUES_PER_TICK
  ) {
    cues.push(state.events[index]);
    index += 1;
  }

  if (!cues.length) return 0;
  state.cursor = index;
  for (const cue of cues) onCue(cue);
  return cues.length;
}

/**
 * Trigger the arranged score. Dense events are already grouped; each phrase
 * costs one slot and its strongest member is the foreground lead.
 */
function firePhrases(untilOffset) {
  const phrases = [];
  let cursor = state.phraseCursor;

  while (
    cursor < state.phrases.length &&
    state.phrases[cursor].startOffset <= untilOffset &&
    phrases.length < MAX_CUES_PER_TICK
  ) {
    phrases.push(state.phrases[cursor]);
    cursor += 1;
  }

  if (!phrases.length) return 0;
  state.phraseCursor = cursor;

  const when = state.audio
    ? state.audio.ctx.currentTime + 0.025
    : 0;

  phrases.forEach((phrase, index) => {
    if (state.audio) {
      try {
        state.audio.triggerPhrase(
          phrase.members.map(mapEvent),
          when + index * 0.035,
        );
      } catch (error) {
        console.error('[Earth Radio] could not schedule phrase', error);
      }
    }
    ui.showNowSounding(phrase.lead, { groupSize: phrase.members.length });
  });

  return phrases.length;
}

function syncDensity(force = false) {
  const hour = Math.max(
    0,
    Math.min(23, Math.floor(state.playhead / HOUR_MS)),
  );
  if (!force && hour === state.lastDensityHour) return;
  state.lastDensityHour = hour;
  if (state.audio) {
    state.audio.setDensity(
      densityAt(state.hourly, state.playhead),
      state.audio.ctx.currentTime,
    );
  }
}

function seek(ms, { updateHash = true, hideNow = true } = {}) {
  if (!Number.isFinite(ms)) return;

  state.playhead = Math.max(0, Math.min(DAY_MS, ms));
  state.cursor = lowerBound(state.events, state.playhead);
  state.phraseCursor = lowerBoundPhrase(state.phrases, state.playhead);
  state.lastDensityHour = -1;
  timeline.setPlayhead(state.playhead);
  ui.setClock(state.playhead);
  syncDensity(true);
  if (hideNow) ui.hideNowSounding();

  if (state.playing && state.playhead >= DAY_MS) {
    pause({ ended: true, updateHash: false });
    ui.setClock(DAY_MS);
  } else if (state.playing) {
    state.lastTimestamp = performance.now();
  } else {
    ui.setPlaying(false, { isEnded: state.playhead >= DAY_MS });
  }

  if (updateHash) syncShareHash();
}

function lowerBound(events, offset) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle].offset < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function setSpeed(speed) {
  const allowed = [0.5, 1, 2, 4];
  if (!allowed.includes(speed)) return;
  state.speed = speed;
  ui.setSpeed(speed);
  if (state.playing) state.lastTimestamp = performance.now();
}

/* -------------------------------------------------------------- selection */

function selectEvent(event, source, trigger = null) {
  if (!event) return;

  if (state.playing) pause({ updateHash: false });
  seek(event.offset, { updateHash: false, hideNow: true });
  state.selectedEvent = event;
  ui.addLog(event);
  ui.openDetail(event, { returnFocus: trigger || null });
  quakeMap.pulse(event);
  quakeMap.focus(event);
  syncShareHash();
  void replayEvent(event, { focus: true });
}

function applySharedState(share) {
  if (!share) return;

  if (state.playing) pause({ updateHash: false });
  const event = share.eventId
    ? state.events.find((candidate) => candidate.id === share.eventId)
    : null;

  if (event) {
    // An event link always frames that event. A playhead in the same link is
    // only a fallback, so the canonical hash can never drift away from it.
    seek(event.offset, { updateHash: false });
    state.selectedEvent = event;
    ui.openDetail(event, { focus: true });
    quakeMap.focus(event);
  } else if (Number.isFinite(share.offsetMs)) {
    seek(share.offsetMs, { updateHash: false });
  }
  syncShareHash();
}

function jumpToNextEvent() {
  const next = state.events.find(
    (event) => event.offset > state.playhead + 250,
  );
  if (!next) {
    ui.setToolStatus('No later quakes in this day.');
    return;
  }
  seek(next.offset);
  quakeMap.focus(next);
  ui.setToolStatus(`Next quake: ${formatClock(next.offset)} UTC.`);
}

function jumpToStrongest() {
  if (!state.strongEvent) return;
  seek(state.strongEvent.offset);
  quakeMap.focus(state.strongEvent);
  ui.setToolStatus(
    `Strongest quake: M${state.strongEvent.mag.toFixed(1)} at ${formatClock(
      state.strongEvent.offset,
    )} UTC.`,
  );
}

/* ---------------------------------------------------------------- sharing */

function shareStateFor(offsetMs, eventId = null) {
  return {
    date: state.date,
    offsetMs,
    eventId,
  };
}

function syncShareHash() {
  if (state.loading) return;
  const selectedAtPlayhead =
    state.selectedEvent &&
    Math.abs(state.selectedEvent.offset - state.playhead) < 1500
      ? state.selectedEvent.id
      : null;
  const hash = buildShareHash(
    shareStateFor(state.playhead, selectedAtPlayhead),
  );
  if (window.location.hash !== hash) {
    try {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${hash}`,
      );
    } catch {
      // A file:// preview or restricted frame may not allow history updates.
    }
  }
  state.hashSecond = Math.floor(state.playhead / 1000);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy selection path.
    }
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

async function shareCurrent(event = null) {
  const target = event || state.selectedEvent;
  const offsetMs = target ? target.offset : state.playhead;
  const eventId = target ? target.id : null;
  const hash = buildShareHash(shareStateFor(offsetMs, eventId));
  const url = new URL(window.location.href);
  url.hash = hash;
  const copied = await copyText(url.href);

  if (copied) {
    ui.setToolStatus(
      eventId
        ? 'Event link copied to the clipboard.'
        : 'Link copied at the current playhead.',
    );
  } else {
    ui.setToolStatus(
      'Could not copy the link. Copy it from the address bar instead.',
      { error: true },
    );
  }
}

function handleHashChange() {
  const share = parseShareState(window.location.hash);
  if (!share.date) return;

  if (share.date !== state.date) {
    void loadDate(share.date, { share });
    return;
  }
  applySharedState(share);
}

window.addEventListener('hashchange', handleHashChange);

/* -------------------------------------------------------------- rendering */

async function renderDayBuffer(events, seconds = 92, options = {}) {
  const OfflineContextClass =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContextClass) throw new Error('OfflineAudioContext unavailable');

  const sampleRate = options.sampleRate ?? 44100;
  const frameCount = Math.ceil(seconds * sampleRate);
  const offline = new OfflineContextClass(2, frameCount, sampleRate);
  const engine = new AudioEngine(offline);
  const startPad = 0.12;
  const span = Math.max(1, seconds - 1.4);
  const hourly = hourlyDensity(events);
  const phrases = buildPhrases(events);

  engine.setActive(true, 0.01);
  for (let hour = 0; hour < 24; hour += 1) {
    engine.setDensity(hourly.levels[hour], startPad + (hour / 24) * span);
  }

  for (const phrase of phrases) {
    const when = startPad + (phrase.startOffset / DAY_MS) * span;
    engine.triggerPhrase(phrase.members.map(mapEvent), when);
  }

  // Let the drone fall away before the final tail.
  engine.setActive(false, startPad + span + 0.8, 1.8);
  const buffer = await offline.startRendering();
  return { buffer, stats: { ...engine.stats }, phrases: phrases.length };
}

async function exportDayWav() {
  if (state.exporting || state.loading) return;
  state.exporting = true;
  ui.setExporting(true);
  ui.setToolStatus('Rendering the 90-second day to WAV…', { duration: 0 });

  try {
    const { buffer } = await renderDayBuffer(state.events, 92);
    const blob = audioBufferToWavBlob(buffer);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `earth-radio-${state.date}.wav`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    ui.setToolStatus('WAV download started.');
  } catch (error) {
    console.error('[Earth Radio] WAV export failed', error);
    ui.setToolStatus('Could not render the WAV. Try again.', { error: true });
  } finally {
    state.exporting = false;
    ui.setExporting(false);
  }
}

/* --------------------------------------------------- developer verification */

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function db(value) {
  return round(20 * Math.log10(Math.max(value, 1e-6)), 2);
}

async function renderDayForAnalysis(date, seconds = 92, options = {}) {
  const { events } = await loadDay(date);
  const { buffer, stats, phrases } = await renderDayBuffer(events, seconds, {
    sampleRate: options.sampleRate ?? 44100,
  });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (let index = 0; index < left.length; index += 1) {
    const amplitude = Math.max(Math.abs(left[index]), Math.abs(right[index]));
    peak = Math.max(peak, amplitude);
    if (amplitude >= 0.999) clipped += 1;
    sumSquares += left[index] * left[index] + right[index] * right[index];
  }
  const rms = Math.sqrt(sumSquares / (left.length * 2));

  const profileSegments = 20;
  const segmentLength = Math.floor(left.length / profileSegments);
  const profile = [];
  for (let segment = 0; segment < profileSegments; segment += 1) {
    let segmentPeak = 0;
    let segmentSum = 0;
    const start = segment * segmentLength;
    const end = Math.min(left.length, start + segmentLength);
    for (let index = start; index < end; index += 1) {
      segmentPeak = Math.max(segmentPeak, Math.abs(left[index]));
      segmentSum += left[index] * left[index];
    }
    profile.push({
      second: round(segment * (seconds / profileSegments), 1),
      peakDb: db(segmentPeak),
      rmsDb: db(Math.sqrt(segmentSum / Math.max(1, end - start))),
    });
  }

  const params = events.map(mapEvent);
  const frequencies = params.map((param) => param.frequency).sort((a, b) => a - b);
  const gains = params.map((param) => param.gain);
  const durations = params.map((param) => param.duration).sort((a, b) => a - b);
  const pans = params.map((param) => param.pan);
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    date,
    seconds,
    eventCount: events.length,
    phraseCount: phrases,
    maxMagnitude: events.length
      ? round(Math.max(...events.map((event) => event.mag)), 2)
      : 0,
    peak: round(peak, 5),
    peakDb: db(peak),
    rmsDb: db(rms),
    clippedSamples: clipped,
    engine: stats,
    profile,
    mapping: {
      frequencyMin: round(frequencies[0] ?? 0, 1),
      frequencyMax: round(frequencies.at(-1) ?? 0, 1),
      gainMin: round(gains.length ? Math.min(...gains) : 0, 4),
      gainMax: round(gains.length ? Math.max(...gains) : 0, 4),
      durationMin: round(durations[0] ?? 0, 2),
      durationMax: round(durations.at(-1) ?? 0, 2),
      durationMedian: round(median(durations), 2),
      panMin: round(pans.length ? Math.min(...pans) : 0, 3),
      panMax: round(pans.length ? Math.max(...pans) : 0, 3),
      subCount: params.filter((param) => param.sub).length,
      gainMedian: round(median(gains), 4),
    },
  };
}

if (import.meta.env.DEV) {
  window.__earthRadio = {
    state,
    ui,
    map: quakeMap,
    timeline,
    AudioEngine,
    mapEvent,
    hourlyDensity,
    densityAt,
    loadDay,
    loadDate,
    play,
    pause,
    seek,
    advance: advancePlayback,
    renderDayBuffer,
    renderDayForAnalysis,
    exportDayWav,
    shareCurrent,
  };
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker
        .register(new URL('sw.js', document.baseURI))
        .catch((error) => {
          console.warn('[Earth Radio] service worker registration failed', error);
        });
    },
    { once: true },
  );
}
