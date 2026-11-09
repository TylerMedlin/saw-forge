# Releasing Saw Forge

Everything is built by GitHub Actions from the public source. You push a version
tag; about 15 minutes later there is a published release with a Windows
installer, a macOS disk image, app packages and checksums, and the download
site is updated.

## One-time setup

1. **Create the repository** on GitHub (for example `saw-forge`, public) and push this folder to it.
2. **Your GitHub name** is set in `desktop/sawforge.config.json`
   (`"githubOwner": "TylerMedlin", "githubRepo": "saw-forge"`) and in `desktop/package.json`.
   It drives hub auto-updates, the online app catalog and every download link.
   If you rename the repository or move it to an organization, change it in both places.
3. **Turn on GitHub Pages**: repository *Settings → Pages → Build and deployment →
   Source: GitHub Actions*. The site will live at
   `https://tylermedlin.github.io/saw-forge/`.
4. **Allow the workflow to publish releases**: *Settings → Actions → General →
   Workflow permissions → Read and write permissions*.

## Making a release

1. Bump `"version"` in `desktop/package.json`, for example to `1.1.0`.
   If Saw Forge Studio changed, also bump its `"version"` in `desktop/apps.json`
   and update its `"notes"`, which appear under *What's new* in the hub.
2. Commit, then tag and push:
   ```
   git tag v1.1.0
   git push origin main v1.1.0
   ```
3. Watch *Actions → Release*. It runs these jobs:
   - **draft:** creates a draft release.
   - **apps:** packs each app into a reproducible zip and attaches it.
   - **build:** runs the desktop self-test on Windows and on macOS, then builds
     `SawForgeHub-Setup-x.y.z-win-x64.exe` and `SawForgeHub-x.y.z-mac-universal.dmg`
     (plus the update files the hub uses).
   - **publish:** adds `SHA256SUMS.txt`, publishes the release and deploys the
     website with `latest.json` and the hub's `catalog.json`.

Installed hubs see new app versions within a few hours, or right away with the
refresh button. On Windows the hub updates itself in the background and asks
the user to restart.

## Code signing (removes the first-launch warnings)

Unsigned builds work, but Windows SmartScreen and macOS Gatekeeper show a
warning the first time. The install guide on the website explains what to do.
Add signing whenever you're ready. The workflow picks it up from repository
secrets (*Settings → Secrets and variables → Actions*), with no code changes.

**Windows.** Pick one:
- [SignPath Foundation](https://signpath.org/) offers free code signing for
  qualifying open-source projects. It signs through its own GitHub Action, so
  you'd add their step to `release.yml`.
- An OV code-signing certificate from a certificate authority, about $150–300 a year.
  Export it as `.pfx`, then add:
  - `WIN_CSC_LINK`: the `.pfx` file, base64-encoded
  - `WIN_CSC_KEY_PASSWORD`: its password
- Microsoft's Artifact Signing (about $10 a month). It is currently limited to
  organizations in some countries, so check whether you qualify.

**macOS.** Join the Apple Developer Program ($99 a year) and create a
*Developer ID Application* certificate. Then add:
- `MAC_CSC_LINK`: the `.p12` file, base64-encoded
- `MAC_CSC_KEY_PASSWORD`: its password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: for notarization

With these secrets the Mac app is signed and notarized, so it opens without any
prompt, and the hub can update itself on macOS too. Without them it is ad-hoc
signed, so it still runs on Apple Silicon after *Open Anyway*.

To base64-encode a file:
- Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`
- macOS: `base64 -i cert.p12 | pbcopy`

## Adding another app to the hub

1. Put the app's web files in the repository (an `index.html` plus assets). It
   can save files the same way Saw Forge Studio does, through `/__store/…`.
2. Add an entry to `desktop/apps.json`: its `id`, `name`, `version`, `include`
   paths, `icon` (PNG) and `iconIco`.
3. Run `npm run pack-apps` and `npm run selftest` in `desktop/`. The self-test
   installs, boots, saves into and uninstalls every app in the catalog.
4. Release as usual. Existing hubs show the new app automatically.

## Working on the desktop app

```
cd desktop
npm ci              # first time
npm run pack-apps   # package the apps
npm start           # run the hub from source
npm run selftest    # headless check: install → boot → audio → save → uninstall
npm run dist:win    # build the Windows installer locally (dist/)
npm run dist:mac    # build the macOS disk image (only on a Mac)
npm run assets      # redraw icons and installer artwork
```

To refresh the website screenshots, run
`npx electron . --capture ../site/img/shots`.
