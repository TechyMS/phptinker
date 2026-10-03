<script setup>
import { computed } from 'vue'
import LanguageSwitcher from './LanguageSwitcher.vue'

const props = defineProps({
  running: { type: Boolean, default: false },
  sshConnection: { type: Object, default: null },
  language: { type: String, default: 'php' },
  runtimeAvailable: { type: Boolean, default: true },
})

const emit = defineEmits(['run', 'change-language'])

const isMac = /mac/i.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
)
const shortcut = computed(() => (isMac ? '⌘↵' : 'Ctrl↵'))
const remoteEnabled = computed(() => !!props.sshConnection)
const isJs = computed(() => props.language === 'js')
const runDisabled = computed(() =>
  props.running || (!remoteEnabled.value && !isJs.value && !props.runtimeAvailable)
)
const runTitle = computed(() =>
  !props.running && !remoteEnabled.value && !isJs.value && !props.runtimeAvailable
    ? 'Configure PHP in Runtime Settings before running code'
    : ''
)
const runLabel = computed(() => {
  if (props.running) return 'Running…'
  if (remoteEnabled.value) return 'Run on SSH'
  return 'Run'
})
const runButtonClass = computed(() => {
  const base = 'inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 pl-[9px] text-xs font-medium transition-colors'
  if (props.running) return `${base} bg-[var(--bg-tertiary)] text-[var(--text-secondary)] opacity-80`
  if (remoteEnabled.value) return `${base} bg-[var(--success)] text-white hover:bg-emerald-600`
  if (isJs.value) return `${base} bg-[#f7df1e] text-[#1a1a1a] hover:bg-[#ffe83a]`
  return `${base} bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]`
})
const shortcutClass = computed(() =>
  isJs.value && !props.running && !remoteEnabled.value
    ? 'bg-black/20 text-[#1a1a1a]'
    : 'bg-black/20'
)
</script>

<template>
  <header class="no-select flex h-10 shrink-0 items-stretch border-b border-[var(--hairline)] bg-[var(--bg-topbar)] py-0 pr-1.5 pl-2">
    <div class="flex min-w-0 flex-1 items-stretch"><slot /></div>

    <div class="flex shrink-0 items-center gap-2 py-0 pr-1.5 pl-2.5">
      <LanguageSwitcher
        :language="language"
        @change="(l) => emit('change-language', l)"
      />

      <button
        :class="runButtonClass"
        :disabled="runDisabled"
        :title="runTitle"
        @click="emit('run')"
      >
        <svg
          v-if="!running"
          width="10" height="10" viewBox="0 0 12 12" fill="currentColor"
          aria-hidden="true"
        >
          <path d="M2.5 1.5v9l8-4.5z"/>
        </svg>
        <svg
          v-else
          class="animate-spin"
          width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="M10 6a4 4 0 1 1-2.2-3.58" stroke-linecap="round"/>
        </svg>
        <span>{{ runLabel }}</span>
        <kbd
          class="ml-0.5 rounded-[3px] px-1 py-px font-mono text-[10px] tracking-[0.5px]"
          :class="shortcutClass"
        >{{ shortcut }}</kbd>
      </button>
    </div>
  </header>
</template>
