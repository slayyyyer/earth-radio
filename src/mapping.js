/**
 * The composition's data-to-sound mapping.
 *
 * `mapEvent` is a pure function: the same event always produces the same
 * sound parameters, regardless of play order, date, or how many times a day is
 * revisited. All small variations come from a PRNG seeded by the USGS event ID.
 *
 * Read MAPPING.md for the reasoning behind these constants.
 */

export const MIN_MAGNITUDE = 2.5;
export const MAX_REFERENCE_MAGNITUDE = 7.0;
export const DEPTH_REFERENCE_KM = 300;
export const MAX_VOICES = 16;
export const KEY_NAME = 'D minor pentatonic';

// D minor pentatonic: D F G A C. D3 (MIDI 50) through D6 (MIDI 86).
const PENTATONIC_STEPS = [0, 3, 5, 7, 10];
export const PITCHES = [];
for (let root = 50; root < 87; root += 12) {
  for (const step of PENTATONIC_STEPS) {
    const midi = root + step;
    if (midi <= 86) PITCHES.push(midi);
  }
}

// D1, A1, D2 — the low, key-locked roots used by the sub layer.
const SUB_ROOTS = [26, 33, 38];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** FNV-1a — stable across browsers and runs. */
export function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG. Returns a function producing [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Map one normalized USGS event to a complete set of sound parameters.
 *
 * Axes:
 *   longitude  -> stereo pan            (-1 left / +1 right)
 *   depth      -> scale pitch + brightness (shallow high, deep low)
 *   magnitude  -> gain, attack, decay, filter openness, sub layer
 *   latitude   -> timbre / lowpass-ish brightness offset
 *   event ID   -> seeded FM ratio, detune, delay send, sub root
 */
export function mapEvent(event) {
  const lon = clamp(finiteOr(event.lon), -180, 180);
  const lat = clamp(finiteOr(event.lat), -90, 90);
  const depthKm = Math.max(0, finiteOr(event.depthKm));
  const magnitude = Math.max(MIN_MAGNITUDE, finiteOr(event.mag, MIN_MAGNITUDE));

  // Most quakes are shallower than 70 km. A square-root curve keeps the
  // shallow register spacious instead of bunching everything at the top.
  const depthNorm = clamp(
    Math.sqrt(depthKm / DEPTH_REFERENCE_KM),
    0,
    1,
  );
  const latNorm = clamp((lat + 90) / 180, 0, 1);
  const magNorm = clamp(
    (magnitude - MIN_MAGNITUDE) /
      (MAX_REFERENCE_MAGNITUDE - MIN_MAGNITUDE),
    0,
    1,
  );

  const pan = clamp(lon / 180, -1, 1);

  // Shallow = the top of the D3–D6 pentatonic ladder, deep = the bottom.
  const pitchIndex = Math.round((1 - depthNorm) * (PITCHES.length - 1));
  const midi = PITCHES[pitchIndex];
  const frequency = midiToFrequency(midi);

  const random = mulberry32(
    hashString(
      String(
        event.id ??
          `${finiteOr(event.time)}:${lat.toFixed(3)}:${lon.toFixed(3)}`,
      ),
    ),
  );

  // Draw order is part of the deterministic contract.
  const fmChoices = magNorm > 0.5 ? [1, 1.5, 2] : [2, 2.5, 3, 4];
  const fmRatio = fmChoices[Math.floor(random() * fmChoices.length)];
  const fmIndex =
    (0.3 + random() * 0.7) * (1.25 - 0.65 * magNorm);
  const detuneCents = (random() * 2 - 1) * 5;
  const delaySend = clamp(0.07 + random() * 0.12 + 0.16 * magNorm, 0.04, 0.36);

  const attack = 0.006 + 0.52 * magNorm ** 2.2;
  const decay = 0.42 + 5.0 * magNorm ** 1.6;
  const peakGain = 0.05 + 0.26 * magNorm ** 1.35;

  // Latitude opens or closes the voice: north is airier, south is smokier.
  const latitudeBrightness = 0.6 + 0.8 * latNorm;
  const cutoff = clamp(
    420 +
      3600 *
        (1 - depthNorm) *
        (0.35 + 0.65 * magNorm) *
        latitudeBrightness,
    300,
    5400,
  );

  const q = 0.7 + 3.2 * (1 - magNorm);
  const triangleMix = clamp(
    0.08 + 0.3 * latNorm + 0.16 * (1 - magNorm),
    0.06,
    0.55,
  );
  const reverbSend = clamp(
    0.18 + 0.42 * magNorm + 0.08 * depthNorm,
    0.1,
    0.7,
  );

  let sub = null;
  if (magNorm >= 0.58) {
    const subMidi = SUB_ROOTS[Math.floor(random() * SUB_ROOTS.length)];
    sub = {
      frequency: midiToFrequency(subMidi),
      gain: peakGain * (0.28 + 0.22 * magNorm),
      decay: decay + 0.7,
    };
  }

  return {
    id: event.id,
    midi,
    frequency,
    pan,
    depthNorm,
    latNorm,
    magNorm,
    gain: peakGain,
    attack,
    decay,
    // Attack + decay, plus a little tail for the release and reverb.
    duration: attack + decay + 0.25,
    decayShape: 2.6 - 1.15 * magNorm,
    cutoff,
    q,
    fmRatio,
    fmIndex,
    detuneCents,
    triangleMix,
    reverbSend,
    delaySend,
    sub,
  };
}

/**
 * Event counts per UTC hour, plus normalized levels for the drone bed.
 */
export function hourlyDensity(events) {
  const counts = new Array(24).fill(0);
  for (const event of events) {
    const hour = clamp(Math.floor(finiteOr(event.offset) / 3_600_000), 0, 23);
    counts[hour] += 1;
  }
  const max = Math.max(0, ...counts);
  return {
    counts,
    max,
    total: events.length,
    levels: counts.map((count) => (max > 0 ? count / max : 0)),
  };
}

export function densityAt(hourly, offsetMs) {
  if (!hourly || !hourly.max) return 0;
  const hour = clamp(Math.floor(finiteOr(offsetMs) / 3_600_000), 0, 23);
  return hourly.levels[hour] ?? 0;
}
