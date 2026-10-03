<script setup>
import { computed } from 'vue'

const props = defineProps({
  phpVersion: { type: String, default: null },
  phpError: { type: String, default: null },
  nodeVersion: { type: String, default: null },
  nodeError: { type: String, default: null },
  language: { type: String, default: 'php' },
  currentProject: { type: Object, default: null },
  sshConnection: { type: Object, default: null },
  classCache: { type: Object, default: null },
  scanning: { type: Boolean, default: false },
  running: { type: Boolean, default: false },
  lastResult: { type: Object, default: null },
})

const emit = defineEmits(['configure-runtime'])

// Toolbar-side runtime label: when JS mode is active show Node, otherwise PHP.
const runtimeLabel = computed(() => {
  if (props.language === 'js') {
    if (!props.nodeVersion) return null
    // node -v outputs e.g. "v20.11.1"
    const v = props.nodeVersion.replace(/^v/, '')
    return `Node ${v}`
  }
  if (!props.phpVersion) return null
  const m = props.phpVersion.match(/PHP\s+([\d.]+)/i)
  return m ? `PHP ${m[1]}` : props.phpVersion
})

const runtimeError = computed(() => {
  if (props.language === 'js') return props.nodeError
  return props.phpError
})

const runtimeMissingLabel = computed(() => {
  return props.language === 'js' ? 'Node not found' : 'PHP not found'
})

const runtimeCheckingLabel = computed(() => {
  return props.language === 'js' ? 'checking Node…' : 'checking PHP…'
})

const lastRunLanguageLabel = computed(() => {
  const lang = props.lastResult?.language
  if (lang === 'js') return 'JS'
  if (lang === 'php') return 'PHP'
  return null
})

const modeLabel = computed(() => {
  if (props.language === 'js') {
    const p = props.currentProject
    if (!p) return 'Node'
    return p.hasPackageJson ? `Node · ${p.nodeProjectName || p.name}` : 'Node'
  }
  if (props.sshConnection) {
    const c = props.sshConnection
    const remoteMode = c.projectPath ? c.mode : 'raw'
    const mode = remoteMode === 'laravel'
      ? 'Laravel'
      : remoteMode === 'composer'
        ? 'Composer'
        : 'Raw'
    return `SSH ${mode}`
  }
  const p = props.currentProject
  if (!p) return null
  if (p.mode === 'laravel') return p.laravelVersion ? `Laravel ${p.laravelVersion}` : 'Laravel'
  return 'Composer'
})

const remoteTarget = computed(() => {
  const c = props.sshConnection
  if (!c?.host) return null
  const target = c.user ? `${c.user}@${c.host}:${c.port || 22}` : `${c.host}:${c.port || 22}`
  return c.name && c.name !== c.host ? `${c.name} (${target})` : target
})

const classesLabel = computed(() => {
  if (props.scanning) return 'indexing classes…'
  const c = props.classCache?.count
  if (typeof c === 'number') return `${c.toLocaleString()} classes`
  return 'no classes'
})

const exitClass = computed(() => {
  if (!props.lastResult) return ''
  if (props.lastResult.timedOut) return 'warning'
  return props.lastResult.exitCode === 0 ? 'success' : 'error'
})
</script>

<template>
  <footer class="no-select flex h-6 shrink-0 items-center justify-between gap-2 border-t border-[var(--hairline)] bg-[var(--bg-statusbar)] px-3 font-mono text-[11px] text-[var(--text-faint)]">
    <div class="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span v-if="runtimeLabel" class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--text-secondary)]">{{ runtimeLabel }}</span>
      <button
        v-else-if="runtimeError"
        class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--error)] hover:underline"
        :title="runtimeError"
        @click="emit('configure-runtime')"
      >{{ runtimeMissingLabel }} — configure</button>
      <span v-else class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--text-faint)]">{{ runtimeCheckingLabel }}</span>

      <span class="opacity-40">·</span>
      <span
        class="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[3px] px-[5px] py-px text-[10px] font-bold tracking-[0.06em]"
        :class="language === 'js' ? 'bg-[#f7df1e]/20 text-[#f7df1e]' : 'bg-orange-500/20 text-[var(--accent)]'"
      >
        {{ language === 'js' ? 'JS' : 'PHP' }}
      </span>

      <template v-if="language === 'js'">
        <template v-if="currentProject">
          <span class="opacity-40">·</span>
          <span class="inline-flex items-center gap-[5px] whitespace-nowrap text-[#d8d8d8]">
            <span class="h-[5px] w-[5px] rounded-full bg-[#f7df1e] shadow-[0_0_4px_rgba(247,223,30,0.55)]" aria-hidden="true" />
            {{ modeLabel }}
          </span>
        </template>
      </template>

      <template v-else-if="sshConnection">
        <span class="opacity-40">·</span>
        <span class="inline-flex items-center gap-[5px] whitespace-nowrap text-[#d8d8d8]">
          <span class="h-[5px] w-[5px] rounded-full bg-[var(--success)] shadow-[0_0_4px_rgba(16,185,129,0.55)]" aria-hidden="true" />
          {{ modeLabel }}
        </span>
        <span v-if="remoteTarget" class="opacity-40">·</span>
        <span v-if="remoteTarget" class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--text-faint)]">{{ remoteTarget }}</span>
      </template>

      <template v-else-if="currentProject">
        <span class="opacity-40">·</span>
        <span
          class="inline-flex items-center gap-[5px] whitespace-nowrap"
          :class="currentProject.mode === 'laravel' ? 'text-[#d8d8d8]' : 'text-[var(--text-secondary)]'"
        >
          <span
            v-if="currentProject.mode === 'laravel'"
            class="h-[5px] w-[5px] rounded-full bg-[var(--laravel)] shadow-[0_0_4px_rgba(255,45,32,0.55)]"
            aria-hidden="true"
          />
          {{ modeLabel }}
        </span>
        <span class="opacity-40">·</span>
        <span class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--text-faint)]">{{ classesLabel }}</span>
      </template>
    </div>

    <div class="inline-flex min-w-0 items-center gap-1.5">
      <template v-if="running">
        <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
        <span class="text-[var(--text-faint)]">Running…</span>
      </template>
      <template v-else-if="lastResult">
        <span v-if="lastRunLanguageLabel" class="inline-flex items-center gap-[5px] whitespace-nowrap text-[var(--text-faint)]">last: {{ lastRunLanguageLabel }}</span>
        <span v-if="lastRunLanguageLabel" class="opacity-40">·</span>
        <span
          class="font-semibold tracking-[0.02em]"
          :class="{
            'text-[var(--success)]': exitClass === 'success',
            'text-[var(--error)]': exitClass === 'error',
            'text-[var(--warning)]': exitClass === 'warning',
          }"
        >
          {{ lastResult.timedOut ? 'Timed out' : `Exit ${lastResult.exitCode}` }}
        </span>
        <span class="opacity-40">·</span>
        <span class="text-[var(--text-faint)]">{{ lastResult.durationMs }}ms</span>
      </template>
      <template v-else>
        <span class="text-[var(--text-faint)]">Ready</span>
      </template>
    </div>
  </footer>
</template>
