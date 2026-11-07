import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioBufferToWavArrayBuffer,
  audioBufferToWavBlob,
} from '../src/wav.js';

function fakeBuffer(channels, sampleRate = 8_000) {
  return {
    length: channels[0].length,
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData(index) {
      return Float32Array.from(channels[index]);
    },
  };
}

function ascii(view, offset, length) {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}

test('audioBufferToWavArrayBuffer writes a valid stereo 16-bit WAV', () => {
  const buffer = fakeBuffer([
    [-1, 0, 1, 2],
    [0.5, -0.5, 0, -2],
  ]);
  const arrayBuffer = audioBufferToWavArrayBuffer(buffer);
  const view = new DataView(arrayBuffer);

  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + 16);
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 8_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.byteLength, 60);

  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 16384);
  assert.equal(view.getInt16(48, true), 0);
  assert.equal(view.getInt16(50, true), -16384);
  assert.equal(view.getInt16(52, true), 32767);
  assert.equal(view.getInt16(54, true), 0);
  assert.equal(view.getInt16(56, true), 32767);
  assert.equal(view.getInt16(58, true), -32768);
});

test('a one-channel buffer uses the mono header values', () => {
  const arrayBuffer = audioBufferToWavArrayBuffer(fakeBuffer([[0, 0]]));
  const view = new DataView(arrayBuffer);

  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(28, true), 16_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint32(40, true), 4);
});

test('audioBufferToWavBlob wraps the encoding as an audio/wav Blob', async () => {
  const blob = audioBufferToWavBlob(fakeBuffer([[0.25, -0.25]]));

  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 4);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
});

test('empty or missing buffers are rejected', () => {
  assert.throws(
    () => audioBufferToWavArrayBuffer(null),
    /non-empty AudioBuffer/,
  );
  assert.throws(
    () => audioBufferToWavArrayBuffer({ length: 0 }),
    /non-empty AudioBuffer/,
  );
});
