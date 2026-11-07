/**
 * Earth Radio's Web Audio engine.
 *
 * Signal flow:
 *
 *   voices ─┬─ dry ───────────────┐
 *           ├─ reverb send ─ convolver ─ tone ─┐
 *           └─ delay send ─ delay ─ tone ─┬────┤
 *                                          └ fb │
 *   drone bed ───────────────────────────────────┤
 *                                                ▼
 *                                       compressor → soft clip → master
 *
 * All sound is synthesized: oscillators, filtered noise used only inside the
 * generated reverb impulse, and envelopes. No samples, no audio files.
 */

import { MAX_VOICES, mulberry32, clamp } from './mapping.js';

const VOICE_STAGGER = 0.03;

function makeSoftClipCurve(samples = 2048) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / (samples - 1) - 1;
    if (Math.abs(x) <= 0.7) {
      curve[i] = x;
    } else {
      const sign = Math.sign(x);
      curve[i] = sign * (0.7 + 0.3 * Math.tanh((Math.abs(x) - 0.7) / 0.3));
    }
  }
  return curve;
}

/**
 * A generated stereo impulse: decorrelated, gently lowpassed noise with an
 * exponential-ish decay. This is the only place noise appears; it is baked
 * into the reverb, not played back as a sample.
 */
function makeImpulseResponse(ctx, seconds = 3.4, decay = 2.5) {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const random = mulberry32(0x51ee7a11);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let smoothed = 0;
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      const white = random() * 2 - 1;
      smoothed = smoothed * 0.62 + white * 0.38;
      const envelope = (1 - t) ** decay;
      data[i] = smoothed * envelope * (channel === 0 ? 1 : 0.94);
    }
  }

  return buffer;
}

function rampFilter(filter, cutoff, time, target) {
  filter.frequency.setTargetAtTime(target, time, 0.3);
  return cutoff;
}

export class AudioEngine {
  constructor(context = null) {
    if (context) {
      this.ctx = context;
      this.ownsContext = false;
    } else {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('This browser does not support the Web Audio API.');
      }
      this.ctx = new AudioContextClass({ latencyHint: 'playback' });
      this.ownsContext = true;
    }

    this.destination = this.ctx.destination;
    this.voices = [];
    this.voiceLimit = MAX_VOICES;
    this.active = false;
    this.density = 0.12;
    this.started = false;
    this.volume = 1;
    this.muted = false;
    this.stats = { triggered: 0, stolen: 0, maxVoices: 0, clusters: 0 };

    this._buildGraph();
    this._buildDrone();
  }

  async start() {
    const firstStart = !this.started;

    if (
      this.ctx.state === 'suspended' &&
      typeof this.ctx.resume === 'function'
    ) {
      await this.ctx.resume();
    }
    this.started = true;

    // A short opening swell makes the instrument feel intentional rather than
    // starting on a hard transient. The user volume is applied afterwards so
    // the fade never ignores a saved level.
    if (firstStart) {
      const now = this.ctx.currentTime;
      const target = this._outputTarget();
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(0.0001, now);
      if (target > 0.0001) {
        this.output.gain.exponentialRampToValueAtTime(target, now + 1.35);
      }
    }
  }

  _outputTarget() {
    return this.muted ? 0.0001 : Math.max(0.0001, this.volume);
  }

  setVolume(value, { immediate = false } = {}) {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    this.volume = clamp(next, 0, 1);
    if (!this.output) return;

    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    if (immediate) {
      this.output.gain.setValueAtTime(this._outputTarget(), now);
    } else {
      this.output.gain.setTargetAtTime(this._outputTarget(), now, 0.035);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.setVolume(this.volume);
  }

  _buildGraph() {
    const ctx = this.ctx;

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.compressor = ctx.createDynamicsCompressor();
    // Tuned against a 32-event day and a 365-event aftershock swarm: enough
    // control for dense overlaps, with the quiet day still fully dynamic.
    this.compressor.threshold.value = -20;
    this.compressor.knee.value = 16;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.008;
    this.compressor.release.value = 0.32;

    this.clipper = ctx.createWaveShaper();
    this.clipper.curve = makeSoftClipCurve();
    this.clipper.oversample = '2x';

    this.master = ctx.createGain();
    this.master.gain.value = 0.68;

    // The calibrated mix stays fixed; this final stage is the listener's
    // volume / mute, so tuning measurements remain comparable.
    this.output = ctx.createGain();
    this.output.gain.value = 1;

    this.input.connect(this.compressor);
    this.compressor.connect(this.clipper);
    this.clipper.connect(this.master);
    this.master.connect(this.output);
    this.output.connect(this.destination);

    // Shared generated-impulse reverb ---------------------------------
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulseResponse(ctx, 3.5, 2.4);
    this.reverbTone = ctx.createBiquadFilter();
    this.reverbTone.type = 'lowpass';
    this.reverbTone.frequency.value = 5200;
    this.reverbTone.Q.value = 0.4;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.56;

    this.reverb.connect(this.reverbTone);
    this.reverbTone.connect(this.reverbReturn);
    this.reverbReturn.connect(this.input);

    // Slow feedback delay ----------------------------------------------
    this.delay = ctx.createDelay(1.2);
    this.delay.delayTime.value = 0.43;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 1750;
    this.delayTone.Q.value = 0.5;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.31;
    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = 0.23;

    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delayTone.connect(this.delayReturn);
    this.delayReturn.connect(this.input);
  }

  _buildDrone() {
    const ctx = this.ctx;

    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0001;

    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 260;
    this.droneFilter.Q.value = 0.65;

    this.droneTremolo = ctx.createGain();
    this.droneTremolo.gain.value = 0.8;

    this.droneGain.connect(this.droneFilter);
    this.droneFilter.connect(this.droneTremolo);
    this.droneTremolo.connect(this.input);

    const droneSend = ctx.createGain();
    droneSend.gain.value = 0.38;
    this.droneTremolo.connect(droneSend);
    droneSend.connect(this.reverb);

    this.droneOscillators = [];

    const voices = [
      { frequency: 73.42, type: 'sine', gain: 0.5, detune: -4 },
      { frequency: 73.42, type: 'sine', gain: 0.17, detune: 5 },
      { frequency: 110.0, type: 'sine', gain: 0.3, detune: 3 },
      { frequency: 146.83, type: 'triangle', gain: 0.12, detune: -6 },
      { frequency: 36.71, type: 'sine', gain: 0.18, detune: 0 },
    ];

    for (const voice of voices) {
      const oscillator = ctx.createOscillator();
      oscillator.type = voice.type;
      oscillator.frequency.value = voice.frequency;
      oscillator.detune.value = voice.detune;

      const gain = ctx.createGain();
      gain.gain.value = voice.gain;

      oscillator.connect(gain);
      gain.connect(this.droneGain);
      oscillator.start();
      this.droneOscillators.push(oscillator);
    }

    // Very slow filter breathing. Density shifts the centre; the LFO gives
    // the bed a pulse that is longer than the composition itself.
    const filterLfo = ctx.createOscillator();
    filterLfo.frequency.value = 0.031;
    const filterDepth = ctx.createGain();
    filterDepth.gain.value = 70;
    filterLfo.connect(filterDepth);
    filterDepth.connect(this.droneFilter.frequency);
    filterLfo.start();
    this.droneOscillators.push(filterLfo);

    const tremoloLfo = ctx.createOscillator();
    tremoloLfo.frequency.value = 0.069;
    const tremoloDepth = ctx.createGain();
    tremoloDepth.gain.value = 0.09;
    tremoloLfo.connect(tremoloDepth);
    tremoloDepth.connect(this.droneTremolo.gain);
    tremoloLfo.start();
    this.droneOscillators.push(tremoloLfo);
  }

  _droneLevel() {
    return 0.028 + 0.07 * clamp(this.density, 0, 1);
  }

  setActive(active, when = this.ctx.currentTime, fadeSeconds = null) {
    this.active = Boolean(active);
    const time = Math.max(when, this.ctx.currentTime);
    const target = this.active ? this._droneLevel() : 0.0001;
    const fade = Number.isFinite(fadeSeconds)
      ? Math.max(0.1, fadeSeconds)
      : 0.55;
    this.droneGain.gain.cancelScheduledValues(time);
    this.droneGain.gain.setTargetAtTime(
      target,
      time,
      this.active ? 1.1 : fade,
    );

    if (this.active) {
      const cutoff = 200 + 850 * clamp(this.density, 0, 1);
      this.droneFilter.frequency.setTargetAtTime(cutoff, time, 1.5);
    }
  }

  /**
   * Point the drone at the density of the current UTC hour (0..1). Called
   * only when the hour changes so the automation actually has room to glide.
   */
  setDensity(level, when = this.ctx.currentTime) {
    this.density = clamp(Number(level) || 0, 0, 1);
    if (!this.active) return;
    const time = Math.max(when, this.ctx.currentTime);
    this.droneGain.gain.setTargetAtTime(this._droneLevel(), time, 1.6);
    rampFilter(
      this.droneFilter,
      this.density,
      time,
      200 + 850 * this.density,
    );
  }

  _pruneVoices(when) {
    this.voices = this.voices.filter((voice) => voice.end > when);
  }

  _stealVoice(voice, when) {
    // The envelope node may still be running a value curve, so the gate is a
    // separate, automation-free gain we can always fade.
    try {
      voice.gate.gain.setTargetAtTime(0.0001, when, 0.025);
    } catch {
      // A param that has already ended is safe to ignore.
    }
    for (const oscillator of voice.oscillators) {
      try {
        oscillator.stop(when + 0.16);
      } catch {
        // Already stopped.
      }
    }
    voice.end = when + 0.2;
    this.stats.stolen += 1;
  }

  _reserveVoice(when) {
    this._pruneVoices(when);

    if (this.voices.length < this.voiceLimit) return;

    const candidates = this.voices.filter((voice) => voice.start <= when);
    const victim = (candidates.length ? candidates : this.voices).reduce(
      (oldest, voice) => (voice.start < oldest.start ? voice : oldest),
    );
    this._stealVoice(victim, when);
    this.voices = this.voices.filter((voice) => voice !== victim);
  }

  /**
   * Schedule one mapped quake.
   * @param {ReturnType<import('./mapping.js').mapEvent>} params
   * @param {number} when AudioContext time
   */
  trigger(params, when = this.ctx.currentTime, { focus = false } = {}) {
    const ctx = this.ctx;
    const start = Math.max(when, ctx.currentTime);
    const peak = Math.max(0.0002, params.gain);
    const attack = Math.max(0.001, params.attack);
    const decay = Math.max(0.08, params.decay);
    const end = start + attack + decay + 0.08;
    const subEnd = params.sub
      ? start + params.sub.decay + attack + 0.12
      : end;
    const stopAt = Math.max(end, subEnd);

    this._reserveVoice(start);

    // Per-voice output bus ------------------------------------------------
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(params.pan, -1, 1);

    const amplitude = ctx.createGain();
    amplitude.gain.setValueAtTime(0.0001, start);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = params.q;
    const openAt = start + attack + 0.03;
    filter.frequency.setValueAtTime(
      Math.min(6000, params.cutoff * 0.55),
      start,
    );
    filter.frequency.linearRampToValueAtTime(params.cutoff, openAt);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(220, params.cutoff * 0.36),
      start + attack + decay * 0.9,
    );

    filter.connect(amplitude);
    amplitude.connect(panner);

    const gate = ctx.createGain();
    gate.gain.value = 1;
    panner.connect(gate);
    gate.connect(this.input);

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = clamp(
      params.reverbSend * (focus ? 1.35 : 1),
      0.1,
      0.86,
    );
    gate.connect(reverbSend);
    reverbSend.connect(this.reverb);

    const delaySend = ctx.createGain();
    delaySend.gain.value = clamp(params.delaySend * (focus ? 1.2 : 1), 0.04, 0.42);
    gate.connect(delaySend);
    delaySend.connect(this.delay);

    // Carriers: sine body + triangle overtone ----------------------------
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = params.frequency;
    carrier.detune.value = params.detuneCents;
    carrier.connect(filter);

    const overtone = ctx.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.value = params.frequency;
    overtone.detune.value = -params.detuneCents;
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.value = params.triangleMix;
    overtone.connect(overtoneGain);
    overtoneGain.connect(filter);

    // Gentle FM, enveloped so the bell-like edge blooms and softens.
    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = params.frequency * params.fmRatio;
    const modDepth = ctx.createGain();
    const fmHz = Math.max(0.001, params.frequency * params.fmIndex);
    modDepth.gain.setValueAtTime(fmHz, start);
    modDepth.gain.exponentialRampToValueAtTime(
      Math.max(0.001, fmHz * 0.025),
      start + attack + decay * 0.55,
    );
    modulator.connect(modDepth);
    modDepth.connect(carrier.frequency);

    // Main amplitude envelope (attack, then a shaped decay curve).
    amplitude.gain.linearRampToValueAtTime(peak, start + attack);
    const curveLength = 64;
    const curve = new Float32Array(curveLength);
    for (let i = 0; i < curveLength; i += 1) {
      const t = i / (curveLength - 1);
      curve[i] = Math.max(
        0.0001,
        peak * (1 - t) ** Math.max(1.25, params.decayShape),
      );
    }
    // Start the curve a hair after the attack ramp so the two automation
    // events do not touch at the same timestamp in strict implementations.
    amplitude.gain.setValueCurveAtTime(curve, start + attack + 0.002, decay);

    const oscillators = [carrier, overtone, modulator];

    // Optional sub layer for larger quakes --------------------------------
    if (params.sub) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = params.sub.frequency;

      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.0001, start);
      subGain.gain.linearRampToValueAtTime(
        Math.max(0.001, params.sub.gain),
        start + attack + 0.22,
      );
      subGain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + attack + params.sub.decay,
      );

      const subFilter = ctx.createBiquadFilter();
      subFilter.type = 'lowpass';
      subFilter.frequency.value = 240;
      subFilter.Q.value = 0.4;

      sub.connect(subFilter);
      subFilter.connect(subGain);
      subGain.connect(panner);
      oscillators.push(sub);
    }

    for (const oscillator of oscillators) {
      oscillator.start(start);
      oscillator.stop(stopAt);
    }

    // Tidy up the per-voice bus after the final tail has finished.
    const cleanupOscillator = params.sub ? oscillators[oscillators.length - 1] : carrier;
    cleanupOscillator.onended = () => {
      try {
        panner.disconnect();
        gate.disconnect();
        reverbSend.disconnect();
        delaySend.disconnect();
      } catch {
        // Already disconnected.
      }
    };

    const voice = {
      start,
      end: stopAt + 0.05,
      gate,
      oscillators,
    };
    this.voices.push(voice);
    this.stats.triggered += 1;
    this.stats.maxVoices = Math.max(this.stats.maxVoices, this.voices.length);
  }

  /**
   * Schedule a dense cluster as one voice with several pitched carriers. The
   * cluster reserves one polyphony slot, keeps the strongest note foreground,
   * and gives every note its own stereo position. This is what keeps busy days
   * from collapsing into voice stealing.
   */
  triggerCluster(paramsList, when = this.ctx.currentTime) {
    const notes = (paramsList || []).filter(Boolean).slice(0, 4);
    if (!notes.length) return;
    if (notes.length === 1) {
      this.trigger(notes[0], when);
      return;
    }

    const ctx = this.ctx;
    const start = Math.max(when, ctx.currentTime);
    const lead = notes.reduce(
      (strongest, note) =>
        note.magNorm > strongest.magNorm ? note : strongest,
      notes[0],
    );
    const attack = Math.max(0.025, lead.attack + 0.04);
    const decay = Math.max(...notes.map((note) => note.decay)) * 1.05 + 0.12;
    const peak = lead.gain * 1.04;
    const end = start + attack + decay + 0.1;
    const subEnd = lead.sub
      ? start + attack + lead.sub.decay + 0.15
      : end;
    const stopAt = Math.max(end, subEnd);

    this._reserveVoice(start);

    const gate = ctx.createGain();
    gate.gain.value = 1;
    gate.connect(this.input);

    const amplitude = ctx.createGain();
    amplitude.gain.setValueAtTime(0.0001, start);
    amplitude.gain.linearRampToValueAtTime(peak, start + attack);
    const curveLength = 64;
    const curve = new Float32Array(curveLength);
    for (let i = 0; i < curveLength; i += 1) {
      const t = i / (curveLength - 1);
      curve[i] = Math.max(
        0.0001,
        peak * (1 - t) ** Math.max(1.25, lead.decayShape),
      );
    }
    amplitude.gain.setValueCurveAtTime(curve, start + attack + 0.002, decay);
    amplitude.connect(gate);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = lead.q;
    const openAt = start + attack + 0.03;
    filter.frequency.setValueAtTime(
      Math.min(6000, lead.cutoff * 0.55),
      start,
    );
    filter.frequency.linearRampToValueAtTime(lead.cutoff, openAt);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(220, lead.cutoff * 0.36),
      start + attack + decay * 0.9,
    );
    filter.connect(amplitude);

    const weights = notes.map((_, index) => (index === 0 ? 1.35 : 0.55));
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    const oscillators = [];

    notes.forEach((note, index) => {
      const noteBus = ctx.createGain();
      noteBus.gain.value = weights[index] / weightTotal;
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(note.pan, -1, 1);

      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = note.frequency;
      carrier.detune.value = note.detuneCents;
      carrier.connect(noteBus);

      const overtone = ctx.createOscillator();
      overtone.type = 'triangle';
      overtone.frequency.value = note.frequency;
      overtone.detune.value = -note.detuneCents;
      const overtoneGain = ctx.createGain();
      overtoneGain.gain.value = note.triangleMix;
      overtone.connect(overtoneGain);
      overtoneGain.connect(noteBus);

      noteBus.connect(panner);
      panner.connect(filter);
      oscillators.push(carrier, overtone);
    });

    if (lead.sub) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = lead.sub.frequency;
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.0001, start);
      subGain.gain.linearRampToValueAtTime(
        Math.max(0.001, lead.sub.gain),
        start + attack + 0.22,
      );
      subGain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + attack + lead.sub.decay,
      );
      const subFilter = ctx.createBiquadFilter();
      subFilter.type = 'lowpass';
      subFilter.frequency.value = 240;
      subFilter.Q.value = 0.4;
      const subPanner = ctx.createStereoPanner();
      subPanner.pan.value = clamp(lead.pan, -1, 1);
      sub.connect(subFilter);
      subFilter.connect(subGain);
      subGain.connect(subPanner);
      subPanner.connect(gate);
      oscillators.push(sub);
    }

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = clamp(lead.reverbSend * 1.12, 0.1, 0.8);
    gate.connect(reverbSend);
    reverbSend.connect(this.reverb);

    const delaySend = ctx.createGain();
    delaySend.gain.value = clamp(lead.delaySend * 1.1, 0.04, 0.4);
    gate.connect(delaySend);
    delaySend.connect(this.delay);

    for (const oscillator of oscillators) {
      oscillator.start(start);
      oscillator.stop(stopAt);
    }

    const cleanupOscillator = oscillators[oscillators.length - 1];
    cleanupOscillator.onended = () => {
      try {
        gate.disconnect();
        reverbSend.disconnect();
        delaySend.disconnect();
      } catch {
        // Already disconnected.
      }
    };

    this.voices.push({
      start,
      end: stopAt + 0.05,
      gate,
      oscillators,
    });
    this.stats.triggered += notes.length;
    this.stats.clusters += 1;
    this.stats.maxVoices = Math.max(this.stats.maxVoices, this.voices.length);
  }

  triggerPhrase(paramsList, when = this.ctx.currentTime, options = {}) {
    const notes = (paramsList || []).filter(Boolean);
    if (!notes.length) return;
    if (notes.length === 1) {
      this.trigger(notes[0], when, options);
      return;
    }
    this.triggerCluster(notes, when);
  }

  /** Convenience for a batch of simultaneous events. */
  triggerBatch(paramsList, when = this.ctx.currentTime) {
    paramsList.forEach((params, index) => {
      this.trigger(params, when + index * VOICE_STAGGER);
    });
  }

  async dispose() {
    for (const oscillator of this.droneOscillators) {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
    }
    if (this.ownsContext) {
      try {
        await this.ctx.close();
      } catch {
        // The context may already be closed.
      }
    }
  }
}
