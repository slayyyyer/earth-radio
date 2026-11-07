# Earth Radio

**One day of the planet, in sound.**

[Live site](https://slayyyyer.github.io/earth-radio/) · [Source on GitHub](https://github.com/slayyyyer/earth-radio)

Earth Radio turns a single UTC day of real USGS earthquake data into a
90-second ambient composition. Each quake gets a pitch, a stereo position, a
brightness, and an envelope derived from its real coordinates and magnitude. A
dark world map pulses when that sound fires, and every marker, log row, or event
in the complete day index can be inspected, framed, and replayed.

Shareable links restore a day, playhead, or event without autoplaying audio. The
complete day can be rendered locally to a WAV file, and an installable service
worker keeps the interface available offline after the first visit.

Every sound is synthesized in the browser with the Web Audio API. There are no
audio files, samples, API keys, or servers.

- **Stack:** Vite + vanilla JavaScript, Leaflet, Web Audio API
- **Hosting:** static files on GitHub Pages, deployed from `main` by Actions
- **Data:** USGS FDSN event query API, cached per day in `localStorage`
- **Arrangement:** deterministic phrase score; dense 5-minute groups become
  3–4-note chords while every event stays visible on the map and in the index
- **Sound design:** D-minor-pentatonic voices, a density-driven drone, generated
  convolution reverb, feedback delay, a 16-slot voice cap
- **Offline:** installable manifest and service worker (production builds only)

## Run locally

Requires Node.js 20.19+ (or 22.12+). Vite and Leaflet are the only runtime/build
dependencies.

```bash
npm install
npm run dev
```

Open the printed URL (normally `http://localhost:5173`). To check the production
build locally:

```bash
npm run build
npm run preview
```

Run the dependency-free unit tests with:

```bash
npm test
```

There is no environment file and no API key. The basemap uses Esri's public Dark
Gray Canvas raster tiles, with keyless OpenStreetMap as the fallback. The
typefaces are self-hosted WOFF2 files, not Google Fonts requests. The app needs
network access for the USGS query and map tiles; previously visited days keep
working from the local cache, and the production app shell is cached by the
service worker.

## What is here

### First minute

- **How to listen** opens a compact field guide for time, longitude, depth, and
  magnitude.
- A **now sounding** strip names the quake or chord as it fires.
- **Next quake** and **Strongest** jump to the next event or the day's peak while
  keeping the map and list in sync.
- The audio status explains the extra tap browsers require before Web Audio can
  start. The map, timeline, and index remain fully usable without sound.

### Listening controls

- Start listening opens the audio context on a user gesture and fades the first
  sound in.
- Volume and mute are available during playback and persist in `localStorage`.
  The default volume is 80%.
- Clicking any marker or list row pauses the timeline, frames the quake, and
  auditions it with the focused reverb treatment.
- Pause fades the drone out; the end of the day gets a longer outro fade.

### Date navigation and sharing

- **← / →** step one UTC day; **Today** returns to the current, still-in-progress
  UTC day; **Refresh** forces a fresh network request.
- Today always attempts the live feed first, retaining the cached copy as an
  offline fallback. Other days load from cache when available.
- **Copy link** copies a hash URL for the current day and playhead. The event
  card can copy an event-specific link.
- A hash can contain `date`, `t` (seconds from UTC midnight), and `event`:

  ```text
  #date=2026-11-06&t=53280&event=us7000abcd
  ```

  Event links always frame that event and do not autoplay. A mismatched `t` is
  ignored once the event is resolved.

### Accessible day index

The side panel has two views:

- **Heard** is the chronological log of events that have sounded, capped at 60.
- **All quakes** is the complete day index. It can be filtered by minimum
  magnitude and by a six-hour UTC window.

Every row is a native button with a descriptive accessible name. Selecting a row
frames and replays the quake, opens its detail card, and returns focus to the row
when the card closes. The index remains scrollable and keyboard-operable when it
contains hundreds of events.

### Dense days

The playback score is built from the normalized event list, not from the map or
visual cue stream. In a five-minute window:

- three or four quakes become one chord-like phrase;
- the strongest member is the foreground lead;
- every member keeps its own pitch, pan, timbre, and seeded variation;
- the chord consumes one polyphony slot, avoiding a wall of voice steals.

All events still appear on the map, in the Heard log, and in the full index. On
the 2010-02-27 Chile aftershock day, 365 events became 206 phrases, including 68
chords of three or four notes.

### WAV export and PWA

- **WAV** renders the day through the same audio graph in an
  `OfflineAudioContext` and downloads a 16-bit stereo WAV. The render includes a
  short tail after the 90-second composition and is done entirely locally.
- Production builds register `sw.js`, cache the app shell, and expose
  `manifest.webmanifest` with 192px and 512px icons. USGS calls and third-party
  map tiles are deliberately not intercepted; day data has its own cache, and a
  stale basemap is worse than the visible fallback state.

## Keyboard controls

- **Space** — play/pause when focus is not inside a form control or button
- **← / →** on the timeline — seek 15 minutes; **Shift** makes it one hour
- **Home / End** — jump to 00:00 / 24:00
- **Escape** — close the event detail card
- Every control, filter, index row, and link is reachable by Tab and Enter.

## Sound and determinism

Longitude sets stereo pan. Depth sets a quantized pitch in D minor pentatonic
(shallow high, deep low). Magnitude sets gain and envelope length plus filter
openness, and latitude opens or closes the timbre. Larger quakes also receive a
key-locked sub layer. All per-event variation is seeded by the USGS event ID, so
revisiting a day produces the same notes and envelopes.

The full formulas, voice architecture, cluster rules, polyphony, tuning
measurements, and limits are in [MAPPING.md](MAPPING.md).

## Data handling

`src/data.js` requests:

```text
https://earthquake.usgs.gov/fdsnws/event/1/query
  ?format=geojson
  &starttime=YYYY-MM-DD
  &endtime=YYYY-MM-DD(next day)
  &minmagnitude=2.5
  &orderby=time-asc
```

The API treats a date-only `endtime` as midnight at the start of that date, so
the app requests the next UTC date explicitly and filters events to the
24-hour window locally. Non-earthquake event types are discarded. Features are
normalized to a compact shape:

```js
{ id, time, mag, place, url, lon, lat, depthKm, offset }
```

Successful days are cached in `localStorage` under
`earth-radio.cache.v1.<date>`, with a small index that keeps the ten most recent
days. A fetch failure returns the cached copy if one exists; a cache miss
produces a friendly error and a retry button. An empty FeatureCollection is a
valid, cacheable result.

There is no backend and no analytics. The only data stored locally is the
earthquake cache, audio preferences, and the service-worker app shell. Network
requests go to USGS, Esri, and OpenStreetMap.

## Reliability

- Esri Dark Gray Canvas is the primary basemap. After three primary tile errors,
  the app switches to keyless OpenStreetMap with a dark tile treatment and shows
  a **Basemap fallback** chip.
- After four fallback tile errors, the map reports that tiles are unavailable
  while markers, the timeline, and details continue to work.
- Failed USGS requests preserve a cached day when possible and otherwise show a
  retry action.
- The map, timeline, and index are independent of Web Audio, so they still work
  if audio cannot start.

## Architecture

```text
index.html
src/
  main.js        orchestration, clock, date loading, sharing, export, PWA setup
  data.js        USGS fetch, normalization, localStorage cache, date helpers
  mapping.js     pure event -> sound parameters, seeded RNG, density
  arrangement.js deterministic phrase and chord builder
  audio.js       Web Audio graph, voices, drone, reverb, delay, limiter
  map.js         Leaflet dark map, fallback tiles, markers, pulses
  timeline.js    canvas density histogram and accessible scrubber
  ui.js          all DOM controls, detail card, log, index, preferences
  share.js       hash parsing and canonical share URLs
  wav.js         16-bit PCM WAV encoder
  styles.css     candy-cyberpunk layout and motion
  fonts.css      self-hosted font faces
public/
  manifest.webmanifest, sw.js, icons, og.png, fonts licenses
test/            Node test runner suites for pure modules
```

Data flows one way: `loadDay()` → normalized events → map markers, histogram,
and hourly density. `buildPhrases()` deterministically folds dense groups into
the performance score. During playback, a requestAnimationFrame clock advances
the playhead and fires both visual cues and audio phrases. The same score feeds
the now-sounding strip, log, and WAV renderer.

## Deployment to GitHub Pages

The live site is deployed from this repository at
<https://slayyyyer.github.io/earth-radio/>. The workflow at
`.github/workflows/deploy.yml` runs on every push to `main`, installs with
`npm ci`, runs `npm test`, builds with `npm run build`, and publishes `dist/`.

To set up a fork:

1. Push the project to a GitHub repository with `main` as the default branch.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Push to `main`, or run the workflow manually.

`vite.config.js` uses `base: './'`, so the same build works at
`https://<user>.github.io/<repo>/` and at a custom domain. There are no
server-side routes. The service worker registration is relative to the deployed
page and its scope is the app directory.

To publish manually, run `npm run build` and serve/upload `dist/` with any
static host. Do not upload `node_modules` or the source tree.

## Verification notes

The 21 unit tests cover the phrase/cluster determinism, share-hash parsing and
round trips, WAV headers and PCM encoding, date helpers, USGS query construction,
and event normalization.

The app was exercised in a browser against live and cached USGS days:

- the 2026-11-06 quiet day (32 events) loaded with live fonts and no horizontal
  overflow at 390px;
- a deep link restored the correct event on initial load, focused its close
  button, retained the canonical event hash, and left audio off;
- the full index rendered 365 events and the M5+/06–12 filter narrowed it to 68;
- the 2010-02-27 dense day produced 68 three- or four-note clusters, and a
  chord fired through the running audio engine;
- a 92-second offline render produced stereo audio at 44.1 kHz with no clipped
  samples; the dense-day pass peaked at −5.86 dBFS with zero voices stolen;
- the production service worker activated, controlled the page, cached the app
  shell, and served a valid manifest with both icons;
- the Esri-to-OpenStreetMap fallback was observed in both dev and production.

The automated browser tab reports `document.hidden`, which makes Chromium
suspend `requestAnimationFrame`. The playback tick and cue path were therefore
driven through the development clock API against the running audio engine; a
visible-browser listening pass with headphones is still recommended for final
mix judgments. A browser-level audio check is not a substitute for human
listening.

## Accessibility and motion

- The timeline is a keyboard-operable ARIA slider with a text value.
- Buttons have labels; the detail card announces updates and restores focus to
  the originating log or index row.
- Log and index rows are native buttons with descriptive names.
- The volume slider has a visible value and an ARIA value text.
- `prefers-reduced-motion` removes decorative loops and shortens pulse rings.
- The interface remains usable without sound.

Map markers are canvas-based for density, so individual markers are not
focusable. Every event is available as a keyboard-accessible row in the full day
index.

## Credits

Earthquake data: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/).

Basemap: [Esri World Dark Gray Canvas](https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer),
using data from Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user
community. Fallback tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright).

Map library: [Leaflet](https://leafletjs.com/).

Typefaces: [Unbounded](https://fonts.google.com/specimen/Unbounded) and
[Space Mono](https://fonts.google.com/specimen/Space+Mono), self-hosted under the
SIL Open Font License. License texts are in `public/fonts/`.

This is an artistic instrument, not a seismological simulation or an emergency
service. In an emergency, follow local authorities.
