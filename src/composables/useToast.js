import { reactive } from 'vue'

const toasts = reactive([])
let nextId = 1

const DEFAULT_DURATION_MS = 3000

export function useToast() {
  return {
    toasts,
    showToast(message, variant = 'info', durationMs = DEFAULT_DURATION_MS) {
      const id = nextId++
      const toast = { id, message, variant }
      toasts.push(toast)
      setTimeout(() => {
        const idx = toasts.findIndex((t) => t.id === id)
        if (idx !== -1) toasts.splice(idx, 1)
      }, durationMs)
      return id
    },
    dismissToast(id) {
      const idx = toasts.findIndex((t) => t.id === id)
      if (idx !== -1) toasts.splice(idx, 1)
    },
  }
}
