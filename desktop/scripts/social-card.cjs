// Renders the 1280×640 social preview image (GitHub repository card and
// the website's og:image) from HTML, using real app screenshots.
//   npx electron scripts/social-card.cjs
// Writes docs/social-preview.png and site/img/social.png.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const img = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1280px; height: 640px; overflow: hidden; background: #0f1113; color: #eef1f4;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .bg { position: absolute; inset: 0; background:
    radial-gradient(760px 480px at 10% 0%, rgba(255,143,60,.22), transparent 70%),
    radial-gradient(700px 520px at 100% 100%, rgba(255,110,40,.10), transparent 70%); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px); background-size: 40px 40px; }
  .left { position: absolute; left: 72px; top: 70px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 20px; }
  .brand img { width: 104px; height: 104px; filter: drop-shadow(0 12px 30px rgba(255,120,40,.35)); }
  h1 { font-size: 78px; font-weight: 750; letter-spacing: -2px; line-height: 1; }
  .tag { margin-top: 30px; font-size: 34px; line-height: 1.22; font-weight: 600; color: #ffffff; letter-spacing: -.5px; }
  .tag b { color: #ffa95f; font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; max-width: 520px; }
  .chips span { font-size: 19px; padding: 7px 15px; border-radius: 20px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.10); color: #c9d1d9; }
  .foot { position: absolute; left: 72px; bottom: 54px; font-size: 21px; color: #8b95a0; display: flex; gap: 22px; align-items: center; }
  .foot b { color: #eef1f4; font-weight: 600; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff8f3c; }
  .shot { position: absolute; left: 660px; top: 92px; width: 900px; border-radius: 16px; overflow: hidden; border: 1px solid #30363d;
    box-shadow: 0 40px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.03); transform: perspective(2200px) rotateY(-16deg) rotateX(4deg); transform-origin: left center; }
  .shot .bar { height: 34px; background: #17191c; border-bottom: 1px solid #23272c; display: flex; gap: 8px; align-items: center; padding: 0 14px; }
  .shot .bar i { width: 12px; height: 12px; border-radius: 50%; background: #2d3237; }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="bg"></div><div class="grid"></div>
  <div class="left">
    <div class="brand"><img src="${img('site/img/hub-icon.png')}"><h1>Saw Forge</h1></div>
    <div class="tag">Free, open-source music<br>production for <b>Windows</b> &amp; <b>macOS</b></div>
    <div class="chips"><span>Wavetable synth</span><span>Worship pads</span><span>EDM drummers</span><span>Recording</span><span>Mixing</span></div>
  </div>
  <div class="foot"><b>tylermedlin.github.io/saw-forge</b><span class="dot"></span><span>GPL-3.0</span></div>
  <div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="${img('site/img/shots/studio.png')}"></div>
</body></html>`;

app.whenReady().then(async () => {
  const file = path.join(os.tmpdir(), 'sawforge-social.html');
  fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 600));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 300));
  const shot = await win.webContents.capturePage();
  const png = shot.toPNG();
  for (const rel of ['docs/social-preview.png', 'site/img/social.png']) {
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), png);
  }
  console.log(`social card ${shot.getSize().width}×${shot.getSize().height}, ${png.length} bytes`);
  app.exit(0);
});
