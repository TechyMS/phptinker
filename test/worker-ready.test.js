import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForJavaScriptWorker } from '../scripts/worker-ready.js'

test('worker readiness waits for lazy registration but preserves other failures', async () => {
  let attempts = 0
  const worker = () => {}
  assert.equal(await waitForJavaScriptWorker(async () => {
    if (++attempts < 3) throw 'JavaScript not registered!'
    return worker
  }, { intervalMs: 1 }), worker)
  const failure = new Error('Worker failed to load')
  await assert.rejects(waitForJavaScriptWorker(async () => { throw failure }), error => error === failure)
})

test('unregistered worker still fails within the readiness deadline', async () => {
  await assert.rejects(waitForJavaScriptWorker(async () => { throw 'JavaScript not registered!' },
    { timeoutMs: 0 }), error => error === 'JavaScript not registered!')
})
