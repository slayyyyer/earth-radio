/**
 * Earth Radio — app orchestration.
 *
 * The timeline clock is a requestAnimationFrame clock; Web Audio voices are
 * scheduled against AudioContext time when a cue crosses the playhead. The
 * same mapping function is used for playback and manual replays.
 */

import 'leaflet/dist/leaflet.css';
import './styles.css';

import {
  DAY_MS,
  HOUR_MS,
  defaultUtcDate,
  isValidDateString,
  loadDay,
  todayUtcDate,
} from './data.js';
import { densityAt, hourlyDensity, mapEvent } from './mapping.js';
import { AudioEngine } from './audio.js';
import { QuakeMap } from './map.js';
import { Timeline } from './timeline.js';
import { createUI } from './ui.js';

const BASE_SECONDS = 90;
const COMP_MS_PER_REAL_MS = DAY_MS / (BASE_SECONDS * 1000);
const MAX_EVENTS_PER_TICK = 24;

const state = {
  date: defaultUtcDate(),
  events: [],
  hourly: hourlyDensity([]),
  playhead: 0,
  cursor: 0,
  playing: false,
  playPending: false,
  speed: 1,
  loading: false,
  loadToken: 0,
  abortController: null,
  audio: null,
  audioState: 'off',
  audioAttempt: null,
  frameId: 0,
  lastTimestamp: 0,
  lastDensityHour: -1,
};

const ui = createUI({
  onStart: () => void startListening(),
  onPlayToggle: () => void togglePlayback(),
  onDateChange: (date) => void handleDateChange(date),
  onSpeedChange: (speed) => setSpeed(speed),
  onRetry: () => void loadDate(state.date, { force: true }),
  onReplay: (event) => {
    if (!event) return;
    quakeMap.pulse(event);
    void replayEvent(event);
  },
  onLogSelect: (event) => selectEvent(event, 'log'),
});

const quakeMap = new QuakeMap(document.getElementById('map'), {
  onSelect: (event) => selectEvent(event, 'map'),
  onBackground: () => ui.closeDetail(),
});

const timeline = new Timeline(document.getElementById('timeline'), {
  tooltip: document.getElementById('timeline-tooltip'),
  onSeek: seek,
});

ui.setDate(state.date);
ui.setSpeed(1);
void loadDate(state.date);

// rAF and precise cue scheduling cannot continue in a background tab, so
// stop the piece rather than leaving only the drone running.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) pause();
});

/* ------------------------------------------------------------------ data */

async function handleDateChange(date) {
  if (!isValidDateString(date)) {
    ui.setDate(state.date);
    return;
  }
  if (date === state.date) return;

  const today = todayUtcDate();
  const nextDate = date > today ? today : date;
  await loadDate(nextDate);
}

async function loadDate(date, { force = false } = {}) {
  if (!isValidDateString(date)) return;

  const today = todayUtcDate();
  const safeDate = date > today ? today : date;
  const token = ++state.loadToken;

  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;

  pause();
  state.date = safeDate;
  state.loading = true;
  state.events = [];
  state.hourly = hourlyDensity([]);
  state.playhead = 0;
  state.cursor = 0;
  state.lastDensityHour = -1;

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
    state.playhead = 0;
    state.cursor = 0;

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
    });
    ui.setAudioState(state.audioState);
    syncDensity(true);
  } catch (error) {
    if (error?.name === 'AbortError' || token !== state.loadToken) return;
    console.error('[Earth Radio] day load failed', error);
    state.events = [];
    state.hourly = hourlyDensity([]);
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

async function startListening() {
  if (state.audioState === 'live') {
    if (!state.playing) await play();
    return;
  }

  const started = await ensureAudio();
  if (!started) return;
  await play();
}

async function replayEvent(event) {
  if (!event) return;
  const started = await ensureAudio();
  if (!started || !state.audio) return;

  try {
    state.audio.trigger(
      mapEvent(event),
      state.audio.ctx.currentTime + 0.03,
    );
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
      ui.setClock(0);
      timeline.setPlayhead(0);
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
    state.frameId = requestAnimationFrame(tick);
  } finally {
    state.playPending = false;
  }
}

function pause() {
  if (state.frameId) {
    cancelAnimationFrame(state.frameId);
    state.frameId = 0;
  }
  state.playing = false;
  state.lastTimestamp = 0;
  if (state.audio) state.audio.setActive(false);
  ui.setPlaying(false);
  ui.setAudioState(state.audioState);
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

  state.playhead = nextPlayhead;
  timeline.setPlayhead(nextPlayhead);
  ui.setClock(nextPlayhead);
  syncDensity();

  if (nextPlayhead >= DAY_MS) {
    pause();
    ui.setClock(DAY_MS);
    ui.setPlaying(false, { isEnded: true });
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
 * Fire the events between the cursor and the new playhead, with one batched
 * audio schedule and one visual pass. The cursor is advanced by the same
 * number of cues.
 */
function fireCues(cursor, untilOffset, onCue) {
  const cues = [];
  let index = cursor;

  while (
    index < state.events.length &&
    state.events[index].offset <= untilOffset &&
    cues.length < MAX_EVENTS_PER_TICK
  ) {
    cues.push(state.events[index]);
    index += 1;
  }

  if (!cues.length) return 0;
  state.cursor = index;

  if (state.audio) {
    const when = state.audio.ctx.currentTime + 0.025;
    try {
      state.audio.triggerBatch(cues.map(mapEvent), when);
    } catch (error) {
      console.error('[Earth Radio] could not schedule playback cues', error);
    }
  }

  for (const cue of cues) onCue(cue);
  return cues.length;
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

function seek(ms) {
  if (!Number.isFinite(ms)) return;

  state.playhead = Math.max(0, Math.min(DAY_MS, ms));
  state.cursor = lowerBound(state.events, state.playhead);
  state.lastDensityHour = -1;
  timeline.setPlayhead(state.playhead);
  ui.setClock(state.playhead);
  syncDensity(true);

  if (state.playing && state.playhead >= DAY_MS) {
    pause();
    ui.setPlaying(false, { isEnded: true });
  } else if (state.playing) {
    state.lastTimestamp = performance.now();
  } else {
    ui.setPlaying(false, { isEnded: state.playhead >= DAY_MS });
  }
}

function lowerBound(events, offset) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].offset < offset) low = mid + 1;
    else high = mid;
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

function selectEvent(event, source) {
  if (!event) return;

  ui.addLog(event);
  ui.openDetail(event);
  quakeMap.pulse(event);
  if (source === 'log') quakeMap.focus(event);
  void replayEvent(event);
}

/* --------------------------------------------------- developer verification */

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
    renderDayForAnalysis,
  };
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function db(value) {
  return round(20 * Math.log10(Math.max(value, 1e-6)), 2);
}

/**
 * Dev-only offline render used to tune the levels of busy and quiet days.
 * It builds an isolated AudioEngine on an OfflineAudioContext, schedules the
 * whole day, then reports peak/RMS, clipping, polyphony, and mapping spreads.
 */
async function renderDayForAnalysis(date, seconds = 92, options = {}) {
  const OfflineContextClass =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContextClass) throw new Error('OfflineAudioContext unavailable');

  const { events } = await loadDay(date);
  const sampleRate = options.sampleRate ?? 44100;
  const frameCount = Math.ceil(seconds * sampleRate);
  const offline = new OfflineContextClass(2, frameCount, sampleRate);
  const engine = new AudioEngine(offline);

  const startPad = 0.12;
  const span = Math.max(1, seconds - 1.4);
  const hourly = hourlyDensity(events);

  engine.setActive(true, 0.01);
  for (let hour = 0; hour < 24; hour += 1) {
    engine.setDensity(
      hourly.levels[hour],
      startPad + (hour / 24) * span,
    );
  }
  for (const event of events) {
    engine.trigger(mapEvent(event), startPad + (event.offset / DAY_MS) * span);
  }

  const buffer = await offline.startRendering();
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (let i = 0; i < left.length; i += 1) {
    const amplitude = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    peak = Math.max(peak, amplitude);
    if (amplitude >= 0.999) clipped += 1;
    sumSquares += left[i] * left[i] + right[i] * right[i];
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
    for (let i = start; i < end; i += 1) {
      segmentPeak = Math.max(segmentPeak, Math.abs(left[i]));
      segmentSum += left[i] * left[i];
    }
    profile.push({
      second: round(segment * (seconds / profileSegments), 1),
      peakDb: db(segmentPeak),
      rmsDb: db(Math.sqrt(segmentSum / Math.max(1, end - start))),
    });
  }

  const params = events.map(mapEvent);
  const frequencies = params.map((p) => p.frequency).sort((a, b) => a - b);
  const gains = params.map((p) => p.gain);
  const durations = params.map((p) => p.duration).sort((a, b) => a - b);
  const pans = params.map((p) => p.pan);
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    date,
    seconds,
    eventCount: events.length,
    maxMagnitude: events.length
      ? round(Math.max(...events.map((event) => event.mag)), 2)
      : 0,
    peak: round(peak, 5),
    peakDb: db(peak),
    rmsDb: db(rms),
    clippedSamples: clipped,
    engine: { ...engine.stats },
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
      subCount: params.filter((p) => p.sub).length,
      gainMedian: round(median(gains), 4),
    },
  };
}
