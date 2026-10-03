import test from 'node:test'
import assert from 'node:assert/strict'

let runtimeModule = null
try {
  runtimeModule = await import('../electron/phpRuntime.js')
} catch {
  // The first TDD run intentionally reaches this assertion before the
  // production runtime resolver exists.
}

test('provides a PHP runtime resolver', () => {
  assert.ok(runtimeModule, 'electron/phpRuntime.js must exist')
})

test('prefers a valid saved absolute PHP path', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const attempted = []
  const result = await runtimeModule.detectPhpBinary({
    savedPath: '/custom/php',
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    homeDir: '/Users/example',
    probe: async (candidate) => {
      attempted.push(candidate)
      return candidate === '/custom/php'
        ? { ok: true, path: candidate, version: 'PHP 8.4.16' }
        : { ok: false, path: candidate, error: 'not found' }
    },
  })

  assert.deepEqual(result, {
    ok: true,
    path: '/custom/php',
    version: 'PHP 8.4.16',
    source: 'saved',
  })
  assert.deepEqual(attempted, ['/custom/php'])
})

test('finds Herd PHP when the launch PATH does not include Herd', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const herdPhp = '/Users/example/Library/Application Support/Herd/bin/php'
  const result = await runtimeModule.detectPhpBinary({
    savedPath: 'php',
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    homeDir: '/Users/example',
    probe: async (candidate) => candidate === herdPhp
      ? { ok: true, path: candidate, version: 'PHP 8.4.16' }
      : { ok: false, path: candidate, error: 'not found' },
  })

  assert.deepEqual(result, {
    ok: true,
    path: herdPhp,
    version: 'PHP 8.4.16',
    source: 'known-location',
  })
})

test('uses an absolute PHP executable discovered from PATH', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const result = await runtimeModule.detectPhpBinary({
    platform: 'linux',
    env: { PATH: '/opt/php/bin:/usr/bin' },
    homeDir: '/home/example',
    probe: async (candidate) => candidate === '/opt/php/bin/php'
      ? { ok: true, path: candidate, version: 'PHP 8.3.9' }
      : { ok: false, path: candidate, error: 'not found' },
  })

  assert.deepEqual(result, {
    ok: true,
    path: '/opt/php/bin/php',
    version: 'PHP 8.3.9',
    source: 'path',
  })
})

test('rejects a blank PHP path', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const result = await runtimeModule.validatePhpBinary('   ', {
    probe: async () => {
      throw new Error('blank paths must not reach the process boundary')
    },
  })

  assert.deepEqual(result, {
    ok: false,
    path: null,
    version: null,
    error: 'PHP path is required',
  })
})

test('rejects a relative manually entered PHP path', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const result = await runtimeModule.validatePhpBinary('php', {
    probe: async () => {
      throw new Error('relative paths must not reach the process boundary')
    },
  })

  assert.deepEqual(result, {
    ok: false,
    path: 'php',
    version: null,
    error: 'Choose the absolute path to the PHP executable',
  })
})

test('reports no runtime without persisting a blank fallback', async (t) => {
  if (!runtimeModule) return t.skip('runtime resolver not implemented yet')

  const result = await runtimeModule.detectPhpBinary({
    savedPath: '',
    platform: 'linux',
    env: { PATH: '' },
    homeDir: '/home/example',
    probe: async (candidate) => ({
      ok: false,
      path: candidate,
      error: 'not found',
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.path, null)
  assert.equal(result.version, null)
  assert.match(result.error, /could not find PHP/i)
})
