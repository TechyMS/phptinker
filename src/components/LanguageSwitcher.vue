<script setup>
const props = defineProps({
  language: { type: String, default: 'php' }, // 'php' | 'js'
})

const emit = defineEmits(['change'])

function pick(lang) {
  if (lang === props.language) return
  emit('change', lang)
}
</script>

<template>
  <div
    class="inline-flex h-6 items-stretch overflow-hidden rounded-full border border-[var(--hairline)] bg-[var(--bg-secondary)] p-0.5"
    role="tablist"
    aria-label="Language"
  >
    <button
      type="button"
      class="inline-flex cursor-pointer appearance-none items-center rounded-full px-[9px] text-[11px] font-semibold tracking-[0.04em] transition-colors"
      :class="language === 'php' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-faint)] hover:text-[var(--text-secondary)]'"
      role="tab"
      :aria-selected="language === 'php'"
      title="Run buffer as PHP"
      @click="pick('php')"
    >PHP</button>
    <button
      type="button"
      class="inline-flex cursor-pointer appearance-none items-center rounded-full px-[9px] text-[11px] font-semibold tracking-[0.04em] transition-colors"
      :class="language === 'js' ? 'bg-[#f7df1e] text-[#1a1a1a]' : 'text-[var(--text-faint)] hover:text-[var(--text-secondary)]'"
      role="tab"
      :aria-selected="language === 'js'"
      title="Run buffer as JavaScript (Node)"
      @click="pick('js')"
    >JS</button>
  </div>
</template>
