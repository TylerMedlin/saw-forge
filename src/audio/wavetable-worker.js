// Builds band-limited wavetable mip chains off the UI thread.
import { buildWavetable } from '../shared/wavetable.js';

self.onmessage = (e) => {
  const { id, wt } = e.data;
  try {
    const t = buildWavetable(wt);
    self.postMessage({ id, ok: true, table: t }, [t.data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
