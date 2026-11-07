/**
 * Canvas density histogram + scrubber for one UTC day.
 *
 * 144 bins = 10 minutes each. Bars use a square-root scale so different
 * levels of background seismicity remain visible under a big swarm.
 */

import { DAY_MS, formatClock } from './data.js';

const BIN_COUNT = 144;
const BIN_MS = DAY_MS / BIN_COUNT;
const PAD_X = 2;
const PAD_TOP = 10;
const PAD_BOTTOM = 7;

export class Timeline {
  constructor(canvas, { tooltip, onSeek } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.onSeek = onSeek;

    this.bins = new Array(BIN_COUNT).fill(0);
    this.maxBin = 0;
    this.playhead = 0;
    this.hoverX = null;
    this.dragging = false;
    this.enabled = true;
    this.width = 0;
    this.height = 0;
    this._lastAriaSecond = -1;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerLeave);
    canvas.addEventListener('keydown', this._onKeyDown);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    } else {
      this._onWindowResize = () => this.resize();
      window.addEventListener('resize', this._onWindowResize);
    }

    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.draw();
  }

  setEvents(events) {
    this.bins = new Array(BIN_COUNT).fill(0);

    for (const event of events) {
      const index = Math.max(
        0,
        Math.min(BIN_COUNT - 1, Math.floor(event.offset / BIN_MS)),
      );
      this.bins[index] += 1;
    }

    this.maxBin = Math.max(0, ...this.bins);
    this.draw();
  }

  setPlayhead(ms) {
    this.playhead = Math.max(0, Math.min(DAY_MS, ms));
    const second = Math.floor(this.playhead / 1000);
    if (second !== this._lastAriaSecond) {
      this._lastAriaSecond = second;
      const label =
        this.playhead >= DAY_MS ? '24:00:00' : formatClock(this.playhead);
      this.canvas.setAttribute('aria-valuenow', String(this.playhead));
      this.canvas.setAttribute('aria-valuetext', `${label} UTC`);
    }
    this.draw();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.canvas.classList.toggle('is-disabled', !this.enabled);
    this.canvas.setAttribute('aria-disabled', String(!this.enabled));
    this.canvas.tabIndex = this.enabled ? 0 : -1;
    if (!this.enabled) this.hideTooltip();
    this.draw();
  }

  xFor(ms) {
    return (
      PAD_X + (Math.max(0, Math.min(DAY_MS, ms)) / DAY_MS) * (this.width - PAD_X * 2)
    );
  }

  msForX(x) {
    const fraction = Math.max(
      0,
      Math.min(1, (x - PAD_X) / Math.max(1, this.width - PAD_X * 2)),
    );
    return fraction * DAY_MS;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!ctx || w <= 1 || h <= 1) return;

    ctx.clearRect(0, 0, w, h);

    const top = PAD_TOP;
    const bottom = h - PAD_BOTTOM;
    const plotHeight = Math.max(1, bottom - top);

    // Hour grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    for (let hour = 0; hour <= 24; hour += 6) {
      const x = PAD_X + (hour / 24) * (w - PAD_X * 2);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    // Baseline.
    ctx.strokeStyle = 'rgba(255,122,218,0.13)';
    ctx.beginPath();
    ctx.moveTo(PAD_X, bottom + 0.5);
    ctx.lineTo(w - PAD_X, bottom + 0.5);
    ctx.stroke();

    if (this.maxBin > 0) {
      const slot = w / BIN_COUNT;
      const barWidth = Math.max(1, slot - 1.1);
      const barGradient = ctx.createLinearGradient(0, top, 0, bottom);
      barGradient.addColorStop(0, '#ff8be2');
      barGradient.addColorStop(0.45, '#ff3ec8');
      barGradient.addColorStop(1, '#7b4dff');

      const path = new Path2D();
      const tallPath = new Path2D();

      for (let i = 0; i < BIN_COUNT; i += 1) {
        const count = this.bins[i];
        if (!count) continue;
        const norm = Math.sqrt(count / this.maxBin);
        const barHeight = Math.max(3, norm * (plotHeight - 2));
        const x = i * slot + (slot - barWidth) / 2;
        const y = bottom - barHeight;
        path.rect(x, y, barWidth, barHeight);
        if (norm >= 0.55) tallPath.rect(x, y, barWidth, barHeight);
      }

      ctx.save();
      ctx.fillStyle = barGradient;
      ctx.globalAlpha = 0.88;
      ctx.fill(path);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#ffb4ee';
      ctx.shadowColor = 'rgba(255,62,200,0.55)';
      ctx.shadowBlur = 10;
      ctx.fill(tallPath);
      ctx.restore();
    }

    // Subtle tint over the played region.
    const playheadX = this.xFor(this.playhead);
    ctx.fillStyle = 'rgba(255,62,200,0.055)';
    ctx.fillRect(0, top, playheadX, plotHeight);

    // Hover crosshair.
    if (this.hoverX !== null && !this.dragging) {
      ctx.strokeStyle = 'rgba(249,240,255,0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(this.hoverX + 0.5, top);
      ctx.lineTo(this.hoverX + 0.5, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Playhead.
    ctx.save();
    ctx.shadowColor = 'rgba(255,62,200,0.8)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(255,139,228,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(playheadX, top);
    ctx.lineTo(playheadX, bottom);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(playheadX, top);
    ctx.lineTo(playheadX, bottom);
    ctx.stroke();

    ctx.fillStyle = '#fff8ff';
    ctx.shadowColor = 'rgba(255,62,200,0.9)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(playheadX, top + 1.5, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  _pointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  }

  _seekFromX(x) {
    const ms = this.msForX(x);
    this.setPlayhead(ms);
    this.onSeek?.(ms);
  }

  _onPointerDown(event) {
    if (!this.enabled || event.button !== 0) return;
    this.dragging = true;
    this.canvas.classList.add('is-scrubbing');
    this.canvas.setPointerCapture?.(event.pointerId);
    this._seekFromX(this._pointerPosition(event));
    this._updateTooltip(event);
    event.preventDefault();
  }

  _onPointerMove(event) {
    if (!this.enabled) return;
    const x = this._pointerPosition(event);
    this.hoverX = x;
    if (this.dragging) this._seekFromX(x);
    this._updateTooltip(event);
    this.draw();
  }

  _onPointerUp(event) {
    this.dragging = false;
    this.canvas.classList.remove('is-scrubbing');
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.draw();
  }

  _onPointerLeave() {
    this.hoverX = null;
    if (!this.dragging) this.hideTooltip();
    this.draw();
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    let next = null;
    const fifteenMinutes = 900_000;
    const oneHour = 3_600_000;

    switch (event.key) {
      case 'ArrowLeft':
        next = this.playhead - (event.shiftKey ? oneHour : fifteenMinutes);
        break;
      case 'ArrowRight':
        next = this.playhead + (event.shiftKey ? oneHour : fifteenMinutes);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = DAY_MS;
        break;
      default:
        break;
    }

    if (next === null) return;
    event.preventDefault();
    next = Math.max(0, Math.min(DAY_MS, next));
    this.setPlayhead(next);
    this.onSeek?.(next);
  }

  _updateTooltip(event) {
    if (!this.tooltip) return;
    const x = this._pointerPosition(event);
    const fraction = Math.max(
      0,
      Math.min(1, (x - PAD_X) / Math.max(1, this.width - PAD_X * 2)),
    );
    const bin = Math.min(
      BIN_COUNT - 1,
      Math.max(0, Math.floor(fraction * BIN_COUNT)),
    );
    const count = this.bins[bin] || 0;
    const startMs = bin * BIN_MS;
    const endMs = bin === BIN_COUNT - 1 ? DAY_MS : (bin + 1) * BIN_MS;
    const start = formatClock(startMs, false);
    const end = endMs >= DAY_MS ? '24:00' : formatClock(endMs, false);

    this.tooltip.textContent = `${start}–${end} UTC · ${count} ${
      count === 1 ? 'event' : 'events'
    }`;
    const clamped = Math.max(76, Math.min(this.width - 76, fraction * this.width));
    this.tooltip.style.left = `${clamped}px`;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }

  destroy() {
    this.resizeObserver?.disconnect();
    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
    }
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('keydown', this._onKeyDown);
  }
}
