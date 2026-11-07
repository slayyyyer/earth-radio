/**
 * Encode an AudioBuffer as a 16-bit PCM WAV.
 *
 * The entire audio path is synthesized, so an export is just the rendered
 * buffer plus a small RIFF header. No encoder dependency is needed.
 */

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function audioBufferToWavArrayBuffer(buffer) {
  if (!buffer || !Number.isFinite(buffer.length) || buffer.length <= 0) {
    throw new Error('A non-empty AudioBuffer is required.');
  }

  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));
  const frameCount = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = Array.from(
    { length: channels },
    (_, channel) => buffer.getChannelData(channel),
  );
  let offset = 44;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(
        offset,
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
        true,
      );
      offset += bytesPerSample;
    }
  }

  return arrayBuffer;
}

export function audioBufferToWavBlob(buffer) {
  return new Blob([audioBufferToWavArrayBuffer(buffer)], {
    type: 'audio/wav',
  });
}
