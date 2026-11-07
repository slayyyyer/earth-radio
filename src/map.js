/**
 * Leaflet map: a dark world canvas, one glowing marker per quake, and
 * expanding chromatic rings fired at the moment a sound plays.
 */

import L from 'leaflet';
import { clamp } from './mapping.js';

// Esri's public Dark Gray Canvas raster tiles. Unlike CARTO's keyless raster
// endpoint (which began adding watermarks in September 2026), this service
// does not require an API key.
const TILE_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> — Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, and the GIS user community';

function markerColor(mag) {
  const t = clamp((mag - 2.5) / 4.5, 0, 1);
  if (t >= 0.55) return '#ff5fd5';
  if (t >= 0.27) return '#bd7bff';
  return '#8b5cff';
}

function ringColor(mag) {
  const t = clamp((mag - 2.5) / 4.5, 0, 1);
  if (t >= 0.55) return '#ffb3f1';
  if (t >= 0.27) return '#ff6ad5';
  return '#b493ff';
}

function markerRadius(mag) {
  const t = clamp((mag - 2.5) / 4.5, 0, 1);
  return Math.max(4, 3.6 + t ** 0.72 * 8.8);
}

export class QuakeMap {
  constructor(container, { onSelect, onBackground } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onBackground = onBackground;
    this.markers = new Map();
    this.markerStyles = new Map();
    this.pulseTimers = new Map();

    this.map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 0,
      maxZoom: 7,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 110,
      preferCanvas: true,
      renderer: L.canvas({ padding: 0.45 }),
    });

    this.tiles = L.tileLayer(TILE_URL, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      detectRetina: true,
    }).addTo(this.map);

    L.control
      .zoom({
        position: 'bottomright',
        zoomInTitle: 'Zoom in',
        zoomOutTitle: 'Zoom out',
      })
      .addTo(this.map);

    // A colorful atmosphere that sits above the basemap but below markers.
    this.atmosphere = L.DomUtil.create('div', 'map-atmosphere', container);
    this.atmosphere.style.zIndex = '350';

    this.layer = L.layerGroup().addTo(this.map);

    this.map.on('click', () => this.onBackground?.());
    this.map.on('movestart zoomstart', () => this.clearPulses());

    // Leaflet needs a centre/zoom before any latLng conversion. Set one now
    // rather than relying on rAF, which does not run in a hidden tab.
    this.map.setView([16, 0], 1.5, { animate: false });
    const fitWorld = () => {
      this.map.invalidateSize();
      this.map.fitWorld({ animate: false });
    };
    requestAnimationFrame(fitWorld);
    window.setTimeout(fitWorld, 120);
  }

  setEvents(events) {
    this.clearEvents();

    for (const event of events) {
      const radius = markerRadius(event.mag);
      const color = markerColor(event.mag);
      const style = {
        radius,
        color: 'rgba(255,255,255,0.34)',
        weight: 0.8,
        opacity: 0.8,
        fillColor: color,
        fillOpacity: 0.52 + clamp((event.mag - 2.5) / 4.5, 0, 1) * 0.34,
      };

      const marker = L.circleMarker([event.lat, event.lon], {
        ...style,
        bubblingMouseEvents: false,
      });

      marker.on('mouseover', () => {
        marker.setStyle({
          color: '#fff3fd',
          weight: 1.4,
          fillOpacity: 1,
        });
        marker.bringToFront();
      });
      marker.on('mouseout', () => {
        marker.setStyle(style);
      });
      marker.on('click', () => this.onSelect?.(event));
      marker.bindTooltip(() => this._tooltip(event), {
        direction: 'top',
        offset: [0, -2],
        opacity: 1,
        className: 'quake-tooltip',
      });

      this.layer.addLayer(marker);
      this.markers.set(event.id, marker);
      this.markerStyles.set(event.id, style);
    }
  }

  _tooltip(event) {
    const node = document.createElement('div');
    node.className = 'quake-tip';

    const mag = document.createElement('b');
    mag.textContent = `M${event.mag.toFixed(1)}`;

    const place = document.createElement('span');
    place.textContent = event.place;

    node.append(mag, place);
    return node;
  }

  pulse(event) {
    if (!event) return;

    const marker = this.markers.get(event.id);
    const baseStyle = this.markerStyles.get(event.id);
    if (marker && baseStyle) {
      clearTimeout(this.pulseTimers.get(event.id));
      marker.setStyle({
        radius: baseStyle.radius * 1.65 + 1,
        color: '#fff4fe',
        weight: 1.6,
        opacity: 1,
        fillColor: ringColor(event.mag),
        fillOpacity: 1,
      });
      const timer = window.setTimeout(() => {
        marker.setStyle(baseStyle);
        this.pulseTimers.delete(event.id);
      }, 460);
      this.pulseTimers.set(event.id, timer);
    }

    let point;
    try {
      point = this.map.latLngToContainerPoint([event.lat, event.lon]);
    } catch {
      // The map has not been sized yet (for example in a hidden tab).
      return;
    }
    if (
      point.x < -60 ||
      point.y < -60 ||
      point.x > this.container.clientWidth + 60 ||
      point.y > this.container.clientHeight + 60
    ) {
      return;
    }

    const ring = document.createElement('div');
    ring.className = 'quake-pulse';
    if (event.mag >= 5.4) ring.classList.add('quake-pulse--big');
    ring.style.left = `${point.x}px`;
    ring.style.top = `${point.y}px`;
    ring.style.zIndex = '450';
    ring.style.setProperty('--ring', ringColor(event.mag));
    this.container.appendChild(ring);
    window.setTimeout(() => ring.remove(), 1650);
  }

  focus(event) {
    if (!event) return;
    const zoom = Math.max(this.map.getZoom(), 3);
    const options = { animate: true, duration: 0.8 };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.map.setView([event.lat, event.lon], zoom, { animate: false });
    } else {
      this.map.flyTo([event.lat, event.lon], zoom, options);
    }
  }

  clearPulses() {
    for (const ring of this.container.querySelectorAll('.quake-pulse')) {
      ring.remove();
    }
  }

  clearEvents() {
    this.clearPulses();
    for (const timer of this.pulseTimers.values()) clearTimeout(timer);
    this.pulseTimers.clear();
    this.layer.clearLayers();
    this.markers.clear();
    this.markerStyles.clear();
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}
