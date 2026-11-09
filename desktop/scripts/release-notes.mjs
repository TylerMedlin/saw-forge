// Prints the release description (Markdown) for the current version: what's
// new in each app (from apps.json "notes"), which file to download, first-launch
// notes, and how to verify downloads. The Release workflow puts this at the top
// of the release, above GitHub's list of merged changes.
//   node scripts/release-notes.mjs > notes.md
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(join(DESKTOP, 'sawforge.config.json'), 'utf8'));
const { apps, hubNotes } = JSON.parse(readFileSync(join(DESKTOP, 'apps.json'), 'utf8'));
const v = pkg.version, site = `https://${cfg.githubOwner.toLowerCase()}.github.io/${cfg.githubRepo}/`;
const signed = { win: process.env.SIGNED_WINDOWS === 'true', mac: process.env.SIGNED_MAC === 'true' };

const out = [];
out.push(`**Saw Forge Hub ${v}** installs, updates and opens the Saw Forge apps on Windows and macOS. Free and open source (GPL-3.0).`, '');
out.push(`### What's new`, '');
if (hubNotes) out.push(`- **Saw Forge Hub ${v}:** ${hubNotes}`);
// an app whose version first shipped with an earlier hub release is listed as unchanged
for (const a of apps) {
  if (a.releasedWith && a.releasedWith !== v) out.push(`- **${a.name} ${a.version}:** unchanged.`);
  else out.push(`- **${a.name} ${a.version}:** ${a.notes || 'Improvements and fixes.'}`);
}
out.push('', '### Download', '');
out.push('| Your computer | File |', '|---|---|');
out.push(`| Windows 10 / 11 (64-bit) | \`SawForgeHub-Setup-${v}-win-x64.exe\` |`);
out.push(`| macOS 12 or later (Apple Silicon and Intel) | \`SawForgeHub-${v}-mac-universal.dmg\` |`);
out.push('', `Then open Saw Forge Hub and click **Install** next to Saw Forge Studio. The [install guide](${site}install.html) shows every step.`, '');
if (!signed.win || !signed.mac) {
  out.push('### First launch', '');
  if (!signed.win) out.push('- **Windows:** this build isn\'t code-signed yet. If you see *Windows protected your PC*, click **More info → Run anyway**.');
  if (!signed.mac) out.push('- **macOS:** this build isn\'t notarized yet. If macOS says it can\'t verify the app, open **System Settings → Privacy & Security** and click **Open Anyway** (on macOS 12–14, Control-click the app and choose **Open**).');
  out.push('');
}
out.push('### Verify your download', '');
out.push('Compare your file with `SHA256SUMS.txt` below. On Windows run `Get-FileHash <file> -Algorithm SHA256`; on macOS run `shasum -a 256 <file>`.');
out.push('Everything here was built by GitHub Actions from this commit. The `.zip` app packages are reproducible.', '');
out.push('The other files (`.blockmap`, `latest*.yml`, `catalog.json`, the mac `.zip`) are used by the hub for updates; you don\'t need to download them.');
process.stdout.write(out.join('\n') + '\n');
