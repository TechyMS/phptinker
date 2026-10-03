<script setup>
import { computed, nextTick, ref } from 'vue'

const props = defineProps({
  // Each tab: { id, title, projectPath, project, titleIsCustom, running }
  tabs: { type: Array, required: true },
  activeTabId: { type: String, default: null },
})

const emit = defineEmits([
  'activate',
  'close',
  'new-tab',
  'rename',
  'reorder',
])

const editingId = ref(null)
const editingValue = ref('')
const dragId = ref(null)
const dragOverId = ref(null)

const displayTitles = computed(() => {
  // Auto-derive titles, then disambiguate duplicates by appending " 2", " 3", etc.
  const raw = props.tabs.map((t) => deriveTitle(t))
  const seen = new Map()
  return raw.map((title, i) => {
    if (props.tabs[i].titleIsCustom && props.tabs[i].title) {
      return props.tabs[i].title
    }
    const count = (seen.get(title) || 0) + 1
    seen.set(title, count)
    return count === 1 ? title : `${title} ${count}`
  })
})

function deriveTitle(t) {
  if (t.titleIsCustom && t.title) return t.title
  if (t.sshConnection) return t.sshConnection.name || t.sshConnection.host
  if (t.project?.name) return t.project.name
  return 'Untitled'
}

function modeClass(t) {
  if (t.running) return 'running'
  if (t.sshConnection) return 'remote'
  return t.project?.mode || 'raw'
}

function tabClass(t) {
  const active = t.id === props.activeTabId
  return [
    active
      ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--hairline)]'
      : 'text-[var(--text-faint)] hover:bg-[var(--hover)] hover:text-[var(--text-primary)]',
    dragId.value === t.id ? 'opacity-50' : '',
    dragOverId.value === t.id ? 'bg-[var(--accent-soft)]' : '',
  ]
}

function dotClass(t) {
  const mode = modeClass(t)
  return {
    laravel: 'bg-[var(--laravel)] shadow-[0_0_6px_rgba(255,45,32,0.55)]',
    composer: 'bg-[#9aa0a6]',
    raw: 'bg-[#4a4a4a]',
    remote: 'bg-[var(--success)] shadow-[0_0_6px_rgba(16,185,129,0.5)]',
    running: 'animate-pulse bg-[var(--accent)] shadow-[0_0_8px_rgba(249,115,22,0.7)]',
  }[mode] || 'bg-[#6b6b6b]'
}

function tabTitle(t) {
  if (t.sshConnection) {
    const c = t.sshConnection
    const user = c.user ? `${c.user}@` : ''
    return `${user}${c.host}:${c.port || 22}`
  }
  return t.project?.path || ''
}

function onTabClick(id) {
  if (editingId.value) return
  emit('activate', id)
}

function onTabClose(e, id) {
  e.stopPropagation()
  emit('close', id)
}

function onTabDoubleClick(t, idx) {
  editingId.value = t.id
  editingValue.value = displayTitles.value[idx]
  nextTick(() => {
    const el = document.getElementById(`tab-input-${t.id}`)
    if (el) {
      el.focus()
      el.select()
    }
  })
}

function commitRename(id) {
  if (!editingId.value) return
  const value = editingValue.value.trim()
  emit('rename', { id, title: value })
  editingId.value = null
  editingValue.value = ''
}

function cancelRename() {
  editingId.value = null
  editingValue.value = ''
}

function onDragStart(e, id) {
  dragId.value = id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', id)
}

function onDragOver(e, id) {
  e.preventDefault()
  if (id !== dragId.value) dragOverId.value = id
}

function onDragLeave(id) {
  if (dragOverId.value === id) dragOverId.value = null
}

function onDrop(e, targetId) {
  e.preventDefault()
  const sourceId = dragId.value
  dragId.value = null
  dragOverId.value = null
  if (!sourceId || sourceId === targetId) return
  emit('reorder', { sourceId, targetId })
}

function onDragEnd() {
  dragId.value = null
  dragOverId.value = null
}
</script>

<template>
  <div class="no-select flex h-full min-w-0 flex-1 items-stretch">
    <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        v-for="(t, i) in tabs"
        :key="t.id"
        class="group relative mr-0.5 inline-flex h-7 min-w-[110px] max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 self-center rounded-[var(--radius-md)] py-0 pr-2 pl-[11px] text-xs transition-colors"
        :class="tabClass(t)"
        :draggable="editingId !== t.id"
        :title="tabTitle(t)"
        @click="onTabClick(t.id)"
        @dblclick="onTabDoubleClick(t, i)"
        @dragstart="(e) => onDragStart(e, t.id)"
        @dragover="(e) => onDragOver(e, t.id)"
        @dragleave="() => onDragLeave(t.id)"
        @drop="(e) => onDrop(e, t.id)"
        @dragend="onDragEnd"
      >
        <span
          class="h-[7px] w-[7px] shrink-0 rounded-full"
          :class="dotClass(t)"
        :title="t.running ? 'Running' : (t.sshConnection ? 'ssh' : (t.project?.mode || 'raw'))"
        />
        <span
          v-if="t.id === activeTabId"
          class="absolute right-2 bottom-[-1px] left-2 h-0.5 rounded-t-sm bg-[var(--accent)]"
          aria-hidden="true"
        />

        <input
          v-if="editingId === t.id"
          :id="`tab-input-${t.id}`"
          v-model="editingValue"
          class="min-w-0 flex-1 rounded-[3px] border border-[var(--accent)] bg-transparent px-1 py-px text-[var(--text-primary)] outline-none [font:inherit]"
          spellcheck="false"
          @click.stop
          @blur="commitRename(t.id)"
          @keydown.enter="commitRename(t.id)"
          @keydown.escape="cancelRename"
        />
        <span v-else class="min-w-0 flex-1 truncate whitespace-nowrap">{{ displayTitles[i] }}</span>

        <button
          v-if="editingId !== t.id"
          class="h-4 w-4 shrink-0 rounded-[3px] bg-transparent text-sm leading-[14px] text-[var(--text-faint)] opacity-0 transition group-hover:opacity-70 hover:bg-white/10 hover:text-[var(--text-primary)] hover:opacity-100"
          :class="{ 'opacity-70': t.id === activeTabId }"
          aria-label="Close tab"
          @click="(e) => onTabClose(e, t.id)"
        >×</button>
      </div>

      <button
        class="ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-[var(--radius-sm)] bg-transparent text-[var(--text-faint)] hover:bg-[var(--hover)] hover:text-[var(--text-primary)]"
        aria-label="New tab"
        title="New tab (⌘T)"
        @click="emit('new-tab')"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M5 1h2v4h4v2H7v4H5V7H1V5h4z"/>
        </svg>
      </button>
    </div>
  </div>
</template>
