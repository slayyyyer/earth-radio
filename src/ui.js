/**
 * DOM layer: date input, transport state, event cards, and the "heard" log.
 * All user-visible strings come from the API only via textContent.
 */

import {
  DAY_MS,
  formatClock,
  formatDateMeta,
  formatEventTimestamp,
  isValidDateString,
  todayUtcDate,
} from './data.js';

const MAX_LOG_ENTRIES = 60;

function formatMag(mag) {
  return Number.isFinite(Number(mag)) ? `M${Number(mag).toFixed(1)}` : 'M—';
}

function formatCoordinate(value, positive, negative) {
  return `${Math.abs(value).toFixed(3)}° ${value >= 0 ? positive : negative}`;
}

function formatDepth(depth) {
  return Number.isFinite(depth) ? `${depth.toFixed(1)} km` : '—';
}

function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

export function createUI(callbacks = {}) {
  const el = {
    dateInput: $('date-input'),
    dateMeta: $('date-meta'),
    startButton: $('start-listening'),
    startLabel: document.querySelector('#start-listening .start-button__label'),
    audioDot: $('audio-dot'),
    audioKicker: $('audio-kicker'),
    audioStatus: $('audio-status'),
    playButton: $('play-toggle'),
    clock: $('clock'),
    timecode: $('timecode-now'),
    durationLabel: $('duration-label'),
    speedButtons: [...document.querySelectorAll('[data-speed]')],
    statCount: $('stat-count'),
    statMax: $('stat-max'),
    mapCount: $('map-count'),
    dataSource: $('data-source'),
    mapState: $('map-state'),
    mapStateText: $('map-state-text'),
    mapRetry: $('map-retry'),
    seismo: document.querySelector('.seismo'),
    log: $('log'),
    logCount: $('log-count'),
    detail: $('detail'),
    detailClose: $('detail-close'),
    detailMag: $('detail-mag'),
    detailPlace: $('detail-place'),
    detailDepth: $('detail-depth'),
    detailTime: $('detail-time'),
    detailCoords: $('detail-coords'),
    detailId: $('detail-id'),
    detailReplay: $('detail-replay'),
    detailLink: $('detail-link'),
  };

  el.dateInput.max = todayUtcDate();
  el.dateInput.min = '1900-01-01';
  el.detail.setAttribute('aria-live', 'polite');

  const logIds = new Set();
  let selectedId = null;
  let activeEvent = null;
  let currentDate = '';
  let dataEnabled = false;
  let audioState = 'off';
  let playing = false;
  let ended = false;

  function setDate(date) {
    currentDate = date;
    el.dateInput.value = date;
    el.dateMeta.textContent = formatDateMeta(date);
  }

  function setDataEnabled(enabled) {
    dataEnabled = Boolean(enabled);
    el.playButton.disabled = !dataEnabled;
    renderStartButton();
  }

  function renderStartButton() {
    const visible = audioState === 'off' || audioState === 'error' || audioState === 'starting';
    el.startButton.hidden = !visible;
    el.startButton.disabled =
      !dataEnabled || audioState === 'starting';
    if (audioState === 'error') {
      el.startLabel.textContent = 'Try audio again';
    } else if (audioState === 'starting') {
      el.startLabel.textContent = 'Starting…';
    } else {
      el.startLabel.textContent = 'Start listening';
    }
  }

  function renderAudioCopy() {
    document.body.classList.toggle(
      'is-audio-live',
      audioState === 'live',
    );

    if (audioState === 'off') {
      el.audioKicker.textContent = 'Headphones recommended';
      el.audioStatus.textContent =
        'This is a browser instrument. It needs one tap before it can make sound.';
    } else if (audioState === 'starting') {
      el.audioKicker.textContent = 'Waking the audio engine';
      el.audioStatus.textContent =
        'Routing voices, tuning the drone, and building the reverb…';
    } else if (audioState === 'error') {
      el.audioKicker.textContent = 'Audio unavailable';
      el.audioStatus.textContent =
        'Your browser could not start Web Audio. Check your sound settings and try again — the map and timeline still work.';
    } else if (playing) {
      el.audioKicker.textContent = 'Sound is live';
      el.audioStatus.textContent =
        'The day is playing. Click any quake on the map or in the log to hear it on its own.';
    } else {
      el.audioKicker.textContent = 'Sound is ready';
      el.audioStatus.textContent =
        'Press play to continue the day, or click any quake marker to replay its sound.';
    }
  }

  function showMapState(text, { loading = false, retry = false } = {}) {
    el.mapState.hidden = false;
    el.mapStateText.textContent = text;
    el.mapRetry.hidden = !retry;
    el.seismo.hidden = !loading;
  }

  function hideMapState() {
    el.mapState.hidden = true;
  }

  function setSource(label, { cached = false } = {}) {
    el.dataSource.textContent = label;
    el.dataSource.classList.toggle('is-cached', cached);
  }

  function setLoading(date) {
    setDate(date);
    setDataEnabled(false);
    closeDetail();
    clearLog('Reading the day from USGS…');
    el.statCount.textContent = '—';
    el.statMax.textContent = '—';
    el.statMax.title = '';
    el.mapCount.textContent = '— events';
    setSource('Live feed');
    showMapState('Tuning into the USGS feed…', { loading: true });
    el.logCount.textContent = '0';
  }

  function setDay({ date, events, cached = false, stale = false }) {
    setDate(date);
    setDataEnabled(true);

    const count = events.length;
    const strongest = events.reduce(
      (peak, event) => (!peak || event.mag > peak.mag ? event : peak),
      null,
    );

    el.statCount.textContent = count.toLocaleString('en-US');
    el.statMax.textContent = strongest ? formatMag(strongest.mag) : '—';
    el.statMax.title = strongest ? strongest.place : '';
    el.mapCount.textContent = `${count.toLocaleString('en-US')} ${
      count === 1 ? 'event' : 'events'
    }`;
    setSource(
      stale ? 'Offline cache' : cached ? 'Cached day' : 'Live feed',
      { cached: cached || stale },
    );

    if (count === 0) {
      showMapState(
        'No M2.5+ earthquakes were recorded on this date. The drone still holds the key.',
      );
      if (!logIds.size) {
        setLogMessage('A quiet day. Press play for the drone bed alone.');
      }
    } else {
      hideMapState();
      if (!logIds.size) {
        setLogMessage(
          'Press play. Each quake will log itself here as it sounds.',
        );
      }
    }
    renderStartButton();
  }

  function setError(message) {
    setDataEnabled(false);
    closeDetail();
    el.statCount.textContent = '—';
    el.statMax.textContent = '—';
    el.statMax.title = '';
    el.mapCount.textContent = '— events';
    setSource('Feed error');
    showMapState(message, { retry: true });
    if (!logIds.size) {
      setLogMessage('The USGS feed did not answer for this date.');
    }
  }

  function setAudioState(nextState) {
    audioState = nextState;
    renderAudioCopy();
    renderStartButton();
  }

  function setPlaying(nextPlaying, { isEnded = false } = {}) {
    playing = Boolean(nextPlaying);
    ended = Boolean(isEnded);
    el.playButton.classList.toggle('is-playing', playing);
    el.playButton.setAttribute(
      'aria-label',
      playing
        ? 'Pause the day'
        : ended
          ? 'Replay the day'
          : 'Play the day',
    );
    renderAudioCopy();
  }

  function setClock(ms) {
    const label = ms >= DAY_MS ? '24:00:00' : formatClock(ms);
    el.clock.textContent = label;
    el.timecode.textContent = label;
  }

  function setSpeed(speed) {
    for (const button of el.speedButtons) {
      const active = Number(button.dataset.speed) === speed;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    el.durationLabel.textContent = `24 h → ${Math.round(90 / speed)} s`;
  }

  function setLogMessage(message) {
    for (const entry of el.log.querySelectorAll('.log-entry')) entry.remove();
    let empty = el.log.querySelector('.log__empty');
    if (!empty) {
      empty = document.createElement('p');
      empty.className = 'log__empty';
      el.log.append(empty);
    }
    empty.textContent = message;
  }

  function clearLog(message = '') {
    for (const entry of el.log.querySelectorAll('.log-entry')) entry.remove();
    logIds.clear();
    selectedId = null;
    el.logCount.textContent = '0';
    setLogMessage(
      message || 'Press play. Each quake will log itself here as it sounds.',
    );
  }

  function logNode(event) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'log-entry';
    button.dataset.eventId = event.id;
    button.setAttribute(
      'aria-label',
      `${formatMag(event.mag)}, ${event.place}, ${formatClock(
        event.offset,
      )} UTC. Show details and replay.`,
    );

    const time = document.createElement('span');
    time.className = 'log-entry__time';
    time.textContent = formatClock(event.offset);

    const mag = document.createElement('span');
    mag.className = 'log-entry__mag';
    mag.textContent = formatMag(event.mag);

    const place = document.createElement('span');
    place.className = 'log-entry__place';
    place.textContent = event.place;

    button.append(time, mag, place);
    button.addEventListener('click', () => {
      markActive(event.id);
      callbacks.onLogSelect?.(event);
    });
    return button;
  }

  function trimLog() {
    const entries = [...el.log.querySelectorAll('.log-entry')];
    for (let i = MAX_LOG_ENTRIES; i < entries.length; i += 1) {
      const entry = entries[i];
      logIds.delete(entry.dataset.eventId);
      entry.remove();
    }
    el.logCount.textContent = String(logIds.size);
  }

  function addLog(event) {
    if (!event || logIds.has(event.id)) return;
    logIds.add(event.id);

    const empty = el.log.querySelector('.log__empty');
    empty?.remove();

    const nearTop = el.log.scrollTop < 24;
    el.log.prepend(logNode(event));
    trimLog();
    if (nearTop) el.log.scrollTop = 0;
  }

  function markActive(id) {
    selectedId = id;
    for (const entry of el.log.querySelectorAll('.log-entry')) {
      entry.classList.toggle('is-active', entry.dataset.eventId === id);
    }
  }

  function openDetail(event) {
    if (!event) return;
    activeEvent = event;

    el.detailMag.textContent = formatMag(event.mag);
    el.detailPlace.textContent = event.place;
    el.detailDepth.textContent = formatDepth(event.depthKm);
    el.detailTime.textContent = formatEventTimestamp(event.time);
    el.detailCoords.textContent = `${formatCoordinate(
      event.lat,
      'N',
      'S',
    )}, ${formatCoordinate(event.lon, 'E', 'W')}`;
    el.detailId.textContent = event.id;
    el.detailLink.href = event.url;
    el.detail.hidden = false;
    markActive(event.id);
  }

  function closeDetail() {
    el.detail.hidden = true;
    activeEvent = null;
    markActive(null);
  }

  function handleDateInput() {
    if (!isValidDateString(el.dateInput.value)) {
      setDate(currentDate);
      return;
    }
    callbacks.onDateChange?.(el.dateInput.value);
  }

  el.startButton.addEventListener('click', () => callbacks.onStart?.());
  el.playButton.addEventListener('click', () => callbacks.onPlayToggle?.());
  el.mapRetry.addEventListener('click', () => callbacks.onRetry?.());
  el.dateInput.addEventListener('change', handleDateInput);
  el.detailClose.addEventListener('click', closeDetail);
  el.detailReplay.addEventListener('click', () => {
    // Keep the open card's event independently of the rolling 60-entry log, so
    // it remains replayable even if later events push it out of the list.
    if (activeEvent) callbacks.onReplay?.(activeEvent);
  });

  for (const button of el.speedButtons) {
    button.addEventListener('click', () => {
      callbacks.onSpeedChange?.(Number(button.dataset.speed));
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDetail();
      return;
    }

    if (
      event.code !== 'Space' ||
      event.repeat ||
      event.defaultPrevented
    ) {
      return;
    }

    const target = document.activeElement;
    const tag = target?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      tag === 'BUTTON' ||
      tag === 'A' ||
      target?.isContentEditable
    ) {
      return;
    }

    event.preventDefault();
    callbacks.onPlayToggle?.();
  });

  setSpeed(1);
  renderAudioCopy();
  renderStartButton();

  return {
    el,
    setDate,
    setLoading,
    setDay,
    setError,
    setDataEnabled,
    setAudioState,
    setPlaying,
    setClock,
    setSpeed,
    addLog,
    clearLog,
    markActive,
    openDetail,
    closeDetail,
    showMapState,
    hideMapState,
    setSource,
  };
}
