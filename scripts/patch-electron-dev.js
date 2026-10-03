// Dev-only branding patch.
//
// In `npm run dev`, the dock label + macOS menu-bar app name come from
// CFBundleName / CFBundleDisplayName in Electron.app's Info.plist (i.e. the
// binary that node_modules/.bin/electron launches), NOT from app.setName()
// in main.js. This script rewrites those keys to "PHP Tinker" so dev mode
// matches the packaged build (productName in package.json).
//
// Patching the plist alone isn't enough: macOS LaunchServices caches the
// localized bundle name by bundle identifier and path. Stale cache entries
// survive `killall Dock`. So after patching we also:
//   1) patch every helper bundle's plist (Renderer/GPU/Plugin), so process
//      lists / Activity Monitor show "PHP Tinker Helper" instead of
//      "Electron Helper",
//   2) bump CFBundleIdentifier to a project-specific id so the cache lookup
//      is forced to a fresh entry,
//   3) re-register the bundle via `lsregister -f` to refresh LaunchServices,
//   4) bump the main bundle's mtime so the Dock notices the change.
//
// Re-runs are idempotent. Safe to invoke on every npm run dev.
// Re-runs after `npm install` are required because npm overwrites the file.

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import path from 'node:path'

const APP_NAME = 'PHP Tinker'
const APP_ID = 'com.phptinker.app.dev'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const sourceAppBundle = path.resolve('node_modules/electron/dist/Electron.app')
const brandedRoot = path.resolve('node_modules/.phptinker-electron')
const brandedAppBundle = path.join(brandedRoot, `${APP_NAME}.app`)

if (!existsSync(path.join(sourceAppBundle, 'Contents/Info.plist'))) {
  // No Electron installed yet; nothing to patch.
  process.exit(0)
}

function setKey(plist, key, value) {
  try {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist], {
      stdio: 'ignore',
    })
  } catch (err) {
    console.warn(`[patch-electron-dev] failed to set ${key} in ${plist}: ${err.message}`)
  }
}

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function patchBundle(appBundle, { executableName = null } = {}) {
  const mainPlist = path.join(appBundle, 'Contents/Info.plist')
  if (!existsSync(mainPlist)) return

  // Main bundle.
  setKey(mainPlist, 'CFBundleName', APP_NAME)
  setKey(mainPlist, 'CFBundleDisplayName', APP_NAME)
  setKey(mainPlist, 'CFBundleIdentifier', APP_ID)
  if (executableName) setKey(mainPlist, 'CFBundleExecutable', executableName)

  // Helper bundles (Renderer / GPU / Plugin / base).
  const helpers = [
    ['Electron Helper.app',            'PHP Tinker Helper',            `${APP_ID}.helper`],
    ['Electron Helper (Renderer).app', 'PHP Tinker Helper (Renderer)', `${APP_ID}.helper.Renderer`],
    ['Electron Helper (GPU).app',      'PHP Tinker Helper (GPU)',      `${APP_ID}.helper.GPU`],
    ['Electron Helper (Plugin).app',   'PHP Tinker Helper (Plugin)',   `${APP_ID}.helper.Plugin`],
  ]

  for (const [bundleName, displayName, bundleId] of helpers) {
    const helperPlist = path.join(appBundle, 'Contents/Frameworks', bundleName, 'Contents/Info.plist')
    if (!existsSync(helperPlist)) continue
    setKey(helperPlist, 'CFBundleName', displayName)
    setKey(helperPlist, 'CFBundleDisplayName', displayName)
    setKey(helperPlist, 'CFBundleIdentifier', bundleId)
  }

  // Touch the bundle so LaunchServices/Dock see it as changed.
  try {
    const now = new Date()
    utimesSync(appBundle, now, now)
  } catch {}

  // Re-register with LaunchServices so the cached localized name is refreshed.
  try {
    execFileSync(lsregister, ['-u', appBundle], { stdio: 'ignore' })
  } catch {}
  try {
    execFileSync(lsregister, ['-f', appBundle], { stdio: 'ignore' })
  } catch {}
}

function prepareBrandedBundle() {
  let tempBundle = null
  try {
    mkdirSync(brandedRoot, { recursive: true })

    // cpSync(..., force: true) does not reliably replace macOS framework
    // bundles inside an existing .app. A half-copied bundle is worse than no
    // bundle: dyld will find the renamed executable, then fail to load
    // Electron Framework.framework. Build a fresh temp bundle, then swap it in.
    tempBundle = path.join(brandedRoot, `.${APP_NAME}.app.tmp-${process.pid}`)
    rmSync(tempBundle, { recursive: true, force: true })
    cpSync(sourceAppBundle, tempBundle, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    })

    const originalExecutable = path.join(tempBundle, 'Contents/MacOS/Electron')
    const brandedExecutable = path.join(tempBundle, 'Contents/MacOS', APP_NAME)
    if (existsSync(originalExecutable)) {
      copyFileSync(originalExecutable, brandedExecutable)
      chmodSync(brandedExecutable, 0o755)
    }

    patchBundle(tempBundle, { executableName: APP_NAME })

    rmSync(brandedAppBundle, { recursive: true, force: true })
    renameSync(tempBundle, brandedAppBundle)
  } catch (err) {
    if (tempBundle) {
      try {
        rmSync(tempBundle, { recursive: true, force: true })
      } catch {}
    }
    console.warn(`[patch-electron-dev] failed to prepare branded dev bundle: ${err.message}`)
  }
}

// Keep the upstream Electron bundle patched for tools that still launch it
// directly, and create a branded copy whose bundle and executable names are
// both PHP Tinker. The Vite dev launcher points at the branded copy.
patchBundle(sourceAppBundle)
prepareBrandedBundle()
