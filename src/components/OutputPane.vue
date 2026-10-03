<script setup>
import { computed, nextTick, ref, watch } from 'vue'

// Lightweight tokenizer for the stdout stream — gives the output pane an
// IDE-like feel without pulling in a full parser. We segment the buffer into
// runs (string, number, bool/null, key, default) and let CSS color them.
function tokenizeStdout(text) {
  if (!text) return []
  const out = []
  // Order matters — strings first to swallow content with delimiters in them,
  // then class FQCNs, then primitives, then arrow / collection-index markers,
  // then identifier-style keys (foo: or foo =>).
  const pattern = new RegExp(
    [
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')',          // 1: string
      '((?:[A-Z][A-Za-z0-9_]*\\\\)*[A-Z][A-Za-z0-9_]*)',           // 2: FQCN / class
      '\\b(true|false|null|NULL|TRUE|FALSE)\\b',                   // 3: literal
      '(=>)',                                                      // 4: arrow
      '(#\\d+)',                                                   // 5: collection idx
      '\\b(-?\\d+(?:\\.\\d+)?)\\b',                                // 6: number
      '\\b([A-Za-z_]\\w*)(?=\\s*[:=])',                            // 7: key
    ].join('|'),
    'g'
  )
  let lastIndex = 0
  let m
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: 'plain', text: text.slice(lastIndex, m.index) })
    }
    if (m[1]) out.push({ kind: 'string', text: m[1] })
    else if (m[2]) out.push({ kind: 'class', text: m[2] })
    else if (m[3]) out.push({ kind: 'literal', text: m[3] })
    else if (m[4]) out.push({ kind: 'arrow', text: m[4] })
    else if (m[5]) out.push({ kind: 'index', text: m[5] })
    else if (m[6]) out.push({ kind: 'number', text: m[6] })
    else if (m[7]) out.push({ kind: 'key', text: m[7] })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) {
    out.push({ kind: 'plain', text: text.slice(lastIndex) })
  }
  return out
}

function tokenClass(kind) {
  return {
    plain: 'text-[#d4d4d4]',
    string: 'text-[#ce9178]',
    number: 'text-[#b5cea8]',
    literal: 'text-[#569cd6] italic',
    key: 'text-[#9cdcfe]',
    class: 'font-medium text-[#4ec9b0]',
    arrow: 'text-[#c586c0]',
    index: 'text-[#b180d7]',
  }[kind] || 'text-[#d4d4d4]'
}

const props = defineProps({
  stdout: { type: String, default: '' },
  stderr: { type: String, default: '' },
  running: { type: Boolean, default: false },
})

const isMac = /mac/i.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
)
const shortcut = isMac ? '⌘↵' : 'Ctrl↵'

const scrollEl = ref(null)
const userScrolled = ref(false)

const isEmpty = computed(
  () => !props.stdout && !props.stderr && !props.running
)

const stdoutTokens = computed(() => tokenizeStdout(props.stdout))

function isNearBottom(el) {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function onScroll() {
  if (!scrollEl.value) return
  userScrolled.value = !isNearBottom(scrollEl.value)
}

function scrollToBottom() {
  if (!scrollEl.value) return
  scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

watch(
  () => props.stdout + props.stderr,
  () => {
    if (userScrolled.value) return
    nextTick(scrollToBottom)
  }
)

watch(
  () => props.running,
  (running) => {
    if (running) {
      userScrolled.value = false
      nextTick(scrollToBottom)
    }
  }
)
</script>

<template>
  <div class="flex h-full w-full flex-col overflow-hidden bg-[var(--bg-secondary)]">
    <div
      ref="scrollEl"
      class="flex-1 overflow-auto px-4 py-3.5 select-text"
      :class="{ 'flex items-center justify-center': isEmpty }"
      @scroll="onScroll"
    >
      <div v-if="isEmpty" class="inline-flex items-center gap-2 font-mono text-xs text-[var(--text-faint)]">
        <kbd class="rounded border border-[var(--hairline)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] tracking-[0.5px] text-[var(--text-secondary)]">{{ shortcut }}</kbd>
        <span>to run</span>
      </div>
      <pre v-else class="m-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.55] text-[var(--text-primary)]"><template
          v-if="stdout"
        ><span
          v-for="(t, i) in stdoutTokens"
          :key="i"
          :class="tokenClass(t.kind)"
        >{{ t.text }}</span></template><span
          v-if="stderr"
          class="text-red-400"
        >{{ stderr }}</span></pre>
    </div>
  </div>
</template>
