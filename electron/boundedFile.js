import { promises as fs, constants } from 'node:fs'

export async function readBoundedFile(file, {maxBytes = 1024 * 1024, timeoutMs = 2000} = {}) {
  let handle
  let canceled = false
  const operation = (async () => {
    const entry = await fs.lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Metadata must be a regular, non-symlink file')
    if (canceled) throw new Error('Metadata read timed out')
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Metadata must be a regular file')
      if (stat.size > maxBytes) throw new Error(`Metadata size exceeds ${maxBytes} byte limit`)
      const chunks = []
      let total = 0
      while (!canceled && total <= maxBytes) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total))
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, null)
        if (!bytesRead) return Buffer.concat(chunks, total).toString('utf8')
        total += bytesRead
        if (total > maxBytes) throw new Error(`Metadata size exceeds ${maxBytes} byte limit`)
        chunks.push(chunk.subarray(0, bytesRead))
      }
      throw new Error('Metadata read timed out')
    } finally { await handle.close().catch(() => {}) }
  })()
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {canceled = true; reject(new Error('Metadata read timed out'))}, timeoutMs)
  })
  try { return await Promise.race([operation, timeout]) }
  finally { clearTimeout(timer) }
}
