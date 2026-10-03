<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
// Pull in the TypeScript/JavaScript language contribution explicitly. Without
// this, monaco-editor's tree-shaken build may omit JS intellisense (e.g.
// `console.log` suggestions) when only `monaco-editor` is imported.
import 'monaco-editor/language/typescript/monaco.contribution.js'
import {
  createClassCompletionProvider,
  insertUseStatement,
} from '@/editor/classCompletionProvider.js'
import { registerPhpSnippetLanguage } from '@/editor/phpSnippetLanguage.js'

registerPhpSnippetLanguage(monaco)

// Configure JS intellisense: enable lib defaults (DOM + ESNext) and the
// Node-y globals scratchpad users expect (`console`, `process`, `require`).
// `noLib: false` keeps the built-in TS lib types loaded.
if (monaco.typescript?.javascriptDefaults) {
  monaco.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    noLib: false,
    module: monaco.typescript.ModuleKind.CommonJS,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    lib: ['esnext', 'dom'],
  })
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  })
  // Add minimal Node-runtime ambient declarations so common globals like
  // `require`, `process`, and `__dirname` get autocompleted in JS tabs.
  monaco.typescript.javascriptDefaults.addExtraLib(
    `declare var require: (id: string) => any;
declare var module: { exports: any };
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
};
declare function setImmediate(fn: (...a: any[]) => void, ...args: any[]): any;
declare function clearImmediate(handle: any): void;
declare var Buffer: any;
declare var global: any;
`,
    'phptinker-node-globals.d.ts'
  )
}

const props = defineProps({
  // Tabs identity + initial buffer only — model is the source of truth
  // after creation, and we explicitly avoid making it reactive.
  tabs: { type: Array, required: true },
  activeTabId: { type: String, default: null },
  // The provider closure will read whatever's set most recently — i.e. the
  // active tab's project cache. App.vue updates this on tab change.
  classCacheRef: { type: Object, default: null },
})

const emit = defineEmits(['change', 'run'])

const container = ref(null)
let editor = null
let completionDisposable = null
let insertUseCommandId = null

// IMPORTANT: Monaco models live OUTSIDE Vue's reactive tree. Wrapping them
// in ref()/reactive() causes Vue to deeply observe their internals, which
// has both perf and correctness consequences (Monaco mutates model state
// constantly). This Map is module-local, mutated imperatively.
const tabState = new Map() // tabId -> { model, viewState, sub }
let lastActiveId = null

// IDE-style colors for the suggest widget icons + a few editor tokens.
// Token rules are duplicated for `.php` and `.js` so each language's tokens
// pick up explicit colors instead of relying on `inherit: true` from vs-dark
// (which doesn't always cover Monaco's per-language token suffixes).
monaco.editor.defineTheme('phptinker-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // PHP
    { token: 'type.php', foreground: '4EC9B0' },
    { token: 'type.function.php', foreground: '4EC9B0' },
    { token: 'method.php', foreground: 'DCDCAA' },
    { token: 'function.php', foreground: 'DCDCAA' },
    { token: 'property.php', foreground: '9CDCFE' },
    { token: 'variable.php', foreground: '9CDCFE' },
    { token: 'variable.predefined.php', foreground: '9CDCFE', fontStyle: 'italic' },
    { token: 'keyword.php', foreground: 'C586C0' },
    { token: 'constant.php', foreground: '4FC1FF' },
    { token: 'string.php', foreground: 'CE9178' },
    { token: 'string.escape.php', foreground: 'D7BA7D' },
    { token: 'number.php', foreground: 'B5CEA8' },
    { token: 'number.float.php', foreground: 'B5CEA8' },
    { token: 'number.hex.php', foreground: 'B5CEA8' },
    { token: 'number.octal.php', foreground: 'B5CEA8' },
    { token: 'number.binary.php', foreground: 'B5CEA8' },
    { token: 'comment.php', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'identifier.php', foreground: 'D4D4D4' },
    { token: 'delimiter.php', foreground: 'D4D4D4' },
    { token: 'delimiter.bracket.php', foreground: 'D4D4D4' },
    { token: 'delimiter.array.php', foreground: 'D4D4D4' },
    { token: 'delimiter.parenthesis.php', foreground: 'D4D4D4' },

    // JavaScript / TypeScript (Monaco emits both `.js` and `.ts` token kinds)
    { token: 'keyword.js', foreground: 'C586C0' },
    { token: 'keyword.ts', foreground: 'C586C0' },
    { token: 'keyword.flow.js', foreground: 'C586C0' },
    { token: 'keyword.flow.ts', foreground: 'C586C0' },
    { token: 'string.js', foreground: 'CE9178' },
    { token: 'string.ts', foreground: 'CE9178' },
    { token: 'string.escape.js', foreground: 'D7BA7D' },
    { token: 'string.escape.ts', foreground: 'D7BA7D' },
    { token: 'number.js', foreground: 'B5CEA8' },
    { token: 'number.ts', foreground: 'B5CEA8' },
    { token: 'number.hex.js', foreground: 'B5CEA8' },
    { token: 'number.hex.ts', foreground: 'B5CEA8' },
    { token: 'number.float.js', foreground: 'B5CEA8' },
    { token: 'number.float.ts', foreground: 'B5CEA8' },
    { token: 'comment.js', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'comment.ts', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'comment.doc.js', foreground: '608B4E', fontStyle: 'italic' },
    { token: 'comment.doc.ts', foreground: '608B4E', fontStyle: 'italic' },
    { token: 'regexp.js', foreground: 'D16969' },
    { token: 'regexp.ts', foreground: 'D16969' },
    { token: 'type.js', foreground: '4EC9B0' },
    { token: 'type.ts', foreground: '4EC9B0' },
    { token: 'identifier.js', foreground: '9CDCFE' },
    { token: 'identifier.ts', foreground: '9CDCFE' },
    { token: 'delimiter.js', foreground: 'D4D4D4' },
    { token: 'delimiter.ts', foreground: 'D4D4D4' },
    { token: 'delimiter.bracket.js', foreground: 'D4D4D4' },
    { token: 'delimiter.bracket.ts', foreground: 'D4D4D4' },
    { token: 'delimiter.parenthesis.js', foreground: 'D4D4D4' },
    { token: 'delimiter.parenthesis.ts', foreground: 'D4D4D4' },
    { token: 'delimiter.array.js', foreground: 'D4D4D4' },
    { token: 'delimiter.array.ts', foreground: 'D4D4D4' },
  ],
  colors: {
    'editor.background': '#1e1e1e',
    'editor.foreground': '#D4D4D4',
    'editorLineNumber.foreground': '#5a5a5a',
    'editorLineNumber.activeForeground': '#c8c8c8',
    'editorCursor.foreground': '#aeafad',
    'editor.lineHighlightBackground': '#2a2a2a',
    'editor.selectionBackground': '#264f78',
    'editorBracketMatch.background': '#3a3d41',
    'editorBracketMatch.border': '#888888',
    'symbolIcon.classForeground': '#EE9D28',
    'symbolIcon.interfaceForeground': '#75BEFF',
    'symbolIcon.namespaceForeground': '#9CDCFE',
    'symbolIcon.functionForeground': '#B180D7',
    'symbolIcon.methodForeground': '#B180D7',
    'symbolIcon.variableForeground': '#75BEFF',
    'symbolIcon.constantForeground': '#75BEFF',
    'symbolIcon.enumeratorForeground': '#EE9D28',
    'symbolIcon.enumeratorMemberForeground': '#75BEFF',
    'symbolIcon.propertyForeground': '#75BEFF',
    'symbolIcon.keywordForeground': '#C586C0',
  },
})

function languageIdFor(lang) {
  return lang === 'js' ? 'javascript' : 'php-snippet'
}

function ensureModelFor(tab) {
  let entry = tabState.get(tab.id)
  if (entry) {
    const desired = languageIdFor(tab.language)
    const current = entry.model.getLanguageId?.()
    if (current && current !== desired) {
      monaco.editor.setModelLanguage(entry.model, desired)
    }
    return entry
  }
  const model = monaco.editor.createModel(tab.buffer ?? '', languageIdFor(tab.language))
  const sub = model.onDidChangeContent(() => {
    emit('change', { tabId: tab.id, value: model.getValue() })
  })
  entry = { model, viewState: null, sub }
  tabState.set(tab.id, entry)
  return entry
}

function disposeModelFor(tabId) {
  const entry = tabState.get(tabId)
  if (!entry) return
  entry.sub.dispose()
  entry.model.dispose()
  tabState.delete(tabId)
}

function activate(tabId) {
  if (!editor || !tabId) return
  if (tabId === lastActiveId) return

  if (lastActiveId) {
    const prev = tabState.get(lastActiveId)
    if (prev) prev.viewState = editor.saveViewState()
  }

  const tab = props.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const entry = ensureModelFor(tab)
  editor.setModel(entry.model)
  if (entry.viewState) editor.restoreViewState(entry.viewState)
  editor.focus()
  lastActiveId = tabId
}

// Allow App.vue to push a buffer into a specific tab (e.g. "Insert Laravel
// example"). Routes through the model so Monaco's onDidChangeContent fires
// and emits a normal change back up — keeps a single update path.
function setBufferForTab(tabId, value) {
  const tab = props.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const entry = ensureModelFor(tab)
  if (entry.model.getValue() === value) return
  entry.model.setValue(value)
}

defineExpose({ setBufferForTab })

watch(
  () => props.activeTabId,
  (id) => activate(id)
)

// Reconcile on tabs list changes — only need to dispose models for removed
// tabs. New ones are created lazily on first activation.
watch(
  () => props.tabs.map((t) => t.id).join('|'),
  () => {
    const ids = new Set(props.tabs.map((t) => t.id))
    for (const id of Array.from(tabState.keys())) {
      if (!ids.has(id)) disposeModelFor(id)
    }
  }
)

// React to per-tab language changes by switching the Monaco model's
// language in place. Watching the joined signature keeps this O(1) per tick
// regardless of tab count.
watch(
  () => props.tabs.map((t) => `${t.id}:${t.language || 'php'}`).join('|'),
  () => {
    for (const tab of props.tabs) {
      const entry = tabState.get(tab.id)
      if (!entry) continue
      const desired = languageIdFor(tab.language)
      const current = entry.model.getLanguageId?.()
      if (current && current !== desired) {
        monaco.editor.setModelLanguage(entry.model, desired)
      }
    }
  }
)

onMounted(() => {
  editor = monaco.editor.create(container.value, {
    value: '',
    language: 'php-snippet',
    theme: 'phptinker-dark',
    fontFamily: "'JetBrains Mono', 'Menlo', 'Consolas', monospace",
    fontSize: 14,
    fontLigatures: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 16, bottom: 16 },
    lineNumbers: 'on',
    renderLineHighlight: 'line',
    tabSize: 4,
    insertSpaces: true,
    wordWrap: 'on',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
    },
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    emit('run')
  })

  insertUseCommandId = editor.addCommand(0, (_ctx, fqcn) => {
    insertUseStatement(editor, monaco, fqcn)
  })

  // The provider's closure reads classCacheRef on every completion — which
  // tracks whichever tab is active. No re-registration on tab switch.
  const provider = createClassCompletionProvider(
    monaco,
    () => props.classCacheRef,
    insertUseCommandId
  )
  completionDisposable = monaco.languages.registerCompletionItemProvider('php-snippet', provider)

  // First-time activation in case props.activeTabId was set before mount.
  if (props.activeTabId) activate(props.activeTabId)
})

onBeforeUnmount(() => {
  completionDisposable?.dispose()
  completionDisposable = null
  if (editor) {
    editor.dispose()
    editor = null
  }
  for (const id of Array.from(tabState.keys())) disposeModelFor(id)
  lastActiveId = null
})
</script>

<template>
  <div ref="container" class="h-full w-full overflow-hidden bg-[#1e1e1e]" />
</template>

<style scoped>
:deep(.monaco-editor),
:deep(.monaco-editor .overflow-guard) {
  border-radius: inherit;
}
</style>
