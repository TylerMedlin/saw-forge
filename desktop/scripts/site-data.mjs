// Writes latest.json for the download site from a folder of release files:
// the version, and for each installer its name, size, SHA-256 and download URL.
//   node scripts/site-data.mjs <folder with release files> <output latest.json>
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) { console.error('usage: site-data.mjs <assets dir> <out file>'); process.exit(1); }
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(DESKTOP, 'sawforge.config.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`, base = `https://github.com/${cfg.githubOwner}/${cfg.githubRepo}/releases/download/${tag}/`;

const info = (name) => {
  const p = join(dir, name), data = readFileSync(p);
  return { file: name, size: statSync(p).size, sha256: createHash('sha256').update(data).digest('hex'), url: base + encodeURIComponent(name) };
};
const files = readdirSync(dir);
const pick = (re) => { const f = files.find((x) => re.test(x)); return f ? info(f) : null; };
const latest = {
  version: pkg.version, tag, date: new Date().toISOString().slice(0, 10),
  repoUrl: `https://github.com/${cfg.githubOwner}/${cfg.githubRepo}`,
  releaseUrl: `https://github.com/${cfg.githubOwner}/${cfg.githubRepo}/releases/tag/${tag}`,
  checksumsUrl: base + 'SHA256SUMS.txt',
  windows: pick(/^SawForgeHub-Setup-.*-win-x64\.exe$/),
  mac: pick(/^SawForgeHub-.*-mac-universal\.dmg$/),
  // set by the release workflow from whether signing secrets exist; the site hides first-launch warnings when true
  signed: { windows: process.env.SIGNED_WINDOWS === 'true', mac: process.env.SIGNED_MAC === 'true' },
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(latest, null, 2));
console.log(JSON.stringify(latest, null, 2));
