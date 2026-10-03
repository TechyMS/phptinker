import { writeFile } from 'node:fs/promises'

// A screenshot is diagnostic output, not an application acceptance check.
// Xvfb/compositor capture can fail even while the renderer and workers work.
export async function saveDiagnosticScreenshot(contents, destination, { timeoutMs = 5000 } = {}) {
  let timer
  const controller = new AbortController()
  try {
    return await Promise.race([
      (async () => {
        const image = await contents.capturePage()
        controller.signal.throwIfAborted()
        await writeFile(destination, image.toPNG(), { signal: controller.signal })
        return { saved: true }
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Diagnostic screenshot timed out'))
          controller.abort()
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
