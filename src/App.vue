<script setup>
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import TabStrip from './components/TabStrip.vue'
import Editor from './components/Editor.vue'
import OutputPane from './components/OutputPane.vue'
import StatusBar from './components/StatusBar.vue'
import SshModal from './components/SshModal.vue'
import RuntimeSettingsModal from './components/RuntimeSettingsModal.vue'
import Toast from './components/Toast.vue'
import { useToast } from '@/composables/useToast.js'

const { showToast } = useToast()

const STARTER_BUFFER = '$numbers = [1, 2, 3, 4, 5];\narray_sum($numbers);'
const STARTER_BUFFER_JS = `const nums = [1, 2, 3, 4, 5];
nums.reduce((sum, n) => sum + n, 0);`
const LARAVEL_EXAMPLE = `// Laravel is booted — facades, Eloquent, container all available
// Try one of these:
// App\\Models\\User::count();
// config('app.name');
// DB::table('users')->limit(5)->get();
// cache()->remember('demo', 60, fn() => now()->toDateTimeString());
config('app.name');`

function defaultBufferFor(language) {
  return language === 'js' ? STARTER_BUFFER_JS : STARTER_BUFFER
}

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const tabs = ref([])
const activeTabId = ref(null)
const tabsLoaded = ref(false)

const phpVersion = ref(null)
const phpError = ref(null)
const phpRuntimeInfo = ref(null)
const nodeVersion = ref(null)
const nodeError = ref(null)
const recentProjects = ref([])
const scanningByPath = ref({}) // projectPath -> bool

const sshConnections = ref([])
const sshModalOpen = ref(false)
const runtimeSettingsOpen = ref(false)
let workspaceInitialized = false

const editorRef = ref(null)

const editorPct = ref(60)
const splitRoot = ref(null)
const isDragging = ref(false)

const activeTab = computed(() =>
  tabs.value.find((t) => t.id === activeTabId.value) || null
)

const activeProject = computed(() => activeTab.value?.project || null)
const activeLanguage = computed(() => activeTab.value?.language || 'php')
const activeRunning = computed(() => !!activeTab.value?.running)
const activeStdout = computed(() => activeTab.value?.stdout || '')
const activeStderr = computed(() => activeTab.value?.stderr || '')
const activeLastResult = computed(() => activeTab.value?.lastResult || null)
const activeClassCache = computed(() => activeTab.value?.classCache || null)
const activeScanning = computed(() =>
  !!(activeTab.value?.projectPath && scanningByPath.value[activeTab.value.projectPath])
)

const connectionById = computed(() => {
  const map = new Map()
  for (const c of sshConnections.value) map.set(c.id, c)
  return map
})

function lookupConnection(id) {
  return id ? (connectionById.value.get(id) || null) : null
}

const activeSshConnection = computed(() => lookupConnection(activeTab.value?.sshConnectionId))

const viewTabs = computed(() =>
  tabs.value.map((t) => ({
    ...t,
    sshConnection: lookupConnection(t.sshConnectionId),
  }))
)

let unsubStdout = null
let unsubStderr = null
let unsubJsStdout = null
let unsubJsStderr = null
let unsubWarning = null
let unsubScanProgress = null

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function persistableTabs() {
  return tabs.value.map((t) => ({
    id: t.id,
    title: t.title || '',
    buffer: t.buffer || '',
    projectPath: t.projectPath || null,
    sshConnectionId: t.sshConnectionId || null,
    titleIsCustom: !!t.titleIsCustom,
    language: t.language === 'js' ? 'js' : 'php',
  }))
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

const persistTabs = debounce(() => {
  if (!tabsLoaded.value) return
  window.api.store.setTabs(persistableTabs())
  if (activeTabId.value) window.api.store.setActiveTabId(activeTabId.value)
}, 500)

watch(
  () => persistableTabs(),
  () => persistTabs(),
  { deep: true }
)

watch(activeTabId, () => persistTabs())

/* ------------------------------------------------------------------ */
/* Tab helpers                                                        */
/* ------------------------------------------------------------------ */

function newTabObject({ buffer = '', projectPath = null, title = '', sshConnectionId = null, language = 'php' } = {}) {
  return {
    id: crypto.randomUUID(),
    title,
    buffer,
    projectPath,
    sshConnectionId,
    titleIsCustom: false,
    language,
    project: null,
    classCache: null,
    stdout: '',
    stderr: '',
    lastResult: null,
    running: false,
  }
}

async function resolveProjectFor(tabId) {
  const t = tabs.value.find((x) => x.id === tabId)
  if (!t) return
  if (!t.projectPath) {
    t.project = null
    t.classCache = null
    return
  }
  const ctx = await window.api.project.resolve(t.projectPath)
  if (ctx.invalidPath || !ctx.projectPath) {
    showToast(`Project no longer found: ${t.projectPath}`, 'warning')
    t.projectPath = null
    t.project = null
    t.classCache = null
    return
  }
  t.project = {
    name: ctx.name,
    path: ctx.projectPath,
    mode: ctx.mode,
    isLaravel: ctx.isLaravel,
    laravelVersion: ctx.laravelVersion,
    hasPackageJson: ctx.hasPackageJson,
    nodeProjectName: ctx.nodeProjectName,
  }
  t.classCache = await window.api.classes.get(t.projectPath)
}

async function ensureScanFor(tabId, { silent = true } = {}) {
  const t = tabs.value.find((x) => x.id === tabId)
  if (!t) return

  // Remote (SSH) tab — scan classes on the remote host.
  if (t.sshConnectionId) {
    const conn = lookupConnection(t.sshConnectionId)
    if (!conn?.projectPath) return
    try {
      const scan = await window.api.classes.ensureRemote(t.sshConnectionId, { silent })
      if (scan) {
        for (const x of tabs.value) {
          if (x.sshConnectionId === t.sshConnectionId) x.classCache = scan
        }
      }
    } catch {
      // non-fatal — completion just doesn't have classes
    }
    return
  }

  if (!t.projectPath) return
  try {
    const scan = await window.api.classes.ensure(t.projectPath)
    if (scan) {
      for (const x of tabs.value) {
        if (x.projectPath === t.projectPath) x.classCache = scan
      }
    }
  } catch {
    // non-fatal — completion just doesn't have classes
  }
}

/* ------------------------------------------------------------------ */
/* Tab actions                                                        */
/* ------------------------------------------------------------------ */

async function activateTab(id) {
  if (!id || id === activeTabId.value) return
  activeTabId.value = id
  const t = tabs.value.find((x) => x.id === id)
  if (!t) return
  if (t.projectPath && !t.project) {
    await resolveProjectFor(id)
  }
  if (!t.classCache && (t.projectPath || t.sshConnectionId)) {
    ensureScanFor(id)
  }
}

function newTab() {
  const t = newTabObject({ buffer: '' })
  tabs.value.push(t)
  activateTab(t.id)
}

function closeTab(id) {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return

  const closing = tabs.value[idx]
  if (tabs.value.length === 1) {
    const fresh = newTabObject({ buffer: defaultBufferFor(closing.language || 'php'), language: closing.language || 'php' })
    tabs.value = [fresh]
    activeTabId.value = fresh.id
    return
  }

  const wasActive = closing.id === activeTabId.value
  tabs.value.splice(idx, 1)

  if (wasActive) {
    const nextIdx = idx < tabs.value.length ? idx : idx - 1
    activateTab(tabs.value[nextIdx].id)
  }
}

function renameTab({ id, title }) {
  const t = tabs.value.find((x) => x.id === id)
  if (!t) return
  if (!title || title.trim() === '') {
    t.title = ''
    t.titleIsCustom = false
    return
  }
  t.title = title.trim()
  t.titleIsCustom = true
}

function reorderTabs({ sourceId, targetId }) {
  const from = tabs.value.findIndex((t) => t.id === sourceId)
  const to = tabs.value.findIndex((t) => t.id === targetId)
  if (from === -1 || to === -1 || from === to) return
  const [moved] = tabs.value.splice(from, 1)
  tabs.value.splice(to, 0, moved)
}

function nextTab() {
  if (tabs.value.length < 2) return
  const idx = tabs.value.findIndex((t) => t.id === activeTabId.value)
  const next = tabs.value[(idx + 1) % tabs.value.length]
  activateTab(next.id)
}

function prevTab() {
  if (tabs.value.length < 2) return
  const idx = tabs.value.findIndex((t) => t.id === activeTabId.value)
  const prev = tabs.value[(idx - 1 + tabs.value.length) % tabs.value.length]
  activateTab(prev.id)
}

function jumpToTab(n) {
  const t = tabs.value[n - 1]
  if (t) activateTab(t.id)
}

/* ------------------------------------------------------------------ */
/* Editor binding                                                     */
/* ------------------------------------------------------------------ */

function onEditorChange({ tabId, value }) {
  const t = tabs.value.find((x) => x.id === tabId)
  if (!t) return
  if (t.buffer === value) return
  t.buffer = value
}

/* ------------------------------------------------------------------ */
/* Project actions — operate on the active tab only                   */
/* ------------------------------------------------------------------ */

async function setActiveProject(p) {
  const tab = activeTab.value
  if (!tab) return
  const v = await window.api.project.validate(p)
  if (!v.valid) {
    showToast(
      v.error?.includes('autoload')
        ? 'Not a composer project: vendor/autoload.php not found. Run composer install first.'
        : `Cannot load project: ${v.error || 'unknown error'}`,
      'warning'
    )
    return
  }
  tab.projectPath = p
  tab.classCache = null
  await window.api.store.addRecentProject(p)
  await refreshRecent()
  await resolveProjectFor(tab.id)
  ensureScanFor(tab.id)
}

async function onPickProject() {
  const picked = await window.api.project.pickFolder()
  if (!picked) return
  await setActiveProject(picked)
}

async function onRescan() {
  const tab = activeTab.value
  if (!tab?.projectPath) return
  const path = tab.projectPath
  scanningByPath.value = { ...scanningByPath.value, [path]: true }
  showToast('Re-indexing classes…', 'info')
  try {
    const scan = await window.api.classes.rescan(path)
    if (scan) {
      for (const x of tabs.value) {
        if (x.projectPath === path) x.classCache = scan
      }
      showToast(`Indexed ${scan.count.toLocaleString()} classes`, 'info')
    }
  } catch (err) {
    showToast(`Rescan failed: ${String(err)}`, 'error')
  } finally {
    const next = { ...scanningByPath.value }
    delete next[path]
    scanningByPath.value = next
  }
}

async function refreshRecent() {
  recentProjects.value = await window.api.store.getRecentProjects()
}

function onInsertExample() {
  if (!activeTab.value) return
  const proceed = window.confirm('Replace current buffer with the Laravel example snippet?')
  if (!proceed) return
  editorRef.value?.setBufferForTab(activeTabId.value, LARAVEL_EXAMPLE)
}

/* ------------------------------------------------------------------ */
/* SSH connection management                                          */
/* ------------------------------------------------------------------ */

async function refreshSshConnections() {
  sshConnections.value = (await window.api.ssh.list()) || []
}

function openSshModal() {
  sshModalOpen.value = true
}

function closeSshModal() {
  sshModalOpen.value = false
}

function openRuntimeSettings() {
  runtimeSettingsOpen.value = true
}

function closeRuntimeSettings() {
  runtimeSettingsOpen.value = false
}

async function invokeRuntime(action, callback) {
  try {
    const result = await action()
    if (result?.ok) {
      phpRuntimeInfo.value = result
      phpVersion.value = result.version
      phpError.value = null
    } else if (!result?.cancelled) {
      phpRuntimeInfo.value = result
      phpVersion.value = null
      phpError.value = result?.error || 'PHP not found'
    }
    callback?.(result)
  } catch (error) {
    const result = {
      ok: false,
      path: null,
      version: null,
      error: error?.message || String(error),
    }
    phpRuntimeInfo.value = result
    phpVersion.value = null
    phpError.value = result.error
    callback?.(result)
  }
}

function onRuntimeSave(path, callback) {
  invokeRuntime(() => window.api.runtime.setPhpPath(path), callback)
}

function onRuntimeDetect(callback) {
  invokeRuntime(() => window.api.runtime.detectPhp(), callback)
}

function onRuntimeBrowse(callback) {
  invokeRuntime(() => window.api.runtime.pickPhp(), callback)
}

async function onSshSave(draft, callback) {
  try {
    const result = await window.api.ssh.save(draft)
    if (!result?.ok) {
      showToast(`Save failed: ${result?.error || 'unknown error'}`, 'error')
      callback?.(null)
      return
    }
    await refreshSshConnections()
    for (const tab of tabs.value) {
      if (tab.sshConnectionId === result.connection.id) tab.classCache = null
    }
    if (activeTab.value?.sshConnectionId === result.connection.id) {
      ensureScanFor(activeTab.value.id)
    }
    showToast(`Saved "${result.connection.name}"`, 'info')
    callback?.(result.connection)
  } catch (err) {
    showToast(`Save failed: ${String(err)}`, 'error')
    callback?.(null)
  }
}

async function onSshTest(draft, callback) {
  try {
    const result = await window.api.ssh.test(draft)
    callback?.(result)
  } catch (err) {
    callback?.({ ok: false, error: String(err) })
  }
}

async function onSshDelete(id) {
  try {
    await window.api.ssh.remove(id)
    await refreshSshConnections()
    // If the active tab pointed at this connection, drop the link.
    for (const t of tabs.value) {
      if (t.sshConnectionId === id) t.sshConnectionId = null
    }
    showToast('Connection deleted', 'info')
  } catch (err) {
    showToast(`Delete failed: ${String(err)}`, 'error')
  }
}

function onSshConnect(connectionId) {
  const tab = activeTab.value
  if (!tab) return
  tab.sshConnectionId = connectionId
  tab.classCache = null
  const c = lookupConnection(connectionId)
  if (c) showToast(`Connected to ${c.name || c.host}`, 'info')
  // User-initiated connect — surface scan failures so they know autocomplete
  // won't be available if the remote scanner couldn't run.
  ensureScanFor(tab.id, { silent: false })
}

function onSshDisconnect() {
  const tab = activeTab.value
  if (!tab) return
  tab.sshConnectionId = null
  tab.classCache = null
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

async function runCode() {
  const tab = activeTab.value
  if (!tab || tab.running) return
  if (tab.language !== 'js' && !tab.sshConnectionId && !phpRuntimeInfo.value?.ok) {
    showToast('Configure a local PHP executable before running PHP code', 'warning')
    openRuntimeSettings()
    return
  }
  await runTab(tab.id)
}

async function runTab(tabId) {
  const tab = tabs.value.find((t) => t.id === tabId)
  if (!tab || tab.running) return

  if (tab.sshConnectionId && !lookupConnection(tab.sshConnectionId)) {
    showToast('SSH connection no longer exists', 'warning')
    tab.sshConnectionId = null
  }

  tab.running = true
  tab.stdout = ''
  tab.stderr = ''
  tab.lastResult = null
  const language = tab.language === 'js' ? 'js' : 'php'
  try {
    let result
    if (language === 'js') {
      result = await window.api.runJs(tab.buffer, {
        tabId,
        projectPath: tab.projectPath || null,
      })
    } else {
      result = await window.api.runPhp(tab.buffer, {
        tabId,
        projectPath: tab.projectPath || null,
        sshConnectionId: tab.sshConnectionId || null,
      })
    }
    tab.lastResult = { ...result, language }
    if (language === 'php' && !tab.sshConnectionId && tab.projectPath) await resolveProjectFor(tab.id)
  } catch (err) {
    tab.lastResult = {
      stdout: '', stderr: String(err),
      exitCode: -1, durationMs: 0, timedOut: false, mode: 'raw',
      remote: !!tab.sshConnectionId,
      language,
    }
  } finally {
    tab.running = false
  }
}

async function loadRuntimeVersions() {
  const [phpInfo, nodeInfo] = await Promise.all([
    window.api.runtime.getPhp().catch((err) => ({ ok: false, error: err?.message || String(err) })),
    window.api.getNodeVersion().catch((err) => ({ error: err?.message || String(err) })),
  ])

  phpRuntimeInfo.value = phpInfo
  phpVersion.value = phpInfo.version || null
  phpError.value = phpInfo.version ? null : (phpInfo.error || 'PHP not found')

  nodeVersion.value = nodeInfo.version || null
  nodeError.value = nodeInfo.version ? null : (nodeInfo.error || 'Node not found')
}

async function initializeWorkspace() {
  if (workspaceInitialized) return
  workspaceInitialized = true

  await loadRuntimeVersions()
  if (!phpRuntimeInfo.value?.ok) runtimeSettingsOpen.value = true
  await refreshSshConnections()

  const loadedTabs = await window.api.store.getTabs()
  const loadedActive = await window.api.store.getActiveTabId()
  tabs.value = loadedTabs.map((t) =>
    Object.assign(newTabObject(), {
      id: t.id,
      title: t.title || '',
      buffer: t.buffer || '',
      projectPath: t.projectPath || null,
      sshConnectionId: t.sshConnectionId || null,
      titleIsCustom: !!t.titleIsCustom,
      language: t.language === 'js' ? 'js' : 'php',
    })
  )
  activeTabId.value =
    loadedActive && tabs.value.some((t) => t.id === loadedActive)
      ? loadedActive
      : tabs.value[0]?.id || null

  await refreshRecent()
  tabsLoaded.value = true
  await nextTick()

  if (activeTabId.value) {
    await resolveProjectFor(activeTabId.value)
    ensureScanFor(activeTabId.value)
  }

  setTimeout(async () => {
    for (const t of tabs.value) {
      if (t.id === activeTabId.value) continue
      if (t.projectPath) await resolveProjectFor(t.id)
      if (t.projectPath || t.sshConnectionId) await ensureScanFor(t.id)
    }
  }, 500)
}

function changeActiveLanguage(lang) {
  const tab = activeTab.value
  if (!tab) return
  if (lang !== 'php' && lang !== 'js') return
  if (tab.language === lang) return

  // Auto-swap the snippet only if the buffer is exactly the other language's
  // default — preserves any custom code the user has typed.
  const otherDefault = lang === 'js' ? STARTER_BUFFER : STARTER_BUFFER_JS
  const buffer = (tab.buffer || '').trim()
  const matchesOtherDefault = buffer === otherDefault.trim()
  if (matchesOtherDefault || buffer === '') {
    const fresh = defaultBufferFor(lang)
    tab.buffer = fresh
    editorRef.value?.setBufferForTab(tab.id, fresh)
  }
  tab.language = lang
}

/* ------------------------------------------------------------------ */
/* Mount / Unmount                                                    */
/* ------------------------------------------------------------------ */

onMounted(async () => {
  unsubStdout = window.api.onStdout(({ tabId, chunk }) => {
    const t = tabs.value.find((x) => x.id === tabId)
    if (t) t.stdout += chunk
  })
  unsubStderr = window.api.onStderr(({ tabId, chunk }) => {
    const t = tabs.value.find((x) => x.id === tabId)
    if (t) t.stderr += chunk
  })
  unsubJsStdout = window.api.onJsStdout(({ tabId, chunk }) => {
    const t = tabs.value.find((x) => x.id === tabId)
    if (t) t.stdout += chunk
  })
  unsubJsStderr = window.api.onJsStderr(({ tabId, chunk }) => {
    const t = tabs.value.find((x) => x.id === tabId)
    if (t) t.stderr += chunk
  })
  unsubWarning = window.api.onWarning(({ tabId, message }) => {
    showToast(message, 'warning')
    if (tabId) {
      const t = tabs.value.find((x) => x.id === tabId)
      if (t) {
        t.projectPath = null
        t.project = null
        t.classCache = null
      }
    }
  })

  unsubScanProgress = window.api.classes.onScanProgress(async (p) => {
    if (!p.projectPath) return
    if (p.phase === 'reading' || p.phase === 'walking') {
      scanningByPath.value = { ...scanningByPath.value, [p.projectPath]: true }
      return
    }
    if (p.phase === 'error') {
      const next = { ...scanningByPath.value }
      delete next[p.projectPath]
      scanningByPath.value = next
      return
    }
    if (p.phase === 'done') {
      if (!p.silent && p.blockedRoots?.length) {
        showToast('External Composer directories were not indexed. Only files inside the selected project are scanned.', 'warning')
      } else if (!p.silent && p.truncated) {
        showToast('Indexing limits reached; some large files were skipped.', 'warning')
      }
      const next = { ...scanningByPath.value }
      delete next[p.projectPath]
      scanningByPath.value = next
      const cache = await window.api.classes.get(p.projectPath)
      for (const t of tabs.value) {
        if (t.projectPath === p.projectPath) t.classCache = cache
      }
      if (!p.silent && !p.fromCache && !p.blockedRoots?.length && !p.truncated) {
        showToast(`Indexed ${p.count.toLocaleString()} classes`, 'info')
      }
    }
  })

  await initializeWorkspace()
  window.addEventListener('keydown', onGlobalKey)
})

onUnmounted(() => {
  unsubStdout?.()
  unsubStderr?.()
  unsubJsStdout?.()
  unsubJsStderr?.()
  unsubWarning?.()
  unsubScanProgress?.()
  window.removeEventListener('keydown', onGlobalKey)
  stopDrag()
})

function onGlobalKey(e) {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return

  if (e.key.toLowerCase() === 't' && !e.shiftKey) {
    e.preventDefault()
    newTab()
    return
  }
  if (e.key.toLowerCase() === 'w' && !e.shiftKey) {
    e.preventDefault()
    if (activeTabId.value) closeTab(activeTabId.value)
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    if (e.shiftKey) prevTab()
    else nextTab()
    return
  }
  if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
    e.preventDefault()
    jumpToTab(parseInt(e.key, 10))
  }
}

/* ------------------------------------------------------------------ */
/* Split-pane drag                                                    */
/* ------------------------------------------------------------------ */

let rafPending = false
let pendingClientX = 0

function onDragMove(e) {
  pendingClientX = e.clientX
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    if (!splitRoot.value) return
    const rect = splitRoot.value.getBoundingClientRect()
    const pct = ((pendingClientX - rect.left) / rect.width) * 100
    editorPct.value = Math.min(85, Math.max(20, pct))
  })
}

function startDrag(e) {
  e.preventDefault()
  isDragging.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', stopDrag)
}

function stopDrag() {
  if (!isDragging.value) return
  isDragging.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDrag)
}
</script>

<template>
  <div class="flex h-full w-full flex-col bg-[var(--bg-primary)]">
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        :ssh-connected="!!activeSshConnection"
        @pick-project="onPickProject"
        @open-ssh="openSshModal"
        @open-settings="openRuntimeSettings"
      />

      <div class="flex min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
        <TopBar
          :running="activeRunning"
          :ssh-connection="activeSshConnection"
          :language="activeLanguage"
          :runtime-available="!!phpRuntimeInfo?.ok"
          @run="runCode"
          @change-language="changeActiveLanguage"
        >
          <TabStrip
            :tabs="viewTabs"
            :active-tab-id="activeTabId"
            @activate="activateTab"
            @close="closeTab"
            @new-tab="newTab"
            @rename="renameTab"
            @reorder="reorderTabs"
          />
        </TopBar>

        <div ref="splitRoot" class="flex min-h-0 flex-1 overflow-hidden">
          <div
            class="my-2 ml-2 h-full min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-secondary)]"
            :style="{ width: editorPct + '%' }"
          >
            <Editor
              v-if="tabsLoaded"
              ref="editorRef"
              :tabs="tabs"
              :active-tab-id="activeTabId"
              :class-cache-ref="activeClassCache"
              @change="onEditorChange"
              @run="runCode"
            />
          </div>

          <div
            class="relative my-2 basis-1 cursor-col-resize bg-transparent transition-colors hover:bg-orange-500/25"
            :class="{ 'bg-[var(--accent)]': isDragging }"
            @mousedown="startDrag"
          />

          <div class="my-2 mr-2 h-full min-w-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-secondary)]">
            <OutputPane
              :stdout="activeStdout"
              :stderr="activeStderr"
              :running="activeRunning"
            />
          </div>
        </div>

        <StatusBar
          :php-version="phpVersion"
          :php-error="phpError"
          :node-version="nodeVersion"
          :node-error="nodeError"
          :language="activeLanguage"
          :current-project="activeProject"
          :ssh-connection="activeSshConnection"
          :class-cache="activeClassCache"
          :scanning="activeScanning"
          :running="activeRunning"
          :last-result="activeLastResult"
          @configure-runtime="openRuntimeSettings"
        />
      </div>
    </div>

    <SshModal
      :open="sshModalOpen"
      :connections="sshConnections"
      :active-connection-id="activeTab?.sshConnectionId || null"
      @close="closeSshModal"
      @connect="onSshConnect"
      @disconnect="onSshDisconnect"
      @save="onSshSave"
      @delete="onSshDelete"
      @test="onSshTest"
    />

    <RuntimeSettingsModal
      :open="runtimeSettingsOpen"
      :php-info="phpRuntimeInfo"
      @close="closeRuntimeSettings"
      @save="onRuntimeSave"
      @detect="onRuntimeDetect"
      @browse="onRuntimeBrowse"
    />

    <Toast />
  </div>
</template>
