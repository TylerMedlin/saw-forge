import { App } from './app.js';

const root = document.getElementById('root');
const app = new App(root);
window.sawforge = app; // handy for debugging in the console
app.boot().then(() => { window.__booted = true; }).catch((err) => {
  console.error(err);
  const el = document.getElementById('boot-error');
  el.hidden = false;
  el.innerHTML = '<h1>Saw Forge Studio failed to start</h1><pre></pre>';
  el.querySelector('pre').textContent = String(err && err.stack ? err.stack : err);
});
