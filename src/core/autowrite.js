// Pure helpers for writing automation. Points are [beat, normalizedValue].

export function valueAt(pts, beat) {
  if (!pts.length) return null;
  if (beat <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (beat >= last[0]) return last[1];
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= beat) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  return b[0] > a[0] ? a[1] + ((b[1] - a[1]) * (beat - a[0])) / (b[0] - a[0]) : b[1];
}

// Replace everything the segment covers; keep the curve outside it.
export function mergeSegment(base, seg) {
  if (!seg.length) return base.map((p) => [p[0], p[1]]);
  const s = seg[0][0], e = seg[seg.length - 1][0];
  return [
    ...base.filter((p) => p[0] < s - 1e-9).map((p) => [p[0], p[1]]),
    ...seg.map((p) => [p[0], p[1]]),
    ...base.filter((p) => p[0] > e + 1e-9).map((p) => [p[0], p[1]]),
  ];
}

// Ramer-Douglas-Peucker: drop points that stay within `tol` of the line
// between their neighbours (in value units), keeping both endpoints.
export function simplify(pts, tol = 0.002) {
  if (pts.length <= 2) return pts.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x0, y0] = pts[a], [x1, y1] = pts[b];
    let worst = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      const yl = x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y0;
      const d = Math.abs(y - yl);
      if (d > dmax) { dmax = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => [p[0], p[1]]);
}
