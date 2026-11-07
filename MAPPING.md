# The Earth Radio mapping

Earth Radio does not sonify earthquakes literally. It turns one day of
tectonic activity into an ambient piece whose notes, register, stereo position,
and timbre are derived from the real data, then makes that translation stable:
the same day always produces the same mapping.

The goals, in order:

1. **Consonance.** Any combination of events should sound intentional. There is
   one fixed key and scale, and no free pitch.
2. **Determinism.** Each event's sound is a pure function of its USGS ID and its
   data. Replaying a day, scrubbing back, or re-rendering offline must not
   change it.
3. **Space and dynamics.** A quiet day should have air and silence; a large
   aftershock sequence should feel dense without clipping.
4. **Legibility.** The map should explain the music: pan tells you where east
   and west are, register tells you depth, size tells you magnitude.

Every voice is synthesized from oscillators and envelopes. There are no audio
files. The reverb impulse is generated noise, not a sample.

## 1. The key and pitch ladder

The composition is in **D minor pentatonic**: D, F, G, A, C. The 16-note ladder
runs from D3 to D6 (MIDI 50–86):

```
D3  F3  G3  A3  C4  D4  F4  G4  A4  C5  D5  F5  G5  A5  C6  D6
50  53  55  57  60  62  65  67  69  72  74  77  79  81  84  86
```

Pentatonic scales avoid half-steps and tritones, so two events at any two
pitches remain consonant. The fixed key means the drone, delay, and reverb
returns stay in the same harmonic world all day. D is a warm, central key,
and the pentatonic avoids the half-steps that would make a random pair of
quakes sound like a mistake.

Pitch is quantized by depth. There is no continuous pitch bend by depth, which
would produce out-of-key notes and a slippery, siren-like texture.

## 2. The four axes

### Longitude → stereo pan

```
pan = clamp(lon / 180, -1, 1)
```

Longitude −180° maps hard left, 0° maps center, +180° hard right. This is a
`StereoPannerNode` per voice. Panning is not randomized: the geographic left/right
should be readable in headphones. A quake on the mid-Atlantic ridge sits in the
middle; Tonga sits far right, Chile far left.

### Depth → register and darkness

Depth is compressed with a square-root curve, because global seismicity is
strongly biased toward the shallow crust:

```
depthNorm = sqrt(clamp(depthKm, 0, 300) / 300)
pitchIndex = round((1 - depthNorm) * 15)
```

Depth affects both pitch and the amount of lowpass opening. Shallow quakes get
the top of the ladder and a brighter filter; deep quakes get the bottom and a
dark, closed filter.

| Depth | Note | Frequency |
| ---: | :--- | ---: |
| 0 km | D6 | 1174.7 Hz |
| 5 km | A5 | 880.0 Hz |
| 10 km | G5 | 784.0 Hz |
| 30 km | D5 | 587.3 Hz |
| 70 km | A4 | 440.0 Hz |
| 150 km | C4 | 261.6 Hz |
| 300 km+ | D3 | 146.8 Hz |

Depths beyond 300 km clamp at D3. The 300 km reference gives the audible spread
of real seismicity enough room: most events live between 5 and 70 km, and they
occupy the upper half of the register while deep subduction events fall through
the bottom.

### Latitude → timbre

Latitude shifts the filter and the sine/triangle balance. North is airier,
south is smokier:

```
latNorm = (lat + 90) / 180
latitudeBrightness = 0.6 + 0.8 * latNorm       // 0.6 at 90°S, 1.4 at 90°N
triangleMix = clamp(0.08 + 0.30 * latNorm + 0.16 * (1 - magNorm), 0.06, 0.55)
```

| Latitude | Cutoff factor | Triangle mix at M4.5 |
| ---: | ---: | ---: |
| 60°S | 0.73 | 0.22 |
| 30°S | 0.87 | 0.27 |
| 0° | 1.00 | 0.32 |
| 30°N | 1.13 | 0.37 |
| 60°N | 1.27 | 0.42 |

The filter factor also multiplies magnitude openness and shallowness, so
latitude is a timbral offset rather than the only brightness control.

### Magnitude → gain, envelope, openness, sub

```
magNorm = clamp((mag - 2.5) / (7.0 - 2.5), 0, 1)
peakGain = 0.05 + 0.26 * magNorm^1.35
attack   = 0.006 + 0.52 * magNorm^2.2
decay    = 0.42 + 5.0 * magNorm^1.6
```

At a shallow 15 km depth and 30°N, the resulting voice rows are:

| Magnitude | Gain | Attack | Decay | Cutoff | Q | Sub |
| ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 2.5 | 0.050 | 6 ms | 0.42 s | 1529 Hz | 3.90 | no |
| 3.0 | 0.063 | 10 ms | 0.57 s | 1757 Hz | 3.54 | no |
| 4.0 | 0.109 | 52 ms | 1.28 s | 2215 Hz | 2.83 | no |
| 5.0 | 0.168 | 149 ms | 2.37 s | 2673 Hz | 2.12 | no |
| 6.0 | 0.235 | 305 ms | 3.76 s | 3130 Hz | 1.41 | yes |
| 7.0 | 0.310 | 526 ms | 5.42 s | 3588 Hz | 0.70 | yes |

Small quakes are short plucks/bells: fast attack, short exponential-ish tail,
higher resonance (Q). Large quakes are slow swells with a long shaped decay and
a lower-Q, softer filter. The amplitude envelope is a generated curve rather
than a plain exponential, with the curve shape moving from `2.6` for small
events toward `1.45` for large ones, so big tones sustain instead of clicking.

**Filter openness** is:

```
cutoff = clamp(
  420 + 3600 * (1 - depthNorm) * (0.35 + 0.65 * magNorm) * latitudeBrightness,
  300, 5400
)
```

Shallow, large, northern events open widest. A deep, southern event is dark
regardless of magnitude. This is why a M7 at 600 km still sounds low and round
rather than harsh.

**Sub layer.** When `magNorm >= 0.58` (roughly M5.1+), a sine sub is added. Its
root is chosen from D1, A1, or D2 (36.7, 55.0, 73.4 Hz) using the seeded RNG,
and its gain is `peakGain * (0.28 + 0.22 * magNorm)`. A sub is not drawn from
the voice's own pitch: locking it to D/A keeps an M7 from producing an
out-of-key low note. The sub has a slower attack and a 0.7 s longer tail than
the main voice, so a large quake briefly leaves a bass shadow under the texture.

## 3. Timbre and per-event variation

Each voice is:

```
sine carrier + triangle overtone
  → gentle FM (sine modulator into carrier frequency)
  → lowpass filter with envelope
  → amplitude envelope
  → StereoPanner
  → voice gate
      ├→ dry
      ├→ reverb send → generated stereo impulse convolver → return
      └→ delay send → slow feedback delay → return
```

The FM modulator is enveloped separately (it recedes faster than the carrier),
so small events can have a bell-like bloom at the attack while long tones stay
soft. The FM ratio is drawn from:

- below about M4.8: `[2, 2.5, 3, 4]`
- at and above about M4.8: `[1, 1.5, 2]`

The index decreases with magnitude:
`fmIndex = (0.3 + rng * 0.7) * (1.25 - 0.65 * magNorm)`. Large quakes get less
metallic FM; small quakes get more of a struck-bell edge. The sine/triangle mix
from latitude fills in body versus air.

**Seeded randomness.** The seed is `FNV-1a(event.id)`, then a `mulberry32`
stream. The draw order is part of the contract:

1. FM ratio choice
2. FM index variation
3. detune (up to ±5 cents on the two carriers, in opposite directions)
4. delay send
5. sub root (only when the sub threshold is crossed)

That RNG affects texture, never pitch, pan, or the consonant scale. Two
different IDs with identical data can sound slightly different in detune and
FM; the same ID always sounds identical. Reverb/delay sends are deterministic
too (`reverbSend = 0.18 + 0.42 * magNorm + 0.08 * depthNorm`, delay send from
the seeded draw).

## 4. The shared space

- **Convolution reverb.** A 3.5 s stereo impulse is generated from seeded
  decorrelated noise, lowpassed sample-by-sample, and shaped with a `(1-t)^2.4`
  decay. It feeds a 5.2 kHz lowpass return at 0.56 of its bus. This gives long
  tones a believable room tail without any audio files.
- **Feedback delay.** A 0.43 s mono delay with 0.31 feedback and a 1.75 kHz
  lowpass in the loop returns at 0.23. It creates the slow smear between
  isolated events, especially in the quiet hours.
- **Signal path to the speakers:**

```
dry + reverb return + delay return
  → master compressor (threshold -20 dB, knee 16, ratio 6, attack 8 ms)
  → soft-clip wave shaper (linear below 0.7, tanh-style above)
  → master gain 0.68
  → destination
```

The compressor is not a mastering loudness maximizer; it is a safety net for
overlapping 5–7 second tails. The soft clip only engages near the top of the
range.

## 5. Drone bed

The drone is always in D and has five fixed oscillators: D2, a detuned D2, A2,
D3, and D1. It runs through a lowpass with a 0.031 Hz LFO and a 0.069 Hz
tremolo. Its level and brightness follow the **density of events in the current
UTC hour**:

```
density = eventsInHour / busiestHourOfDay
droneGain = 0.028 + 0.070 * density    (when active)
cutoff    = 200 + 850 * density        (plus 70 Hz of LFO)
```

The density is normalized per day, so a quiet day with four events in its
busiest hour still has a moving bed, while the busy day opens up through its
aftershock hours. The drone fades to silence when playback is paused, when the
tab is hidden, and at the end of the day. It is deliberately mixed below the
event voices: silence should never feel empty, but should still feel quiet.

## 6. Dense-day arrangement

The map, Heard log, and complete day index always contain every normalized event.
The performance score is allowed to group events so a busy aftershock sequence
stays legible and does not spend the entire 16-slot voice budget on near-simultaneous
duplicates.

`buildPhrases()` scans a chronologically sorted day and, from each start time,
collects up to four events inside a five-minute window:

- three or four events become a **cluster phrase**;
- one or two remain individual phrases, with the scan advancing to the next
  event so a later dense run can still form a chord;
- the strongest event by magnitude becomes the phrase's **lead**;
- the phrase starts at its earliest member's offset.

When a phrase is triggered, every member keeps its own pitch, stereo pan, and
timbre. The lead controls the shared amplitude envelope, filter, reverb/delay
sends, and optional sub layer, so the strongest quake remains the foreground
signal inside the chord. `AudioEngine.triggerCluster()` reserves **one**
polyphony slot for the whole group while scheduling a carrier and overtone per
member. This is what prevents a dense day from turning into voice-steal churn.

On the 2010-02-27 Chile aftershock day, 365 events became **206 phrases**,
including **68 clusters**. The largest cluster has four members. All 365 events
still appear on the map and in the index.

The grouping is deterministic and greedy. It does not optimize a global chord
progression: the goal is to keep simultaneous events consonant and audible, not
to invent a different composition for the same day. Cluster membership is part
of the reproducible score.

## 7. Polyphony and cue scheduling

- **Cap: 16 voice slots.** A phrase reserves one slot, whether it is an
  individual quake or a three- or four-note cluster. If a new phrase arrives
  while all 16 slots are sounding, the oldest slot is stolen. Stealing fades a
  dedicated, automation-free gain gate over 25 ms and then stops its
  oscillators. The envelope node itself may still be running a value curve, so
  the gate is what makes stealing reliable.
- Each voice is removed from the active count when its final oscillator ends.
- Visual cues are batched per animation frame (up to 24 events), while arrange
  phrases are triggered through the score cursor. A quiet day is sparse; a deep
  aftershock sequence uses chords before it reaches the voice cap.
- The playhead clock is a `requestAnimationFrame` clock. The day is 24 hours of
  composition time in 90 seconds of real time at 1×, so 1 ms of wall-clock
  playback advances 960 ms of the day. The 0.5×/1×/2×/4× speed buttons change only that
  clock; the audio mapping is unaffected. Playing in a background tab is paused
  because rAF and visual cue scheduling cannot continue there.

## 8. Tuning report

### Days used

- **Quiet:** 2026-11-06 UTC — 32 M2.5+ events, largest M6.1, 32 events spread
  over the day; max 3 simultaneous voices in the offline pass.
- **Busy:** 2010-02-27 UTC — Chile M8.8 aftershock day: 365 M2.5+ events, largest
  M8.8, up to 32 events in one UTC hour, one completely empty hour. The current
  arrangement schedules those 365 events as 206 phrases, including 68 clusters;
  the largest chord has four notes.

The busy day is not just “more events”: it has a quiet first six hours followed
by a sustained aftershock field, which is exactly the kind of dynamic shape the
drone density mapping is meant to expose.

### Pre-arrangement baseline (44.1 kHz)

Before the phrase arrangement and retune, both days were rendered through the
real engine into a 92-second stereo `OfflineAudioContext`. This is the baseline
that motivated the group-voice work:

| | Quiet day | Busy day |
| :--- | ---: | ---: |
| Events | 32 | 365 |
| Peak | −5.71 dBFS | −2.39 dBFS |
| RMS | −26.56 dB | −15.60 dB |
| Clipped samples | 0 | 0 |
| Max simultaneous voices | 3 | 16 |
| Voices stolen | 0 | 95 |

The busy day was clearly distinct and never clipped, but its sustained
aftershock section sat at roughly −10 to −15 dB RMS for a minute, with peaks
only 2.4 dB below full scale. That is too hot for an ambient piece on unknown
headphones, and gave the quiet day little room to feel delicate.

### Retune

Changes, all made in the mapping or the shared output stage:

1. **Master headroom:** 0.82 → 0.68 (−1.6 dB).
2. **Voice gain:** `0.055 + 0.30 * magNorm^1.35` → `0.05 + 0.26 * magNorm^1.35`
   (about −0.3 dB at median magnitude, −1.2 dB at M7).
3. **Sub gain:** `0.32 + 0.25 * magNorm` → `0.28 + 0.22 * magNorm` of the voice
   peak, reducing low-end build-up in a swarm.
4. **Compressor:** threshold −16 → −20 dB, knee 14 → 16 dB, ratio 5 → 6,
   attack 6 → 8 ms, release 0.28 → 0.32 s. The dense wash is controlled while
   single quiet plucks below the threshold stay dynamic.
5. **Reverb return:** 0.62 → 0.56 to keep long tails from accumulating into a
   wall in busy hours.
6. **Voice stealing:** routed through a separate gain gate so a stolen voice
   reliably fades instead of relying on a value curve that may still be active.

The shape of the mapping was not changed: pitches, pans, cutoff relationships,
and event determinism are identical. This was a level and headroom tune.

### Final verification (44.1 kHz offline pass)

Both days were rendered again at the production sample rate after the retune and
the dense-day arrangement. An interim 22.05 kHz pass was used only to iterate
faster; the numbers below are the final 44.1 kHz comparison.

| | Quiet day | Busy day |
| :--- | ---: | ---: |
| Events | 32 | 365 |
| Phrases | 32 | 206 |
| Clusters | 0 | 68 |
| Peak | −8.13 dBFS | −5.86 dBFS |
| RMS | −27.47 dB | −19.55 dB |
| Clipped samples | 0 | 0 |
| Max simultaneous voice slots | 3 | 16 |
| Voice slots stolen | 0 | 0 |

The RMS contrast is about 7.9 dB. The busy day's dense aftershock field is
therefore substantially louder than the quiet day without approaching full
scale: at least 5.8 dB of peak headroom remains, and the compressor still moves
rather than flattening everything. No hard clipping occurs in either pass. The
busy day fills all 16 slots at its peak but, because dense groups reserve one
slot per chord, it no longer steals any voices. The quiet day's sparse events
remain peaks against the drone rather than a constant wash, which is the
contrast the piece needs.

A human ear is the final judge of “pleasant”; these measurements verify the
structural targets (consonance, headroom, contrast, deterministic mapping) but
do not replace a listening test on speakers and headphones. The mapping was
kept intentionally soft and low-mid weighted; if you want a brighter mix,
raise the master gain and the reverb return slightly, then re-check the busy day
for headroom.

## 9. Limits and assumptions

- This is an artistic mapping, not a seismological one. Magnitude is not mapped
  to physical rupture energy; depth is not wave propagation; latitude is not a
  regional instrument. No P/S waves, site response, or rupture directivity are
  modeled.
- The app uses the USGS “preferred” origin and magnitude at M2.5 and above. The
  catalogue is revised over time, and cached copies can differ from the current
  live values.
- At most 16 voice slots sound at once. A three- or four-note chord consumes
  one slot but several carriers, so the slot count is not the same as the
  number of simultaneous oscillators. In an extreme swarm some phrases can
  still be stolen; the log and map still record what fired.
- The audio graph is mono-compatible but intended for stereo: pan is an
  important part of the composition.
- The app is not an emergency or scientific tool.

## 10. Post-V1 extension points (not built)

The current code keeps the data, pure mapping, audio graph, map, timeline, and
UI in separate modules so these can be added without restructuring:

1. **Two-date comparison.** Use a second event set and a second engine graph or
   panned layer; `mapEvent` and `hourlyDensity` already accept plain arrays.
2. **Weather layers.** Add a layer module that returns timed cues and a
   continuous bed, then feed it into the same scheduled-cue and drone buses.
   A shared `layer` interface would expose `prepareDay`, `densityAt`, and
   `scheduleCues`.

Neither of these features is implemented in this version. Share hashes and WAV
rendering, previously listed here, are now part of the app.
