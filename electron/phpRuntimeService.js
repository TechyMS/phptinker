export function createPhpRuntimeService({
  readPath,
  writePath,
  detect,
  validate,
}) {
  let current = null

  function persistDetected(result, source = result?.source) {
    if (!result?.ok || typeof result.path !== 'string' || !result.path.trim()) {
      current = result
      return result
    }

    const normalized = {
      ok: true,
      path: result.path.trim(),
      version: result.version,
      source,
    }
    if (readPath() !== normalized.path) writePath(normalized.path)
    current = normalized
    return normalized
  }

  async function initialize() {
    const result = await detect({ savedPath: readPath() })
    return persistDetected(result)
  }

  return {
    initialize,

    async get() {
      return current || initialize()
    },

    async rescan() {
      const result = await detect({ savedPath: null })
      return persistDetected(result)
    },

    async setPath(value) {
      const result = await validate(value)
      return persistDetected(result, result?.ok ? 'manual' : result?.source)
    },
  }
}
