import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises'
import { saveDiagnosticScreenshot } from '../scripts/smoke-diagnostics.js'

async function destination(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phptinker-capture-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'desktop.png')
}

test('a compositor capture error is reported without rejecting the smoke run', async t => {
  const file = await destination(t)
  // Electron's external capture API produced this exact error on the CI runner.
  const contents = { capturePage: async () => { throw new Error('UnknownVizError') } }
  assert.deepEqual(await saveDiagnosticScreenshot(contents, file), {
    saved: false, error: 'UnknownVizError',
  })
  await assert.rejects(access(file), { code: 'ENOENT' })
})

test('a diagnostic screenshot is written when the compositor supplies an image', async t => {
  const file = await destination(t)
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const contents = { capturePage: async () => ({ toPNG: () => png }) }
  assert.deepEqual(await saveDiagnosticScreenshot(contents, file), { saved: true })
  assert.deepEqual(await readFile(file), png)
})

test('an unresponsive capture cannot consume the desktop smoke deadline', async t => {
  const file = await destination(t)
  const contents = { capturePage: () => new Promise(() => {}) }
  assert.deepEqual(await saveDiagnosticScreenshot(contents, file, { timeoutMs: 1 }), {
    saved: false, error: 'Diagnostic screenshot timed out',
  })
  await assert.rejects(access(file), { code: 'ENOENT' })
})

test('a stalled diagnostic PNG write is also bounded by the timeout', async t => {
  const file = await destination(t)
  // Simulate the external filesystem operation stalling, not the helper itself.
  t.mock.method(fsPromises, 'writeFile', () => new Promise(() => {}))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const contents = { capturePage: async () => ({ toPNG: () => Buffer.from('png') }) }
  const result = await Promise.race([
    saveDiagnosticScreenshot(contents, file, { timeoutMs: 1 }),
    delay(100).then(() => ({ stalled: true })),
  ])
  assert.deepEqual(result, { saved: false, error: 'Diagnostic screenshot timed out' })
})

test('a capture arriving after its deadline cannot start a late file write', async t => {
  const file = await destination(t)
  let completeCapture
  const contents = { capturePage: () => new Promise(resolve => { completeCapture = resolve }) }
  assert.equal((await saveDiagnosticScreenshot(contents, file, { timeoutMs: 1 })).saved, false)
  completeCapture({ toPNG: () => Buffer.from('png') })
  await nextTurn()
  await assert.rejects(access(file), { code: 'ENOENT' })
})
