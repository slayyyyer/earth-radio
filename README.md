# Earth Radio

**One day of the planet, in sound.**

Earth Radio turns a single UTC day of real USGS earthquake data into a
90-second ambient composition. Each quake gets a pitch, a stereo position, a
brightness, and an envelope derived from its real coordinates and magnitude.
A dark world map pulses when that sound fires, and every marker or log entry can
be inspected and replayed.

Every sound is synthesized in the browser with the Web Audio API. There are no
audio files, samples, API keys, or servers.

- **Stack:** Vite + vanilla JavaScript, Leaflet, Web Audio API
- **Hosting:** static files, ready for GitHub Pages
- **Data:** USGS FDSN event query API, cached per day in `localStorage`
- **Sound design:** deterministic D-minor-pentatonic voices, a density-driven
  drone, generated convolution reverb, feedback delay, 16-voice cap

## Run locally

Requires Node.js 20.19+ (or 22.12+). Vite 7 is the only build dependency.

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

There is no environment file and no API key. The basemap uses Esri's public
Dark Gray Canvas raster tiles, which also require no map key. The app needs
network access for the USGS query, Esri/OpenStreetMap map tiles, and Google
Fonts. Previously
visited days keep working from the local cache even if USGS is unreachable; the
basemap tiles and web fonts are third-party requests and will not be cached by
the app.

## How to use it

1. Pick a **UTC day**. The default is yesterday. Future dates are blocked.
2. Press **Start listening**. Browsers require this gesture before Web Audio can
   start. Headphones are recommended for the stereo field and low sub layer.
3. Press play/pause, choose 0.5×, 1×, 2×, or 4× speed, or drag the histogram to
   seek. At 1× the full 24 hours take 90 seconds.
4. Click a pulsing marker or a row in the event log to open its place,
   magnitude, depth, UTC time, coordinates, and a link to the USGS event page.
   That action also replays the event's sound.

Keyboard controls:

- **Space** — play/pause when the page (not a form control) has focus
- **← / →** on the timeline — seek 15 minutes; **Shift** makes it one hour
- **Home / End** — jump to 00:00 / 24:00
- **Escape** — close the event detail card

The log lists events as they are heard. It is capped at 60 entries and is
cleared when you change days.

The HUD reports whether the current day came from the live feed or from the
local cache. If a refresh fails and a cached copy exists, the app falls back to
it and labels it **Offline cache**. Empty days get a quiet message and still
allow the drone bed to play.

## Sound and determinism

The short version: longitude sets stereo pan, depth sets a quantized pitch in D
minor pentatonic (shallow high, deep low), magnitude sets gain and envelope
length plus filter openness, and latitude opens or closes the timbre. Larger
quakes also receive a key-locked sub layer. All per-event variation is seeded by
the USGS event ID, so revisiting a day produces the same notes and envelopes.

The long version, including formulas, tables, voice architecture, polyphony,
master limiting, and tuning measurements, is in [MAPPING.md](MAPPING.md).

## Data handling

`src/data.js` requests:

```
https://earthquake.usgs.gov/fdsnws/event/1/query
  ?format=geojson
  &starttime=YYYY-MM-DD
  &endtime=YYYY-MM-DD(next day)
  &minmagnitude=2.5
  &orderby=time-asc
```

The API treats a date-only `endtime` as midnight at the *start* of that date,
so the app requests the next UTC date explicitly and filters events to the
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

There is no backend and no analytics. The only data stored is the earthquake
cache in your browser; the only network requests are USGS, map tiles, and fonts.

## Architecture

```
index.html
src/
  main.js       orchestration, timeline clock, date loading, playback
  data.js       USGS fetch, normalization, localStorage cache, date helpers
  mapping.js    pure event -> sound parameters, seeded RNG, hourly density
  audio.js      Web Audio graph, voices, drone, reverb, delay, limiter
  map.js        Leaflet dark map, markers, tooltips, pulse rings
  timeline.js   canvas density histogram and accessible scrubber
  ui.js         date picker, transport, audio status, detail card, log
  styles.css    candy-cyberpunk layout and motion
```

Data flows one way: `loadDay()` → normalized events → map markers, histogram,
and hourly density. During playback, a requestAnimationFrame clock advances the
playhead and queues the events it crosses through `mapping.js` into the audio
engine. The map pulses and event log are fed from the same cue batch.

The modules are deliberately isolated for the post-V1 ideas:

- **Compare two days:** load a second event set, mirror the map layer, and give
  the second engine graph a different pan or layer. `hourlyDensity` and
  `mapEvent` are already pure and can be called per day.
- **Export a day / share a URL:** `AudioEngine` accepts any `AudioContext`,
  including `OfflineAudioContext`. The dev-only analysis helper in `main.js`
  already renders a full day through the real graph; a production WAV renderer
  can reuse that path. Dates are strings in one place, ready for a URL hash.
- **Weather layers:** add a layer module that produces timed cues and a
  continuous bed, then schedule it alongside the earthquake layer. The audio
  engine's sends, master bus, drone, and voice cap can be shared.

## Deploy to GitHub Pages

A workflow is included at `.github/workflows/deploy.yml`.

1. Push the project to a GitHub repository with `main` as the default branch.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Push to `main`, or run the workflow manually. It installs with `npm ci`,
   builds with `npm run build`, and publishes `dist/`.

`vite.config.js` uses `base: './'`, so the same build works at
`https://<user>.github.io/<repo>/` and at a custom domain. There are no
server-side routes.

To publish manually instead, run `npm run build` and serve/upload `dist/` with
any static host. Do not upload `node_modules` or the source tree.

## Verification notes

The app was run in a browser against real USGS data. The busy-day and quiet-day
sound checks were rendered through the production engine with
`OfflineAudioContext`; see the tuning section of [MAPPING.md](MAPPING.md) for
the measured peaks, RMS levels, voice counts, and what changed. The UI was
verified at desktop and 390 px mobile widths for the stacked layout and
horizontal overflow, and the cache, stale-cache fallback, empty-day, error,
visibility-pause, end-of-day, and replay paths were exercised.

A browser-level audio check is not a substitute for human listening: use
headphones and adjust the day/speed to taste.

## Accessibility and motion

- The timeline is a keyboard-operable ARIA slider with a text value.
- Buttons have labels; the detail card announces updates.
- Log rows are buttons with descriptive accessible names.
- `prefers-reduced-motion` removes decorative loops and shortens pulse rings.
- The interface remains usable without sound; the map, log, and details still
  work if Web Audio is unavailable.

The map markers are canvas-based for density, so individual markers are not
focusable. Events you have heard are available as keyboard-accessible rows in
the event log, which also replays their sound.

## Credits

Earthquake data: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/).
Basemap: [Esri World Dark Gray Canvas](https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer)
using data from Esri, HERE, Garmin,
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, and the
GIS user community.
Map library: [Leaflet](https://leafletjs.com/).
Typefaces: Unbounded and Space Mono via Google Fonts.

This is an artistic instrument, not a seismological simulation or an emergency
service. In an emergency, follow local authorities.
