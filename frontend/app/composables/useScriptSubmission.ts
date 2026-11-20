import { ref } from 'vue'

export function useScriptSubmission() {
  const submitting = ref(false)
  let pending: { key: string; id: string } | undefined
  return { submitting, submit }

  async function submit<T>(value: object, action: (id: string) => Promise<T>) {
    if (submitting.value) return
    const key = JSON.stringify(value)
    if (pending?.key !== key) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        byte => byte.toString(16).padStart(2, '0')).join('')
      pending = { key, id }
    }
    submitting.value = true
    try {
      const response = await action(pending.id)
      pending = undefined
      return response
    } finally {
      submitting.value = false
    }
  }
}
