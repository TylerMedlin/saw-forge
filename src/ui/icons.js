// Inline SVG icons (stroke-based, 16px grid).
import { s } from './dom.js';

const P = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  record: '<circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none"/>',
  rewind: '<path d="M4 3.5v9M13 3.5v9L6 8z" fill="currentColor"/>',
  takes: '<rect x="2" y="2.5" width="12" height="3" rx="1"/><rect x="2" y="6.5" width="12" height="3" rx="1"/><rect x="2" y="10.5" width="7" height="3" rx="1"/>',
  live: '<circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/><path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8M2.5 2.5a7.8 7.8 0 0 0 0 11M13.5 2.5a7.8 7.8 0 0 1 0 11"/>',
  dots: '<circle cx="3.5" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
  punch: '<path d="M5.5 3.5h-2.5v9h2.5M10.5 3.5h2.5v9h-2.5"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>',
  loop: '<path d="M3 7.5V6a2 2 0 0 1 2-2h7l-2-2M13 8.5V10a2 2 0 0 1-2 2H4l2 2"/>',
  metro: '<path d="M5.5 14h5l-1.6-11h-1.8zM8 9.5l4-5"/>',
  undo: '<path d="M5 6H10a3 3 0 0 1 0 6H6M5 6l2.5-2.5M5 6l2.5 2.5"/>',
  redo: '<path d="M11 6H6a3 3 0 0 0 0 6h4M11 6L8.5 3.5M11 6L8.5 8.5"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1"/>',
  keys: '<rect x="1.5" y="4" width="13" height="8.5" rx="1"/><path d="M4.5 4v5M7 4v5M9.5 4v5M12 4v5M4.5 9v3.5M7 9v3.5M9.5 9v3.5M12 9v3.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  folder: '<path d="M1.8 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>',
  save: '<path d="M3 2.5h8l2.5 2.5v8.5H3zM5.5 2.5v3.5h5V2.5M5 13.5V9.5h6v4"/>',
  export: '<path d="M8 10V2.5M5 5l3-3 3 3M3 9.5v4h10v-4"/>',
  file: '<path d="M4 1.8h5.5L12.5 5v9.2h-8.5zM9.5 1.8V5h3"/>',
  wave: '<path d="M1.5 8h1.5l1-3 1.5 6 1.5-8 1.5 10 1.5-7 1.5 4 1-2h2"/>',
  synth: '<path d="M2 11l4-7v7l4-7v7l4-7"/>',
  fx: '<path d="M3 13c3 0 2-10 5-10M5 7h4M10 9l3 4M13 9l-3 4"/>',
  bus: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11M5 3v10"/>',
  mixer: '<path d="M4 2.5v11M8 2.5v11M12 2.5v11"/><rect x="2.5" y="8" width="3" height="2" rx=".5" fill="currentColor"/><rect x="6.5" y="4.5" width="3" height="2" rx=".5" fill="currentColor"/><rect x="10.5" y="10" width="3" height="2" rx=".5" fill="currentColor"/>',
  roll: '<rect x="2" y="3" width="5" height="2" rx=".5"/><rect x="6" y="7" width="7" height="2" rx=".5"/><rect x="3" y="11" width="4" height="2" rx=".5"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  left: '<path d="M10 4L6 8l4 4"/>',
  right: '<path d="M6 4l4 4-4 4"/>',
  power: '<path d="M8 2.5v5M4.8 4.6a4.5 4.5 0 1 0 6.4 0"/>',
  pencil: '<path d="M3 13l1-3.5L10.5 3l2.5 2.5L6.5 12zM9.5 4l2.5 2.5"/>',
  pointer: '<path d="M4 2.5l8 5.5-3.5.8 2 3.7-1.6.9-2-3.8L4 12z"/>',
  magnet: '<path d="M4 2.5v5a4 4 0 0 0 8 0v-5M4 5.5h2.5M9.5 5.5H12M6.5 2.5v5a1.5 1.5 0 0 0 3 0v-5"/>',
  follow: '<path d="M8 2v12M4.5 5.5L8 2l3.5 3.5"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14M5 7h4M7 5v4"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14M5 7h4"/>',
  automation: '<path d="M1.5 12l4-5 3 3 6-7"/><circle cx="5.5" cy="7" r="1.2" fill="currentColor"/><circle cx="8.5" cy="10" r="1.2" fill="currentColor"/>',
  dice: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.5" cy="5.5" r=".8" fill="currentColor"/><circle cx="10.5" cy="10.5" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 10.5V3.5a1 1 0 0 1 1-1h6.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  headphones: '<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9.5" width="3" height="4.5" rx="1"/><rect x="11" y="9.5" width="3" height="4.5" rx="1"/>',
  mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14.5M5.5 14.5h5"/>',
};

export function icon(name, size = 16, cls = '') {
  const el = s('svg', { width: size, height: size, viewBox: '0 0 16 16', class: 'icon ' + cls, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  el.innerHTML = P[name] || '';
  return el;
}
