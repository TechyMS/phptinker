// Run with the Electron binary after npm run build. Uses disposable user data.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, access, chmod, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { saveDiagnosticScreenshot } from './smoke-diagnostics.js'

const userData = await mkdtemp(path.join(os.tmpdir(), 'phptinker-smoke-'))
app.setPath('userData', userData)
const deadline = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1) }, 90000)
let phase = 'startup'
async function smoke() {
try {
  await app.whenReady()
  await writeFile(path.join(userData,'phptinker.json'), JSON.stringify({phpPath:'php',tabs:[],activeTabId:null}), {mode:0o644})
  if (process.platform !== 'win32') await chmod(userData,0o755)
  const store = await import('../electron/store.js')
  store.setTabs([{ id: 'smoke', title: 'JavaScript smoke', titleIsCustom: true, language: 'js', buffer: 'process.', projectPath: null }])
  store.setActiveTabId('smoke')
  const loaded = new Promise((resolve, reject) => {
    app.once('browser-window-created', (_event, window) => {
      window.webContents.on('console-message', (_e, ...details) => console.log('Renderer:', ...details))
      window.webContents.debugger.attach('1.3')
      window.webContents.debugger.on('message', (_e, method, params) => {
        if (method === 'Runtime.exceptionThrown') console.error('Renderer exception:', JSON.stringify(params))
      })
      void window.webContents.debugger.sendCommand('Runtime.enable')
      window.webContents.once('did-fail-load', (_e, code, description) => reject(new Error(`${code}: ${description}`)))
      window.webContents.once('did-finish-load', () => resolve(window))
    })
  })
  await import('../dist-electron/main.js')
  const window = await loaded
  const wc = window.webContents
  const project = path.join(userData, 'project')
  await mkdir(path.join(project, 'app'), {recursive: true})
  await mkdir(path.join(project, 'vendor'), {recursive: true})
  await writeFile(path.join(project, 'composer.json'), JSON.stringify({autoload:{'psr-4':{'App\\':'app/'}}}))
  await writeFile(path.join(project, 'vendor/autoload.php'), '<?php')
  await writeFile(path.join(project, 'app/Demo.php'), '<?php namespace App; class Demo {}')
  const marker = path.join(project, 'executed')
  await writeFile(path.join(project, 'php'), `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755})
  console.log('Workspace DOM:', await wc.executeJavaScript('document.body.innerText'))
  await wc.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.body.innerText.includes('JavaScript smoke')) {clearInterval(timer); resolve()}
      else if (Date.now()-started>15000) {clearInterval(timer); reject(new Error('Workspace tabs did not load'))}
    }, 100)
  })`)
  phase = 'runtime, indexing and security checks'
  console.log('DESKTOP_EXPECTED_REJECTION: testing blank PHP path and blocked indexing; the saved runtime is then restored')
  const result = await wc.executeJavaScript(`(async () => {
    const php = await window.api.runtime.getPhp();
    const phpRun = await window.api.runPhp('21 * 2', {tabId:'smoke'});
    const jsRun = await window.api.runJs('console.log(21 * 2)', {tabId:'smoke'});
    const invalid = await window.api.runtime.setPhpPath('');
    const blockedProgress = [];
    const unsubscribe = window.api.classes.onScanProgress(progress => blockedProgress.push(progress));
    const blockedScan = await window.api.classes.rescan(${JSON.stringify(project)}).then(value => ({value}), error => ({error:String(error)}));
    unsubscribe();
    const saved = await window.api.store.getPhpPath();
    const restored = await window.api.runtime.setPhpPath(php.path);
    const scan = await window.api.classes.rescan(${JSON.stringify(project)});
    return {php, phpRun, jsRun, invalid, blockedScan, blockedProgress, scan, saved, restored,
      nodeIntegration: typeof require, api: !!window.api,
      editor: !!document.querySelector('.monaco-editor')};
  })()`)
  console.log(JSON.stringify({ userData, ...result }, null, 2))
  assert.equal(result.php.ok, true)
  assert.match(result.phpRun.stdout, /42/)
  assert.match(result.jsRun.stdout, /42/)
  assert.equal(result.invalid.ok, false)
  assert.equal(result.saved, result.php.path)
  assert.equal(result.restored.ok, true)
  assert.ok(result.scan.classes.some(entry => entry.fqcn === 'App\\Demo'))
  assert.ok(!result.blockedScan.value?.classes)
  assert.ok(result.blockedProgress.some(progress => progress.phase === 'error'), 'A failed scan must finish its progress state')
  await assert.rejects(access(marker), {code: 'ENOENT'})
  assert.equal(result.nodeIntegration, 'undefined')
  await wc.executeJavaScript('new Promise(resolve => setTimeout(resolve, 1500))')
  assert.equal(await wc.executeJavaScript("!!document.querySelector('.monaco-editor')"), true)
  const settings = JSON.parse(await readFile(path.join(userData, 'phptinker.json'), 'utf8'))
  if (process.platform !== 'win32') {
    assert.equal((await stat(userData)).mode & 0o777,0o700)
    assert.equal((await stat(path.join(userData,'phptinker.json'))).mode & 0o777,0o600)
  }
  assert.equal(settings.phpPath, result.php.path)
  console.log('DESKTOP_CORE_PASS')
  phase = 'Monaco worker checks'
  const workerWindow = new BrowserWindow({show: false, webPreferences: {sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false}})
  workerWindow.webContents.on('console-message', (_event, ...details) => console.log('Worker renderer:', ...details))
  await workerWindow.loadFile(path.resolve('smoke-dist/scripts/monaco-smoke.html'))
  const completions = await workerWindow.webContents.executeJavaScript('window.monacoSmoke')
  assert.ok(completions.names.includes('argv'), JSON.stringify(completions))
  assert.ok(completions.names.includes('env'), JSON.stringify(completions))
  console.log('MONACO_WORKER_PASS', completions.names)
  clearTimeout(deadline)
  phase = 'optional screenshot diagnostics'
  const screenshot = await saveDiagnosticScreenshot(wc, path.join(userData, 'desktop.png'))
  if (!screenshot.saved) console.warn('DESKTOP_SCREENSHOT_UNAVAILABLE (diagnostic only):', screenshot.error)
  console.log('DESKTOP_SMOKE_PASS', userData)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(0)
} catch (error) {
  console.error(`DESKTOP_SMOKE_FAIL (${phase}):`, error)
  clearTimeout(deadline)
  app.exit(1)
}
}
void smoke()
