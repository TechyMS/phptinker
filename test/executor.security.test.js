import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRemotePhpCommand,
  runPhp,
  validateRemotePhpPath,
} from '../electron/executor.js'
import { getNodeVersion, runJs } from '../electron/jsExecutor.js'
import { detectPhpBinary } from '../electron/phpRuntime.js'

test('remote PHP paths cannot resolve relative to the selected project', () => {
  for (const candidate of ['./php', 'vendor/bin/php', '../php']) {
    assert.match(validateRemotePhpPath(candidate) || '', /absolute path|command name/i)
    assert.throws(
      () => buildRemotePhpCommand({
        phpPath: candidate,
        cwd: '/srv/untrusted-project',
        args: ['-v'],
      }),
      /absolute path|command name/i,
    )
  }
})

test('bare remote PHP commands are resolved before entering the project directory', () => {
  const command = buildRemotePhpCommand({
    phpPath: 'php8.4',
    cwd: '/srv/untrusted-project',
    args: ['-v'],
  })

  const resolveIndex = command.indexOf('command -v')
  const cdIndex = command.indexOf("cd '/srv/untrusted-project'")
  assert.ok(resolveIndex >= 0)
  assert.ok(cdIndex > resolveIndex)
  assert.match(command, /\"\$php_bin\"/)
})

test('absolute remote PHP paths are invoked directly', () => {
  assert.equal(validateRemotePhpPath('/opt/php/bin/php'), null)
  assert.equal(
    buildRemotePhpCommand({
      phpPath: '/opt/php/bin/php',
      cwd: '/srv/app',
      args: ['-v'],
    }),
    "cd '/srv/app' && '/opt/php/bin/php' '-v'",
  )
})

test('PHP execution stops after the output safety limit', async (t) => {
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP is not available')

  const result = await runPhp('echo str_repeat("x", 10000);', {
    phpPath: runtime.path,
    maxOutputBytes: 1024,
  })

  assert.equal(result.outputLimited, true)
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1024)
  assert.match(result.stderr, /output limit/i)
})

test('JavaScript execution stops after the output safety limit', async () => {
  const result = await runJs('process.stdout.write("x".repeat(10000));', {
    nodePath: process.execPath,
    maxOutputBytes: 1024,
  })

  assert.equal(result.outputLimited, true)
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1024)
  assert.match(result.stderr, /output limit/i)
})

test('JavaScript can use the application executable as its bundled Node runtime', async () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const version = await getNodeVersion(process.execPath, { env })
  const result = await runJs('21 * 2', {
    nodePath: process.execPath,
    env,
  })

  assert.match(version.version || '', /^v\d+/)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), '=> 42')
})
