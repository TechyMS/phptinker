import test from 'node:test'
import assert from 'node:assert/strict'

let serviceModule = null
try {
  serviceModule = await import('../electron/phpRuntimeService.js')
} catch {
  // The initial TDD run intentionally asserts before the service exists.
}

test('provides a persistent PHP runtime service', () => {
  assert.ok(serviceModule, 'electron/phpRuntimeService.js must exist')
})

test('initialization replaces the legacy command name with a detected absolute path', async (t) => {
  if (!serviceModule) return t.skip('runtime service not implemented yet')

  let saved = 'php'
  const service = serviceModule.createPhpRuntimeService({
    readPath: () => saved,
    writePath: (value) => { saved = value },
    detect: async ({ savedPath }) => {
      assert.equal(savedPath, 'php')
      return {
        ok: true,
        path: '/opt/homebrew/bin/php',
        version: 'PHP 8.4.16',
        source: 'known-location',
      }
    },
    validate: async () => assert.fail('initialization should auto-detect'),
  })

  const result = await service.initialize()

  assert.equal(saved, '/opt/homebrew/bin/php')
  assert.equal(result.path, '/opt/homebrew/bin/php')
})

test('failed detection never overwrites the saved value with a blank path', async (t) => {
  if (!serviceModule) return t.skip('runtime service not implemented yet')

  let saved = 'php'
  let writes = 0
  const service = serviceModule.createPhpRuntimeService({
    readPath: () => saved,
    writePath: (value) => { writes++; saved = value },
    detect: async () => ({
      ok: false,
      path: null,
      version: null,
      error: 'PHP was not found',
    }),
    validate: async () => assert.fail('initialization should auto-detect'),
  })

  const result = await service.initialize()

  assert.equal(result.ok, false)
  assert.equal(saved, 'php')
  assert.equal(writes, 0)
})

test('manual updates persist only a validated nonblank absolute path', async (t) => {
  if (!serviceModule) return t.skip('runtime service not implemented yet')

  let saved = '/old/php'
  const service = serviceModule.createPhpRuntimeService({
    readPath: () => saved,
    writePath: (value) => { saved = value },
    detect: async () => assert.fail('manual updates should validate directly'),
    validate: async (value) => value.trim()
      ? { ok: true, path: '/external-drive/php', version: 'PHP 8.3.4' }
      : { ok: false, path: null, version: null, error: 'PHP path is required' },
  })

  const invalid = await service.setPath('   ')
  assert.equal(invalid.ok, false)
  assert.equal(saved, '/old/php')

  const valid = await service.setPath('/external-drive/php')
  assert.deepEqual(valid, {
    ok: true,
    path: '/external-drive/php',
    version: 'PHP 8.3.4',
    source: 'manual',
  })
  assert.equal(saved, '/external-drive/php')
})

test('rescan ignores the saved path and persists the newly detected runtime', async (t) => {
  if (!serviceModule) return t.skip('runtime service not implemented yet')

  let saved = '/old/php'
  const service = serviceModule.createPhpRuntimeService({
    readPath: () => saved,
    writePath: (value) => { saved = value },
    detect: async ({ savedPath }) => {
      assert.equal(savedPath, null)
      return {
        ok: true,
        path: '/new/php',
        version: 'PHP 8.4.16',
        source: 'path',
      }
    },
    validate: async () => assert.fail('rescan should auto-detect'),
  })

  const result = await service.rescan()

  assert.equal(result.path, '/new/php')
  assert.equal(saved, '/new/php')
})
