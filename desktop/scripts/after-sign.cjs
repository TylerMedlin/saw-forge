// macOS without a Developer ID certificate: give the app an ad-hoc signature.
// Apple Silicon refuses to run unsigned code at all, so this turns "the app is
// damaged" into the normal "unidentified developer" prompt (System Settings →
// Privacy & Security → Open Anyway). With a certificate this does nothing.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath}`);
};
