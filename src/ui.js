/**
 * DOM layer: date navigation, transport, volume, event views, detail cards,
 * and the "heard" log. All user-visible API strings reach the DOM through
 * textContent.
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
const MIN_DATE = '1900-01-01';
const VOLUME_KEY = 'earth-radio.volume.v1';
const MUTED_KEY = 'earth-radio.muted.v1';

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readStoredNumber(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null || stored.trim() === '') return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Preferences are a convenience; private mode can refuse storage.
  }
}

export function createUI(callbacks = {}) {
  const el = {
    dateInput: $('date-input'),
    dateMeta: $('date-meta'),
    prevDay: $('prev-day'),
    nextDay: $('next-day'),
    todayButton: $('today-button'),
    refreshDay: $('refresh-day'),
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
    mapStatus: $('map-status'),
    mapState: $('map-state'),
    mapStateText: $('map-state-text'),
    mapRetry: $('map-retry'),
    seismo: document.querySelector('.seismo'),
    nowSounding: $('now-sounding'),
    nowKicker: $('now-kicker'),
    nowSoundingLabel: $('now-sounding-label'),
    nextQuake: $('next-quake'),
    strongestQuake: $('strongest-quake'),
    strongestLabel: $('strongest-label'),
    muteToggle: $('mute-toggle'),
    volumeInput: $('volume-input'),
    volumeValue: $('volume-value'),
    shareButton: $('share-button'),
    exportButton: $('export-button'),
    toolStatus: $('tool-status'),
    viewHeard: $('view-heard'),
    viewAll: $('view-all'),
    eventViewEyebrow: $('event-view-eyebrow'),
    eventViewTitle: $('event-view-title'),
    log: $('log'),
    logCount: $('log-count'),
    indexView: $('index-view'),
    indexMinMag: $('index-min-mag'),
    indexWindow: $('index-window'),
    dayIndex: $('day-index'),
    indexEmpty: $('index-empty'),
    detail: $('detail'),
    detailClose: $('detail-close'),
    detailMag: $('detail-mag'),
    detailPlace: $('detail-place'),
    detailDepth: $('detail-depth'),
    detailTime: $('detail-time'),
    detailCoords: $('detail-coords'),
    detailId: $('detail-id'),
    detailReplay: $('detail-replay'),
    detailShare: $('detail-share'),
    detailLink: $('detail-link'),
  };

  el.dateInput.max = todayUtcDate();
  el.dateInput.min = MIN_DATE;
  el.detail.setAttribute('aria-live', 'polite');

  const logIds = new Set();
  let selectedId = null;
  let activeEvent = null;
  let detailReturnFocus = null;
  let currentDate = '';
  let dataEnabled = false;
  let loading = false;
  let audioState = 'off';
  let playing = false;
  let ended = false;
  let exporting = false;
  let allEvents = [];
  let strongestEvent = null;
  let viewMode = 'heard';
  let nowTimer = 0;
  let statusTimer = 0;

  let volume = clamp(readStoredNumber(VOLUME_KEY, 0.8), 0, 1);
  let muted = readStoredBoolean(MUTED_KEY, false);

  function audioPreferences() {
    return { volume, muted };
  }

  function renderAudioPreferences() {
    const percent = Math.round(volume * 100);
    el.volumeInput.value = String(percent);
    el.volumeValue.textContent = `${percent}%`;
    el.volumeInput.setAttribute(
      'aria-valuetext',
      `${percent} percent${muted ? ', muted' : ''}`,
    );
    el.muteToggle.textContent = muted ? 'Unmute' : 'Mute';
    el.muteToggle.setAttribute('aria-pressed', String(muted));
    el.muteToggle.setAttribute(
      'aria-label',
      muted ? 'Unmute audio' : 'Mute audio',
    );
  }

  function persistAudioPreferences() {
    writeStored(VOLUME_KEY, volume);
    writeStored(MUTED_KEY, muted);
  }

  function emitAudioPreferences() {
    persistAudioPreferences();
    renderAudioPreferences();
    callbacks.onAudioPreferencesChange?.(audioPreferences());
  }

  function setDate(date) {
    currentDate = date;
    el.dateInput.value = date;
    el.dateMeta.textContent = formatDateMeta(date);
    const today = todayUtcDate();
    el.dateInput.max = today;
    el.prevDay.disabled = loading || date <= MIN_DATE;
    el.nextDay.disabled = loading || date >= today;
    el.todayButton.disabled = loading || date >= today;
    el.refreshDay.disabled = loading;
  }

  function setDataEnabled(enabled) {
    dataEnabled = Boolean(enabled);
    updateActionAvailability();
    renderStartButton();
  }

  function updateActionAvailability() {
    const available = dataEnabled && !loading;
    el.playButton.disabled = !available;
    el.nextQuake.disabled = !available || allEvents.length === 0;
    el.strongestQuake.disabled = !available || !strongestEvent;
    el.exportButton.disabled = !available || exporting;
    el.shareButton.disabled = !currentDate;
  }

  function renderStartButton() {
    const visible =
      audioState === 'off' || audioState === 'error' || audioState === 'starting';
    el.startButton.hidden = !visible;
    el.startButton.disabled =
      !dataEnabled || loading || audioState === 'starting';
    if (audioState === 'error') {
      el.startLabel.textContent = 'Try audio again';
    } else if (audioState === 'starting') {
      el.startLabel.textContent = 'Starting…';
    } else {
      el.startLabel.textContent = 'Start listening';
    }
  }

  function renderAudioCopy() {
    document.body.classList.toggle('is-audio-live', audioState === 'live');

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
        'The day is playing. Click any quake on the map or in the index to pause, frame it, and hear it on its own.';
    } else {
      el.audioKicker.textContent = 'Sound is ready';
      el.audioStatus.textContent =
        'Press play to continue the day, or click any quake marker to audition its sound.';
    }
  }

  function showMapState(text, { loading: showLoader = false, retry = false } = {}) {
    el.mapState.hidden = false;
    el.mapStateText.textContent = text;
    el.mapRetry.hidden = !retry;
    el.seismo.hidden = !showLoader;
  }

  function hideMapState() {
    el.mapState.hidden = true;
  }

  function setSource(label, { cached = false } = {}) {
    el.dataSource.textContent = label;
    el.dataSource.classList.toggle('is-cached', cached);
  }

  function setMapStatus(status) {
    if (!status) {
      el.mapStatus.hidden = true;
      el.mapStatus.textContent = '';
      return;
    }
    el.mapStatus.hidden = false;
    if (status === 'fallback') {
      el.mapStatus.textContent = 'Basemap fallback';
      el.mapStatus.title =
        'The primary Esri basemap did not load; showing OpenStreetMap tiles instead.';
    } else if (status === 'unavailable') {
      el.mapStatus.textContent = 'Map tiles unavailable';
      el.mapStatus.title =
        'The map background could not load. Quake markers and the timeline still work.';
    }
  }

  function setToolStatus(message, { error = false, duration = 4500 } = {}) {
    window.clearTimeout(statusTimer);
    if (!message) {
      el.toolStatus.hidden = true;
      el.toolStatus.textContent = '';
      return;
    }
    el.toolStatus.hidden = false;
    el.toolStatus.textContent = message;
    el.toolStatus.classList.toggle('is-error', error);
    if (duration > 0) {
      statusTimer = window.setTimeout(() => {
        el.toolStatus.hidden = true;
        el.toolStatus.textContent = '';
      }, duration);
    }
  }

  function setLoading(date) {
    loading = true;
    setDate(date);
    dataEnabled = false;
    allEvents = [];
    strongestEvent = null;
    closeDetail({ restoreFocus: false, silent: true });
    hideNowSounding();
    setView('heard');
    clearLog('Reading the day from USGS…');
    el.dayIndex.replaceChildren();
    el.indexEmpty.hidden = true;
    el.logCount.textContent = '0';
    el.statCount.textContent = '—';
    el.statMax.textContent = '—';
    el.statMax.title = '';
    el.strongestLabel.textContent = '—';
    el.mapCount.textContent = '— events';
    el.dataSource.title = '';
    setSource('Live feed');
    showMapState('Tuning into the USGS feed…', { loading: true });
    updateActionAvailability();
    renderStartButton();
  }

  function setDay({ date, events, cached = false, stale = false, today = false }) {
    loading = false;
    dataEnabled = true;
    allEvents = events;
    strongestEvent = events.reduce(
      (peak, event) => (!peak || event.mag > peak.mag ? event : peak),
      null,
    );

    setDate(date);
    const count = events.length;
    el.statCount.textContent = count.toLocaleString('en-US');
    el.statMax.textContent = strongestEvent ? formatMag(strongestEvent.mag) : '—';
    el.statMax.title = strongestEvent ? strongestEvent.place : '';
    el.strongestLabel.textContent = strongestEvent
      ? formatMag(strongestEvent.mag)
      : '—';
    el.mapCount.textContent = `${count.toLocaleString('en-US')} ${
      count === 1 ? 'event' : 'events'
    }`;

    const source = today
      ? 'Today so far'
      : stale
        ? 'Offline cache'
        : cached
          ? 'Cached day'
          : 'Live feed';
    setSource(source, { cached: cached || stale });
    el.dataSource.title = today
      ? 'Today is still in progress. Refresh to pull the latest USGS events.'
      : cached || stale
        ? 'Loaded from the local day cache.'
        : 'Loaded from the live USGS feed.';

    if (count === 0) {
      showMapState('No M2.5+ earthquakes were recorded on this date. The drone still holds the key.');
      if (!logIds.size) {
        setLogMessage('A quiet day. Press play for the drone bed alone.');
      }
    } else {
      hideMapState();
      if (!logIds.size) {
        setLogMessage('Press play. Each quake will log itself here as it sounds.');
      }
    }

    renderIndex();
    setDataEnabled(true);
    updateActionAvailability();
    renderStartButton();
  }

  function setError(message) {
    loading = false;
    dataEnabled = false;
    allEvents = [];
    strongestEvent = null;
    closeDetail({ restoreFocus: false, silent: true });
    hideNowSounding();
    setView('heard');
    el.statCount.textContent = '—';
    el.statMax.textContent = '—';
    el.statMax.title = '';
    el.strongestLabel.textContent = '—';
    el.mapCount.textContent = '— events';
    el.dataSource.title = '';
    setSource('Feed error');
    showMapState(message, { retry: true });
    el.dayIndex.replaceChildren();
    el.indexEmpty.hidden = true;
    if (!logIds.size) {
      setLogMessage('The USGS feed did not answer for this date.');
    }
    updateActionAvailability();
    renderStartButton();
    setDate(currentDate);
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
      playing ? 'Pause the day' : ended ? 'Replay the day' : 'Play the day',
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
    setLogMessage(
      message || 'Press play. Each quake will log itself here as it sounds.',
    );
    if (viewMode === 'heard') el.logCount.textContent = '0';
  }

  function eventButton(event, mode) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'log-entry';
    button.dataset.eventId = event.id;
    button.setAttribute(
      'aria-label',
      `${formatMag(event.mag)}, ${event.place}, ${formatClock(
        event.offset,
      )} UTC. ${mode === 'index' ? 'Jump to and replay.' : 'Show details and replay.'}`,
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
      if (mode === 'index') callbacks.onIndexSelect?.(event, button);
      else callbacks.onLogSelect?.(event, button);
    });
    return button;
  }

  function trimLog() {
    const entries = [...el.log.querySelectorAll('.log-entry')];
    for (let index = MAX_LOG_ENTRIES; index < entries.length; index += 1) {
      const entry = entries[index];
      logIds.delete(entry.dataset.eventId);
      entry.remove();
    }
    if (viewMode === 'heard') {
      el.logCount.textContent = String(logIds.size);
    }
  }

  function addLog(event) {
    if (!event || logIds.has(event.id)) return;
    logIds.add(event.id);

    const empty = el.log.querySelector('.log__empty');
    empty?.remove();

    const nearTop = el.log.scrollTop < 24;
    el.log.prepend(eventButton(event, 'heard'));
    trimLog();
    if (nearTop) el.log.scrollTop = 0;
  }

  function markActive(id) {
    selectedId = id;
    for (const entry of el.log.querySelectorAll('.log-entry')) {
      entry.classList.toggle('is-active', entry.dataset.eventId === id);
    }
    for (const entry of el.dayIndex.querySelectorAll('.log-entry')) {
      entry.classList.toggle('is-active', entry.dataset.eventId === id);
    }
  }

  function indexEvents() {
    const minMagnitude = Number(el.indexMinMag.value) || 2.5;
    const windowStart = el.indexWindow.value;
    return allEvents.filter((event) => {
      if (event.mag < minMagnitude) return false;
      if (windowStart === 'all') return true;
      const hour = Math.floor(event.offset / 3_600_000);
      const start = Number(windowStart);
      return hour >= start && hour < start + 6;
    });
  }

  function renderIndex() {
    const filtered = indexEvents();
    el.dayIndex.replaceChildren();
    el.indexEmpty.hidden = filtered.length > 0;
    if (!filtered.length) {
      el.indexEmpty.textContent = allEvents.length
        ? 'No quakes match those filters.'
        : 'No events are loaded for this day yet.';
    }

    const fragment = document.createDocumentFragment();
    for (const event of filtered) {
      const button = eventButton(event, 'index');
      button.classList.add('index-entry');
      if (event.id === selectedId) button.classList.add('is-active');
      fragment.append(button);
    }
    el.dayIndex.append(fragment);

    if (viewMode === 'all') {
      el.logCount.textContent =
        filtered.length === allEvents.length
          ? String(allEvents.length)
          : `${filtered.length}/${allEvents.length}`;
      el.logCount.title = `${filtered.length} of ${allEvents.length} events`;
    }
  }

  function setView(nextView) {
    viewMode = nextView === 'all' ? 'all' : 'heard';
    const isAll = viewMode === 'all';
    el.log.hidden = isAll;
    el.indexView.hidden = !isAll;
    el.viewHeard.classList.toggle('is-active', !isAll);
    el.viewAll.classList.toggle('is-active', isAll);
    el.viewHeard.setAttribute('aria-pressed', String(!isAll));
    el.viewAll.setAttribute('aria-pressed', String(isAll));
    el.eventViewEyebrow.textContent = isAll ? 'Day index' : 'Signal log';
    el.eventViewTitle.textContent = isAll ? 'All quakes' : 'Heard on this day';

    if (isAll) {
      renderIndex();
    } else {
      el.logCount.textContent = String(logIds.size);
      el.logCount.title = `${logIds.size} heard`;
    }
  }

  function openDetail(event, { focus = true, returnFocus = null } = {}) {
    if (!event) return;
    const previous =
      returnFocus ||
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    if (
      previous &&
      previous !== document.body &&
      previous !== document.documentElement &&
      !el.detail.contains(previous)
    ) {
      detailReturnFocus = previous;
    }

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
    if (focus) el.detailClose.focus({ preventScroll: true });
  }

  function closeDetail({ restoreFocus = true, silent = false } = {}) {
    const wasOpen = !el.detail.hidden;
    el.detail.hidden = true;
    activeEvent = null;
    markActive(null);
    const focusTarget = detailReturnFocus;
    detailReturnFocus = null;

    if (
      restoreFocus &&
      focusTarget?.isConnected &&
      focusTarget.getClientRects().length > 0
    ) {
      focusTarget.focus({ preventScroll: true });
    }
    if (wasOpen && !silent) callbacks.onDetailClose?.();
  }

  function showNowSounding(event, { groupSize = 1, audition = false } = {}) {
    if (!event) return;
    window.clearTimeout(nowTimer);
    el.nowKicker.textContent = audition ? 'Auditioning' : 'Now sounding';
    const suffix = groupSize > 1 ? ` · +${groupSize - 1}` : '';
    el.nowSoundingLabel.textContent = `${formatMag(event.mag)} · ${event.place}${suffix}`;
    el.nowSounding.hidden = false;
    nowTimer = window.setTimeout(() => {
      el.nowSounding.hidden = true;
    }, 3400);
  }

  function hideNowSounding() {
    window.clearTimeout(nowTimer);
    el.nowSounding.hidden = true;
  }

  function setExporting(next) {
    exporting = Boolean(next);
    el.exportButton.textContent = exporting ? 'Rendering…' : 'WAV';
    updateActionAvailability();
  }

  el.startButton.addEventListener('click', () => callbacks.onStart?.());
  el.playButton.addEventListener('click', () => callbacks.onPlayToggle?.());
  el.mapRetry.addEventListener('click', () => callbacks.onRetry?.());
  el.prevDay.addEventListener('click', () => callbacks.onStepDate?.(-1));
  el.nextDay.addEventListener('click', () => callbacks.onStepDate?.(1));
  el.todayButton.addEventListener('click', () => callbacks.onToday?.());
  el.refreshDay.addEventListener('click', () => callbacks.onRefresh?.());
  el.nextQuake.addEventListener('click', () => callbacks.onNextQuake?.());
  el.strongestQuake.addEventListener('click', () => callbacks.onStrongest?.());
  el.shareButton.addEventListener('click', () => callbacks.onShare?.());
  el.detailShare.addEventListener('click', () => {
    if (activeEvent) callbacks.onShareEvent?.(activeEvent);
  });
  el.exportButton.addEventListener('click', () => callbacks.onExport?.());

  el.volumeInput.addEventListener('input', () => {
    volume = clamp(Number(el.volumeInput.value) / 100, 0, 1);
    if (volume > 0 && muted) muted = false;
    emitAudioPreferences();
  });

  el.muteToggle.addEventListener('click', () => {
    muted = !muted;
    emitAudioPreferences();
  });

  el.viewHeard.addEventListener('click', () => setView('heard'));
  el.viewAll.addEventListener('click', () => setView('all'));
  el.indexMinMag.addEventListener('change', renderIndex);
  el.indexWindow.addEventListener('change', renderIndex);

  el.dateInput.addEventListener('change', () => {
    if (!isValidDateString(el.dateInput.value)) {
      setDate(currentDate);
      return;
    }
    callbacks.onDateChange?.(el.dateInput.value);
  });

  el.detailClose.addEventListener('click', () => closeDetail());
  el.detailReplay.addEventListener('click', () => {
    if (activeEvent) callbacks.onReplay?.(activeEvent);
  });

  for (const button of el.speedButtons) {
    button.addEventListener('click', () => {
      callbacks.onSpeedChange?.(Number(button.dataset.speed));
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.detail.hidden) {
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
  renderAudioPreferences();
  renderStartButton();
  renderIndex();

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
    setMapStatus,
    setToolStatus,
    addLog,
    clearLog,
    markActive,
    openDetail,
    closeDetail,
    showNowSounding,
    hideNowSounding,
    showMapState,
    hideMapState,
    setSource,
    setView,
    setExporting,
    getAudioPreferences: audioPreferences,
  };
}
