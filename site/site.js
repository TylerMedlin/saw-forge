// Download site: picks the right installer for this computer and fills in
// version, size, checksums and links from latest.json (written by the release
// workflow). Without latest.json every button falls back to the GitHub releases page.
(function () {
  'use strict';
  const $$ = (s) => document.querySelectorAll(s);
  const ua = navigator.userAgent || '', plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /mac|iphone|ipad/i.test(plat + ' ' + ua) ? 'mac' : /win/i.test(plat + ' ' + ua) ? 'windows' : 'other';
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  const NAMES = { windows: 'Windows', mac: 'macOS' };
  const REQ = { windows: 'Windows 10 and 11, 64-bit', mac: 'macOS 12 or later · Apple Silicon and Intel' };
  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  // install guide tabs (#mac opens the macOS tab)
  const tabs = $$('[data-tab]');
  const showTab = (id) => { tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === id)); $$('.guide').forEach((g) => g.classList.toggle('on', g.id === id)); };
  tabs.forEach((t) => t.addEventListener('click', () => { showTab(t.dataset.tab); history.replaceState(null, '', '#' + t.dataset.tab); }));
  if (tabs.length) showTab(location.hash === '#mac' || (os === 'mac' && location.hash !== '#windows') ? 'mac' : 'windows');

  function apply(L) {
    const repo = L.repoUrl;
    const links = { repo, releases: `${repo}/releases`, issues: `${repo}/issues`, sums: L.checksumsUrl || `${repo}/releases/latest` };
    $$('[data-link]').forEach((a) => { if (links[a.dataset.link]) a.href = links[a.dataset.link]; });
    const asset = (k) => L[k] || null;
    const href = (k) => (asset(k) ? asset(k).url : L.releaseUrl || `${repo}/releases/latest`);
    const primary = os === 'other' ? null : os;
    $$('[data-dl="primary"]').forEach((a) => {
      a.href = primary ? href(primary) : L.releaseUrl || `${repo}/releases/latest`;
      a.querySelector('span').textContent = primary ? `Download for ${NAMES[primary]}` : 'Download Saw Forge Hub';
    });
    $$('[data-dl="primary-meta"]').forEach((el) => {
      const a = primary && asset(primary);
      el.textContent = a ? `Version ${L.version} · ${mb(a.size)} · ${REQ[primary]}` : `Version ${L.version} for Windows and macOS`;
    });
    $$('[data-dl="alt"]').forEach((el) => {
      const other = primary === 'mac' ? 'windows' : 'mac';
      el.innerHTML = '';
      const parts = [];
      if (primary) parts.push(`Also for <a href="${href(other)}">${NAMES[other]}</a>`);
      else parts.push(`<a href="${href('windows')}">Windows</a> · <a href="${href('mac')}">macOS</a>`);
      parts.push(`<a href="install.html">Install guide</a>`, `<a href="${L.releaseUrl || links.releases}">Release notes and all files</a>`);
      el.innerHTML = parts.join(' · ');
    });
    $$('[data-dl="windows"]').forEach((a) => { a.href = href('windows'); });
    $$('[data-dl="mac"]').forEach((a) => { a.href = href('mac'); });
    $$('[data-file]').forEach((c) => { const a = asset(c.dataset.file); if (a) c.textContent = a.file; });
    // checksums with copy buttons
    $$('[data-hash]').forEach((box) => {
      const k = box.dataset.hash, a = asset(k);
      if (!a) { box.hidden = true; return; }
      const cmd = k === 'windows' ? `Get-FileHash .\\${a.file} -Algorithm SHA256` : `shasum -a 256 ~/Downloads/${a.file}`;
      box.innerHTML = `<div style="margin-top:14px;font-weight:600;font-size:14px">${NAMES[k]} · <code>${a.file}</code></div>
        <div class="hash"><code>${a.sha256}</code><button class="copy" data-copy="${a.sha256}">Copy</button></div>
        <div class="hash"><code>${cmd}</code><button class="copy" data-copy="${cmd.replace(/"/g, '&quot;')}">Copy</button></div>`;
    });
    // signing status → which warnings the guide shows
    const signed = { windows: !!L.signed && !!L.signed.windows, mac: !!L.signed && !!L.signed.mac };
    $$('[data-unsigned]').forEach((n) => { n.hidden = signed[n.dataset.unsigned]; });
    const badge = document.querySelector('[data-sign="badge"]'), text = document.querySelector('[data-sign="text"]');
    if (badge && signed.windows && signed.mac) {
      badge.textContent = 'Signed'; badge.className = 'badge ok';
      text.textContent = 'Windows installers are code-signed and macOS builds are signed and notarized by Apple, so they open without warnings.';
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1400); });
  });
  fetch('latest.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then(apply).catch(() => {
    apply({ version: '', repoUrl: 'https://github.com/TylerMedlin/saw-forge' });
    $$('[data-dl="primary-meta"]').forEach((el) => { el.textContent = 'Downloads are on the GitHub releases page'; });
  });
})();
