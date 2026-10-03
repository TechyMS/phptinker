import '../src/editor/monacoWorkers.js'
import Editor from '../src/components/Editor.vue'
import { createApp } from 'vue'
import * as monaco from 'monaco-editor'
import { waitForJavaScriptWorker } from './worker-ready.js'

const container = document.createElement('div')
document.body.append(container)
createApp(Editor, {tabs: [], activeTabId: null}).mount(container)
window.monacoSmoke = (async () => {
  const model = monaco.editor.createModel('process.', 'javascript', monaco.Uri.parse('file:///smoke.js'))
  try {
    const getWorker = await waitForJavaScriptWorker(() => monaco.typescript.getJavaScriptWorker())
    const worker = await getWorker(model.uri)
    const completions = await worker.getCompletionsAtPosition(model.uri.toString(), 8)
    return { names: completions?.entries.map(entry => entry.name) || [] }
  } finally { model.dispose() }
})()
