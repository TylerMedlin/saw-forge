// WAV (RIFF) encoding: 16-bit with TPDF dither, 24-bit, or 32-bit float.

export function encodeWav(channels, sampleRate, bitDepth = 24) {
  const nch = channels.length, frames = channels[0].length;
  const float = bitDepth === 32;
  const bps = bitDepth / 8;
  const dataBytes = frames * nch * bps;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  let seed = 22222;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let x = channels[c][i];
      if (!(x === x)) x = 0;
      if (float) { v.setFloat32(o, x, true); o += 4; continue; }
      if (bitDepth === 16) {
        let s = x * 32767 + (rnd() - rnd()); // TPDF dither, 1 LSB peak
        s = Math.max(-32768, Math.min(32767, Math.round(s)));
        v.setInt16(o, s, true); o += 2;
      } else {
        let s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
        v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff); o += 3;
      }
    }
  }
  return buf;
}

export function audioStats(channels) {
  let peak = 0, sum = 0, n = 0, clipped = 0, nan = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      if (!(x === x)) { nan++; continue; }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
      sum += x * x; n++;
    }
  }
  return { peak, peakDb: 20 * Math.log10(peak + 1e-12), rmsDb: 10 * Math.log10(sum / Math.max(1, n) + 1e-24), clipped, nan };
}
