<script setup>
const props = defineProps({
  sshConnected: { type: Boolean, default: false },
})

const emit = defineEmits(['pick-project', 'open-ssh', 'open-settings'])
</script>

<template>
  <aside class="no-select flex w-14 shrink-0 flex-col items-center gap-2.5 border-r border-[var(--hairline)] bg-[var(--bg-sidebar)] pt-2.5 pb-3">
    <div class="flex h-9 w-9 items-center justify-center rounded-lg" title="PHP Tinker">
      <img
        src="/logo.png"
        alt=""
        class="h-[26px] w-[26px] drop-shadow-[0_0_8px_rgba(79,91,147,0.4)]"
      />
    </div>

    <div class="flex w-full flex-col items-center gap-1 border-t border-[var(--hairline)] pt-1.5">
      <button
        class="relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-primary)]"
        title="Open project…"
        @click="emit('pick-project')"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 5.5C2.5 4.4 3.4 3.5 4.5 3.5h3l1.5 1.8h6.5c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2v-9.8z"/>
          <path d="M10 9v5M7.5 11.5h5"/>
        </svg>
      </button>

      <button
        class="relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-primary)]"
        :class="{ 'bg-emerald-500/10 text-[var(--success)]': sshConnected }"
        title="SSH connections"
        @click="emit('open-ssh')"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2.5" y="4" width="15" height="9" rx="1.6"/>
          <path d="M5.5 7.5l2 1.5-2 1.5"/>
          <path d="M9 11h4"/>
          <path d="M7 16.5h6"/>
          <path d="M10 13v3.5"/>
        </svg>
        <span
          v-if="sshConnected"
          class="absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-[var(--bg-sidebar)] bg-[var(--success)] shadow-[0_0_6px_rgba(16,185,129,0.7)]"
          aria-hidden="true"
        />
      </button>
    </div>

    <button
      class="relative mt-auto inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-primary)]"
      title="Runtime settings"
      aria-label="Runtime settings"
      @click="emit('open-settings')"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="10" cy="10" r="2.4" />
        <path d="M10 2.7v1.4M10 15.9v1.4M17.3 10h-1.4M4.1 10H2.7M15.2 4.8l-1 1M5.8 14.2l-1 1M15.2 15.2l-1-1M5.8 5.8l-1-1" />
        <circle cx="10" cy="10" r="6" />
      </svg>
    </button>
  </aside>
</template>
