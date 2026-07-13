'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

/**
 * electron-builder afterPack hook.
 *
 * Ad-hoc code-signs the macOS .app so it will actually launch. An unsigned app
 * ("identity: null") runs on Intel but fails on Apple Silicon with
 * "the application is damaged and can't be opened" — and right-click → Open does
 * NOT bypass that. An ad-hoc signature (`--sign -`) fixes it; the app still shows
 * the milder "unidentified developer" prompt (cleared by right-click → Open) until
 * real Developer ID signing + notarization is set up.
 *
 * No-op on Windows/Linux builds.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // For universal builds, electron-builder packs x64 and arm64 into separate
  // "-temp" dirs and then merges them with @electron/universal, which requires
  // the non-binary files (including code signatures) to be byte-identical. So we
  // must NOT sign the per-arch temps — that makes the signatures differ and the
  // merge fails. Sign only the final merged app (dist/mac-universal, or a plain
  // per-arch output when not building universal).
  if (context.appOutDir.endsWith('-temp')) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    // Verify so a failed/invalid signature shows up loudly in the build log.
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'inherit',
    });
    console.log(`afterPack: ad-hoc signed and verified ${appPath}`);
  } catch (err) {
    // Fail the build — shipping an unlaunchable Mac app is worse than a red CI.
    throw new Error(`afterPack: ad-hoc codesign failed for ${appPath}: ${err.message}`);
  }
};
