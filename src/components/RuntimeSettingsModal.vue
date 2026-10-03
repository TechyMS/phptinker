<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  phpInfo: { type: Object, default: null },
})

const emit = defineEmits(['close', 'save', 'detect', 'browse'])

const phpPath = ref('')
const busy = ref(false)
const message = ref(null)

const canSave = computed(() => !busy.value && phpPath.value.trim().length > 0)
const versionLabel = computed(() => props.phpInfo?.version || null)

function focusPath() {
  nextTick(() => document.getElementById('local-php-path')?.focus())
}

function useResult(result, { closeOnSuccess = false } = {}) {
  if (result?.cancelled) return
  if (result?.ok) {
    phpPath.value = result.path
    message.value = { ok: true, text: result.version || 'PHP path verified' }
    if (closeOnSuccess) emit('close')
    return
  }
  message.value = {
    ok: false,
    text: result?.error || 'Select a working PHP executable',
  }
}

async function invoke(action, payload, options) {
  busy.value = true
  message.value = null
  try {
    const result = await new Promise((resolve) => {
      if (payload === undefined) emit(action, resolve)
      else emit(action, payload, resolve)
    })
    useResult(result, options)
  } finally {
    busy.value = false
  }
}

function save() {
  const value = phpPath.value.trim()
  if (!value) {
    message.value = { ok: false, text: 'PHP path is required' }
    focusPath()
    return
  }
  invoke('save', value, { closeOnSuccess: true })
}

function detect() {
  invoke('detect')
}

function browse() {
  invoke('browse')
}

function onBackdropClick(event) {
  if (event.target === event.currentTarget) emit('close')
}

function onKeydown(event) {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

watch(() => props.open, (open) => {
  if (!open) return
  phpPath.value = props.phpInfo?.path || ''
  message.value = props.phpInfo?.ok
    ? null
    : { ok: false, text: props.phpInfo?.error || 'PHP is not configured' }
  focusPath()
})

watch(() => props.phpInfo?.path, (value) => {
  if (props.open && value) phpPath.value = value
})

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="runtime-backdrop" @mousedown="onBackdropClick">
    <section class="runtime-modal" role="dialog" aria-modal="true" aria-labelledby="runtime-title">
      <header class="runtime-head">
        <div>
          <h2 id="runtime-title">Runtime Settings</h2>
          <p>PHP runs locally on this computer.</p>
        </div>
        <button class="icon-button" aria-label="Close Runtime Settings" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </header>

      <div class="runtime-body">
        <div class="runtime-health" :class="{ ready: phpInfo?.ok }">
          <span class="health-dot" aria-hidden="true" />
          <div>
            <strong>{{ phpInfo?.ok ? 'PHP ready' : 'PHP required' }}</strong>
            <span>{{ versionLabel || 'Choose PHP before running local PHP code.' }}</span>
          </div>
        </div>

        <label for="local-php-path">PHP executable</label>
        <div class="path-row">
          <input
            id="local-php-path"
            v-model="phpPath"
            spellcheck="false"
            autocomplete="off"
            placeholder="Absolute path to php or php.exe"
            :disabled="busy"
            @keydown.enter.prevent="save"
          />
          <button class="secondary" type="button" :disabled="busy" @click="browse">
            Browse…
          </button>
        </div>
        <p class="hint">The path must point to a working PHP CLI executable. It cannot be blank.</p>

        <div v-if="message" class="runtime-message" :class="message.ok ? 'success' : 'error'">
          {{ message.text }}
        </div>
      </div>

      <footer class="runtime-foot">
        <button class="secondary" type="button" :disabled="busy" @click="detect">
          {{ busy ? 'Checking…' : 'Detect automatically' }}
        </button>
        <div class="foot-actions">
          <button class="ghost" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="primary" type="button" :disabled="!canSave" @click="save">Save path</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.runtime-backdrop {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(2px);
}

.runtime-modal {
  width: min(620px, calc(100vw - 48px));
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--bg-secondary);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.58);
}

.runtime-head,
.runtime-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
}

.runtime-head { border-bottom: 1px solid var(--hairline); }
.runtime-foot { border-top: 1px solid var(--hairline); }

h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.runtime-head p {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
}

.icon-button {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-faint);
}
.icon-button:hover { background: var(--hover); color: var(--text-primary); }

.runtime-body { padding: 16px; }

.runtime-health {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid rgba(239, 68, 68, 0.32);
  border-radius: 7px;
  background: rgba(239, 68, 68, 0.06);
}
.runtime-health.ready {
  border-color: rgba(16, 185, 129, 0.34);
  background: rgba(16, 185, 129, 0.07);
}
.health-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--error);
}
.runtime-health.ready .health-dot {
  background: var(--success);
  box-shadow: 0 0 7px rgba(16, 185, 129, 0.5);
}
.runtime-health div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.runtime-health strong { color: var(--text-primary); font-size: 12.5px; font-weight: 600; }
.runtime-health span { color: var(--text-secondary); font-family: var(--mono); font-size: 11px; }

label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-secondary);
  font-size: 11.5px;
}

.path-row { display: flex; gap: 8px; }
.path-row input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg-tertiary);
  padding: 8px 10px;
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 12px;
}
.path-row input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.path-row input:disabled { opacity: 0.65; }

.hint { margin: 6px 0 0; color: var(--text-faint); font-size: 10.5px; }

.runtime-message {
  margin-top: 12px;
  border: 1px solid;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.runtime-message.success {
  border-color: rgba(16, 185, 129, 0.36);
  background: rgba(16, 185, 129, 0.07);
  color: var(--success);
}
.runtime-message.error {
  border-color: rgba(239, 68, 68, 0.36);
  background: rgba(239, 68, 68, 0.07);
  color: var(--error);
}

.foot-actions { display: inline-flex; gap: 6px; }
button.primary,
button.secondary,
button.ghost {
  height: 30px;
  border-radius: 6px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 500;
}
button.primary { background: var(--accent); color: white; }
button.primary:hover:not(:disabled) { background: var(--accent-hover); }
button.secondary {
  border: 1px solid var(--hairline);
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
button.secondary:hover:not(:disabled) { border-color: #3a3a3a; background: #2a2a2a; }
button.ghost { color: var(--text-secondary); }
button.ghost:hover:not(:disabled) { background: var(--hover); color: var(--text-primary); }
button:disabled { opacity: 0.5; }
</style>
