import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  getCachedScan,
  remoteCacheKey,
  scanClasses,
  setCachedScan,
} from '../electron/classScanner.js'
import { detectPhpBinary } from '../electron/phpRuntime.js'

function phpSingleQuoted(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

test('class indexing never executes project-controlled Composer map files', async (t) => {
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP is not available for the scanner regression')

  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'phptinker-scan-'))
  t.after(() => fs.rm(project, { recursive: true, force: true }))

  const composerDir = path.join(project, 'vendor', 'composer')
  const appDir = path.join(project, 'app')
  const marker = path.join(project, 'composer-map-executed.txt')
  await fs.mkdir(composerDir, { recursive: true })
  await fs.mkdir(appDir, { recursive: true })

  await fs.writeFile(path.join(project, 'composer.json'), JSON.stringify({
    name: 'example/security-regression',
    autoload: { 'psr-4': { 'App\\': 'app/' } },
  }))
  await fs.writeFile(path.join(composerDir, 'installed.json'), JSON.stringify({
    packages: [],
  }))
  await fs.writeFile(
    path.join(composerDir, 'autoload_psr4.php'),
    `<?php\nfile_put_contents(${phpSingleQuoted(marker)}, 'executed');\nreturn ['App\\\\' => [${phpSingleQuoted(appDir)}]];\n`,
  )
  await fs.writeFile(
    path.join(composerDir, 'autoload_classmap.php'),
    `<?php\nfile_put_contents(${phpSingleQuoted(marker)}, 'executed');\nreturn [\n` +
      `  'App\\\\lowercaseWidget' => ${phpSingleQuoted(path.join(project, 'lib', 'widget.inc'))},\n` +
      `  'Mapped\\\\NestedTest' => ${phpSingleQuoted(path.join(project, 'lib', 'Tests', 'NestedTest.php'))},\n` +
      `];\n`,
  )
  await fs.writeFile(
    path.join(appDir, 'Demo.php'),
    '<?php namespace App; final class Demo {}\n',
  )

  const scan = await scanClasses(project, { phpPath: runtime.path })

  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
  assert.ok(scan.classes.some((entry) => entry.fqcn === 'App\\Demo'))
  assert.ok(scan.classes.some((entry) => entry.fqcn === 'App\\lowercaseWidget'))
  assert.ok(scan.classes.some((entry) => entry.fqcn === 'Mapped\\NestedTest'))
})

test('early scanner process exit rejects without crashing on a broken stdin pipe', async (t) => {
  if (process.platform === 'win32') return t.skip('uses the POSIX false utility')

  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'phptinker-scan-failure-'))
  t.after(() => fs.rm(project, { recursive: true, force: true }))

  await assert.rejects(
    scanClasses(project, { phpPath: '/usr/bin/false' }),
    /exited with|EPIPE/i,
  )
})

test('indexing rejects missing and relative PHP commands before spawning in the project', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'phptinker-php-hijack-'))
  t.after(() => fs.rm(project, { recursive: true, force: true }))
  const marker = path.join(project, 'executed')
  await fs.writeFile(path.join(project, 'php'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })

  for (const phpPath of [undefined, 'php', './php', 'bin/php', '']) {
    await assert.rejects(scanClasses(project, { phpPath }), /absolute.*PHP|PHP.*absolute/i)
  }
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
})

test('remote class cache identity includes the complete connection target', () => {
  const first = remoteCacheKey({
    id: 'same-id',
    host: 'one.example.test',
    user: 'deploy',
    port: 22,
    phpPath: '/usr/bin/php',
    projectPath: '/srv/app',
  })
  const edited = remoteCacheKey({
    id: 'same-id',
    host: 'two.example.test',
    user: 'deploy',
    port: 22,
    phpPath: '/usr/bin/php',
    projectPath: '/srv/app',
  })

  assert.notEqual(first, edited)
})

test('in-memory caches can enforce a maximum age', () => {
  const key = `test:${Date.now()}`
  setCachedScan(key, { classes: [], count: 0, scannedAt: Date.now() - 10_000 })

  assert.equal(getCachedScan(key, { maxAgeMs: 1_000 }), null)
})
