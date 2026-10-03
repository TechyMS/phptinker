// Diagnostic launch of a built app. Executes only harmless arithmetic via IPC.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { statFile } from '@electron/asar'

const server = net.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const executable = path.resolve(process.argv[2])
const archive = process.platform === 'darwin'
  ? path.resolve(path.dirname(executable), '../Resources/app.asar')
  : path.join(path.dirname(executable), 'resources/app.asar')
assert.ok(statFile(archive, 'build/icon.png').size, 'Packaged window icon is required')
assert.ok(statFile(archive, 'LICENSE').size, 'Packaged MIT license is required')
assert.ok(statFile(archive, 'THIRD_PARTY_NOTICES.txt').size, 'Packaged dependency notices are required')
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {stdio: ['ignore', 'pipe', 'pipe']})
console.log('Packaged test process:', child.pid)
let childExited = false
const exited = new Promise(resolve => child.once('exit', () => {childExited = true; resolve()}))
child.stdout.on('data', chunk => process.stdout.write(chunk))
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.on('error', error => console.error('Packaged process error:', error))
child.on('exit', (code, signal) => console.log('Packaged process exit:', {code, signal}))
const pending = new Map()
let socket
let sequence = 0
try {
  let target
  for (let attempt = 0; attempt < 600; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page') } catch {}
    if (target) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(target, 'Packaged renderer did not start')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve); socket.addEventListener('error', reject)})
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {pending.delete(id); reject(new Error(`${method} timed out`))}, 20000)
      pending.set(id, {resolve, reject, timer})
      socket.send(JSON.stringify({id, method, params}))
    })
  }
  const result = await request('Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression: `(async () => {
    for (let attempt=0; attempt<150 && !document.querySelector('.monaco-editor'); attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    return {location:location.href, api:!!window.api, require:typeof require,
      editor:!!document.querySelector('.monaco-editor'), tabs:await window.api.store.getTabs(),
      php:await window.api.runtime.getPhp(), node:await window.api.getNodeVersion(),
      phpRun:await window.api.runPhp('21 * 2'), jsRun:await window.api.runJs('console.log(21 * 2)')};
  })()`})
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  const actual = result.result.value
  console.log(JSON.stringify(actual, null, 2))
  assert.match(actual.location, /app\.asar\/dist\/index\.html/)
  assert.equal(actual.require, 'undefined')
  assert.equal(actual.api, true)
  assert.equal(actual.editor, true)
  assert.ok(actual.tabs.length)
  assert.equal(actual.php.ok, true)
  assert.match(actual.phpRun.stdout, /42/)
  assert.match(actual.jsRun.stdout, /42/)
  console.log('PACKAGED_SMOKE_PASS')
} finally {
  socket?.close()
  for (const waiter of pending.values()) clearTimeout(waiter.timer)
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise(resolve=>setTimeout(resolve,2000))])
  if (!childExited) {
    child.kill('SIGKILL')
    await Promise.race([exited, new Promise(resolve=>setTimeout(resolve,2000))])
  }
}
