// Installer and package settings for Saw Forge Hub (electron-builder).
//   Windows: a classic setup wizard (NSIS) — welcome, license, per-user or all
//            users, install folder, shortcuts, launch on finish, uninstaller.
//   macOS:   a universal (Apple Silicon + Intel) app in a drag-to-Applications
//            disk image, plus a zip for auto-updates.
// Signing turns on by itself when the certificate secrets are present
// (see docs/RELEASING.md); without them the builds are unsigned (Windows) or
// ad-hoc signed (macOS) so they still run.

'use strict';
const path = require('node:path');
const cfg = require('./sawforge.config.json');

const placeholder = /YOUR-GITHUB-USER/.test(cfg.githubOwner);
const macSigning = !!(process.env.CSC_LINK || process.env.CSC_NAME);
const notarize = macSigning && !!(process.env.APPLE_API_KEY || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID));

module.exports = {
  appId: cfg.appId,
  productName: 'Saw Forge Hub',
  copyright: `Copyright © ${new Date().getFullYear()} ${cfg.publisher}. Free software under the GNU GPL v3 or later.`,
  directories: { output: 'dist', buildResources: 'build' },
  files: ['main/**', 'hub/**', 'package.json', 'sawforge.config.json'],
  extraResources: [
    { from: 'dist-apps', to: 'apps' },
    { from: '../LICENSE', to: 'LICENSE.txt' },
  ],
  asar: true,
  publish: placeholder ? null : [{ provider: 'github', owner: cfg.githubOwner, repo: cfg.githubRepo, releaseType: 'draft' }],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    artifactName: 'SawForgeHub-Setup-${version}-win-x64.${ext}',
    legalTrademarks: `Saw Forge is a project name of ${cfg.publisher}.`,
  },
  nsis: {
    oneClick: false,                      // a real wizard, not a silent one-click install
    perMachine: false,                    // offers "only for me" (no admin) or "all users"
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    license: path.join(__dirname, '..', 'LICENSE'),
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    installerSidebar: 'build/installerSidebar.bmp',
    uninstallerSidebar: 'build/uninstallerSidebar.bmp',
    installerHeader: 'build/installerHeader.bmp',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    menuCategory: 'Saw Forge',            // Start menu → Saw Forge → Saw Forge Hub (apps join this folder)
    shortcutName: 'Saw Forge Hub',
    uninstallDisplayName: 'Saw Forge Hub',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,      // never deletes settings or projects
    include: 'build/installer.nsh',       // removes the apps and shortcuts the hub added
    artifactName: 'SawForgeHub-Setup-${version}-win-x64.${ext}',
  },

  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    icon: 'build/icon.png',
    category: 'public.app-category.music',
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity: macSigning ? undefined : null, // no certificate: skip Developer ID signing (after-sign applies an ad-hoc signature)
    notarize,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Saw Forge apps use the microphone only when you record audio.',
      LSApplicationCategoryType: 'public.app-category.music',
    },
    artifactName: 'SawForgeHub-${version}-mac-universal.${ext}',
  },
  dmg: {
    title: 'Saw Forge Hub ${version}',
    background: 'build/dmg-background.png',
    iconSize: 96,
    window: { width: 540, height: 380 },
    contents: [{ x: 140, y: 190 }, { x: 400, y: 190, type: 'link', path: '/Applications' }],
    artifactName: 'SawForgeHub-${version}-mac-universal.${ext}',
  },
  afterSign: 'scripts/after-sign.cjs',
};
