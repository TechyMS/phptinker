import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { AppInfo } = require('app-builder-lib/out/appInfo')
const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget')
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper')

// Characterize the builder's Linux metadata contract without downloading an
// Electron binary. Source archives must build even without a Git checkout.
test('Debian installer accepts release metadata without a Git checkout', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const info = { metadata, devMetadata: metadata, config: metadata.build, repositoryInfo: Promise.resolve(null) }
  const target = Object.create(FpmTarget.prototype)
  target.packager = { info, appInfo: new AppInfo(info) }
  target.options = metadata.build.linux
  const result = await target.checkOptions()
  assert.equal(result.url, 'https://github.com/TechyMS/phptinker')
  assert.match(result.maintainer, /^[^<>]+ <[^<>\s]+@[^<>\s]+>$/)
})

test('Linux launcher filename and window identity match the application ID', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const info = { metadata, devMetadata: metadata, config: metadata.build }
  const helper = Object.create(LinuxTargetHelper.prototype)
  helper.packager = {
    info, appInfo: new AppInfo(info), config: metadata.build,
    platformSpecificBuildOptions: metadata.build.linux,
    executableName: metadata.name, fileAssociations: [],
  }
  const launcher = await helper.computeDesktopEntry(metadata.build.linux)
  assert.equal(helper.getDesktopFileName(), 'com.phptinker.app')
  assert.match(launcher, /^StartupWMClass=com\.phptinker\.app$/m)
})
