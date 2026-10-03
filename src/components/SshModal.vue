<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  connections: { type: Array, default: () => [] },
  activeConnectionId: { type: String, default: null },
})

const emit = defineEmits([
  'close',
  'connect',     // (connectionId)
  'disconnect',  // ()
  'save',        // (connection) → resolves to the saved connection (with id)
  'delete',      // (id)
  'test',        // (connection draft) → resolves to { ok, version, error }
])

const view = ref('list') // 'list' | 'form'
const editing = ref(null)  // null = adding, otherwise the connection being edited
const form = ref(blankForm())
const testing = ref(false)
const testResult = ref(null) // { ok, message }
const saving = ref(false)
const formError = ref('')

function blankForm() {
  return {
    id: null,
    name: '',
    host: '',
    user: '',
    port: 22,
    identityFile: '',
    phpPath: 'php',
    projectPath: '',
    mode: 'raw',
  }
}

function openAdd() {
  editing.value = null
  form.value = blankForm()
  formError.value = ''
  testResult.value = null
  view.value = 'form'
  focusFirstField()
}

function openEdit(c) {
  editing.value = c
  form.value = { ...blankForm(), ...c }
  formError.value = ''
  testResult.value = null
  view.value = 'form'
  focusFirstField()
}

function focusFirstField() {
  nextTick(() => {
    const el = document.getElementById('ssh-form-name')
    if (el) el.focus()
  })
}

function backToList() {
  view.value = 'list'
  testResult.value = null
  formError.value = ''
}

function validate() {
  if (!form.value.host.trim()) return 'Host is required'
  if (form.value.host.startsWith('-')) return 'Host cannot start with "-"'
  if (/\s/.test(form.value.host)) return 'Host cannot contain spaces'
  if (!form.value.phpPath.trim()) return 'PHP binary is required'
  if (!form.value.phpPath.startsWith('/') && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(form.value.phpPath)) {
    return 'PHP binary must be an absolute path or a command name without slashes'
  }
  if (form.value.mode !== 'raw' && !form.value.projectPath.trim()) {
    return `Remote project path is required for ${form.value.mode} mode`
  }
  return ''
}

async function onSave({ thenConnect = false } = {}) {
  const err = validate()
  if (err) {
    formError.value = err
    return
  }
  saving.value = true
  formError.value = ''
  try {
    const saved = await emit_save(form.value)
    if (!saved) return
    if (thenConnect) {
      emit('connect', saved.id)
      emit('close')
      return
    }
    view.value = 'list'
  } finally {
    saving.value = false
  }
}

// Bridge: emit 'save' and resolve with whatever the parent passes back via prop refresh.
// We just call the prop callback through emit and rely on the parent to refresh `connections`.
async function emit_save(draft) {
  return new Promise((resolve) => {
    emit('save', { ...draft }, (saved) => resolve(saved))
  })
}

async function onTest() {
  testing.value = true
  testResult.value = null
  try {
    await new Promise((resolve) => {
      emit('test', { ...form.value }, (result) => {
        if (result?.ok) {
          testResult.value = { ok: true, message: result.version || 'Connection OK' }
        } else {
          testResult.value = { ok: false, message: result?.error || 'Connection failed' }
        }
        resolve()
      })
    })
  } finally {
    testing.value = false
  }
}

function onDelete(c) {
  if (!c?.id) return
  const proceed = window.confirm(`Delete "${c.name || c.host}"?`)
  if (!proceed) return
  emit('delete', c.id)
}

function onConnect(c) {
  emit('connect', c.id)
  emit('close')
}

function onDisconnect() {
  emit('disconnect')
  emit('close')
}

function onBackdropClick(e) {
  if (e.target === e.currentTarget) emit('close')
}

function onKeydown(e) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    if (view.value === 'form') backToList()
    else emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

watch(() => props.open, (open) => {
  if (open) {
    view.value = props.connections.length === 0 ? 'form' : 'list'
    if (view.value === 'form') {
      editing.value = null
      form.value = blankForm()
      focusFirstField()
    }
    testResult.value = null
    formError.value = ''
  }
})

const isActive = (c) => c.id === props.activeConnectionId
const formTitle = computed(() => editing.value ? 'Edit connection' : 'New SSH connection')
</script>

<template>
  <div v-if="open" class="modal-backdrop" @mousedown="onBackdropClick">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="head">
        <div class="title">
          <span class="title-main">SSH Connections</span>
          <span v-if="view === 'form'" class="title-sub">— {{ formTitle }}</span>
        </div>
        <button class="icon-btn close-btn" aria-label="Close" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M3 3l8 8M11 3l-8 8"/>
          </svg>
        </button>
      </header>

      <!-- LIST VIEW -->
      <div v-if="view === 'list'" class="body">
        <div v-if="connections.length === 0" class="empty">
          <p>No saved SSH connections yet.</p>
          <button class="primary" @click="openAdd">+ Add a connection</button>
        </div>

        <ul v-else class="conn-list">
          <li
            v-for="c in connections"
            :key="c.id"
            class="conn-row"
            :class="{ active: isActive(c) }"
          >
            <button class="conn-main" :title="`${c.user ? c.user + '@' : ''}${c.host}:${c.port}`" @click="onConnect(c)">
              <span class="conn-status" :class="{ on: isActive(c) }" />
              <span class="conn-info">
                <span class="conn-name">
                  {{ c.name || c.host }}
                  <span v-if="isActive(c)" class="badge-active">Connected</span>
                </span>
                <span class="conn-target">
                  {{ c.user ? c.user + '@' : '' }}{{ c.host }}<span class="muted">:{{ c.port }}</span>
                  <span v-if="c.mode !== 'raw'" class="muted"> · {{ c.mode }}</span>
                  <span v-if="c.projectPath" class="muted"> · {{ c.projectPath }}</span>
                </span>
              </span>
            </button>
            <div class="conn-actions">
              <button v-if="isActive(c)" class="ghost" title="Disconnect this tab" @click="onDisconnect">
                Disconnect
              </button>
              <button class="ghost" title="Edit" @click="openEdit(c)">Edit</button>
              <button class="ghost danger" title="Delete" @click="onDelete(c)">Delete</button>
            </div>
          </li>
        </ul>

        <footer v-if="connections.length > 0" class="list-foot">
          <button class="primary" @click="openAdd">+ New connection</button>
        </footer>
      </div>

      <!-- FORM VIEW -->
      <form v-else class="body form" @submit.prevent="onSave({ thenConnect: true })">
        <div class="grid">
          <label class="full">
            <span>Name</span>
            <input id="ssh-form-name" v-model="form.name" placeholder="Production server" spellcheck="false" />
          </label>

          <label class="full">
            <span>Host <em>required</em></span>
            <input v-model="form.host" placeholder="example.com or 1.2.3.4" spellcheck="false" required />
          </label>

          <label>
            <span>User</span>
            <input v-model="form.user" placeholder="deploy" spellcheck="false" />
          </label>

          <label>
            <span>Port</span>
            <input v-model.number="form.port" type="number" min="1" max="65535" />
          </label>

          <label class="full">
            <span>Identity file <em>optional</em></span>
            <input v-model="form.identityFile" placeholder="~/.ssh/id_ed25519" spellcheck="false" />
          </label>

          <label>
            <span>Mode</span>
            <select v-model="form.mode">
              <option value="raw">Raw PHP</option>
              <option value="composer">Composer</option>
              <option value="laravel">Laravel</option>
            </select>
          </label>

          <label>
            <span>PHP binary</span>
            <input v-model="form.phpPath" placeholder="php" spellcheck="false" />
          </label>

          <label class="full">
            <span>Remote project path <em v-if="form.mode !== 'raw'">required for {{ form.mode }}</em></span>
            <input v-model="form.projectPath" placeholder="/var/www/app" spellcheck="false" />
          </label>
        </div>

        <div v-if="formError" class="alert error">{{ formError }}</div>
        <div v-else-if="testResult" class="alert" :class="{ success: testResult.ok, error: !testResult.ok }">
          {{ testResult.message }}
        </div>

        <footer class="form-foot">
          <div class="left">
            <button type="button" class="ghost" :disabled="testing" @click="onTest">
              {{ testing ? 'Testing…' : 'Test connection' }}
            </button>
          </div>
          <div class="right">
            <button type="button" class="ghost" @click="connections.length ? backToList() : emit('close')">
              {{ connections.length ? 'Cancel' : 'Close' }}
            </button>
            <button type="button" class="secondary" :disabled="saving" @click="onSave({ thenConnect: false })">
              Save
            </button>
            <button type="submit" class="primary" :disabled="saving">
              {{ editing ? 'Save & Connect' : 'Save & Connect' }}
            </button>
          </div>
        </footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  width: min(640px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  background: var(--bg-secondary);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hairline);
}
.title {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.title-main {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.title-sub {
  font-size: 12px;
  color: var(--text-faint);
}
.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}
.icon-btn:hover { color: var(--text-primary); background: var(--hover); }

.body {
  padding: 12px 16px 16px;
  overflow-y: auto;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 40px 16px;
  color: var(--text-faint);
}

.conn-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.conn-row {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--bg-tertiary);
  overflow: hidden;
  transition: border-color 120ms ease, background 120ms ease;
}
.conn-row:hover { border-color: #3a3a3a; }
.conn-row.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.conn-main {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  text-align: left;
  min-width: 0;
  background: transparent;
}

.conn-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #555;
  flex-shrink: 0;
}
.conn-status.on {
  background: var(--success);
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.55);
}

.conn-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.conn-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.conn-target {
  font-size: 11.5px;
  font-family: var(--mono);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.muted { color: var(--text-faint); }

.badge-active {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.16);
  color: var(--success);
}

.conn-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border-left: 1px solid var(--hairline);
}

.list-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* Form */
.form { padding-bottom: 0; }
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.grid .full { grid-column: 1 / -1; }
.grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.grid label > span {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.grid label em {
  font-size: 10px;
  color: var(--text-faint);
  font-style: normal;
}
.grid input,
.grid select {
  background: var(--bg-tertiary);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  padding: 7px 9px;
  color: var(--text-primary);
  font: inherit;
  font-size: 12.5px;
  font-family: var(--mono);
}
.grid input:focus,
.grid select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.alert {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--mono);
  border: 1px solid var(--hairline);
}
.alert.success {
  color: var(--success);
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.08);
}
.alert.error {
  color: var(--error);
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.07);
}

.form-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0 16px;
  margin-top: 8px;
  border-top: 1px solid var(--hairline);
  gap: 8px;
}
.form-foot .right {
  display: inline-flex;
  gap: 6px;
}

button.primary,
button.secondary,
button.ghost {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
}
button.primary {
  background: var(--accent);
  color: #fff;
}
button.primary:hover:not(:disabled) { background: var(--accent-hover); }
button.primary:disabled { opacity: 0.55; }

button.secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--hairline);
}
button.secondary:hover:not(:disabled) { border-color: #3a3a3a; background: #2a2a2a; }

button.ghost {
  background: transparent;
  color: var(--text-secondary);
}
button.ghost:hover:not(:disabled) { background: var(--hover); color: var(--text-primary); }
button.ghost.danger { color: #c97a7a; }
button.ghost.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.08);
  color: var(--error);
}
</style>
