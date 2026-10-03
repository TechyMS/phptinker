export async function waitForJavaScriptWorker(getWorker, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try { return await getWorker() } catch (error) {
      // Monaco activates the language asynchronously after model creation.
      // Retry only that startup state; real worker failures must remain visible.
      if (String(error) !== 'JavaScript not registered!' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
}
