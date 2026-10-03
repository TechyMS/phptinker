<script setup>
import { useToast } from '@/composables/useToast.js'

const { toasts } = useToast()
</script>

<template>
  <div
    class="pointer-events-none fixed bottom-6 left-1/2 z-[1000] flex max-w-[90vw] -translate-x-1/2 flex-col items-center gap-2"
    role="status"
    aria-live="polite"
  >
    <transition-group
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto max-w-[480px] whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3.5 py-2 font-mono text-[12.5px] text-[var(--text-primary)] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
        :class="{
          'border-[var(--warning)] text-[var(--warning)]': t.variant === 'warning',
          'border-[var(--error)] text-[var(--error)]': t.variant === 'error',
        }"
      >
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>
