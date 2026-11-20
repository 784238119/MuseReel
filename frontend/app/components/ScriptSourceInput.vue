<template>
  <div class="script-source">
    <label>
      {{ t('projectScript.sourceText') }}
      <textarea v-model="text" class="textarea" rows="5" required :placeholder="t('projectScript.sourcePlaceholder')" />
    </label>
    <label>
      {{ t('projectScript.file') }}
      <input type="file" accept=".txt,.md" :disabled="readingFile" @change="readFile" />
    </label>
    <p v-if="tooLarge" class="dim" role="alert">{{ t('novel.errors.source_too_large') }}</p>
    <p v-else-if="loading" class="dim" role="status">{{ t('projectScript.inspecting') }}</p>
    <template v-else-if="detected">
      <details v-if="detected.mode === 'numbered' && !continuous">
        <summary>{{ t('projectScript.detected', { count: detected.episodes.length }) }}</summary>
        <ul>
          <li v-for="episode in detected.episodes" :key="episode.number">
            {{ episode.number }} · {{ episode.title || t('projectScript.untitled') }}
          </li>
        </ul>
      </details>
      <p v-if="detected.mode === 'invalid'" class="dim" role="alert">{{ t('projectScript.invalidAt', { line: detected.line }) }}</p>
      <label v-if="detected.mode !== 'continuous'" class="script-check">
        <input v-model="continuous" type="checkbox" /> {{ t('projectScript.asContinuous') }}
      </label>
    </template>
    <button v-if="failed" type="button" class="btn btn-sm" @click="attempt++">{{ t('novel.reload') }}</button>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { projectScriptAPI } from '~/composables/useApi'

const { t } = useI18n()
const text = defineModel({ type: String, required: true })
const importState = defineModel('state', { type: Object, required: true })
const limit = 5 * 1024 * 1024
const detecting = ref(false)
const readingFile = ref(false)
const detected = ref(null)
const continuous = ref(false)
const failed = ref(false)
const attempt = ref(0)
const tooLarge = computed(() => new TextEncoder().encode(text.value).length > limit)
const loading = computed(() => detecting.value || readingFile.value)

watch([text, attempt], ([value], _, onCleanup) => {
  detected.value = null
  failed.value = false
  continuous.value = false
  detecting.value = !!value.trim() && !tooLarge.value
  if (!detecting.value) return
  let stale = false
  const timer = setTimeout(async () => {
    try {
      const result = await projectScriptAPI.inspect(value)
      if (!stale) detected.value = result
    } catch {
      if (!stale) failed.value = true
    } finally {
      if (!stale) detecting.value = false
    }
  }, 300)
  onCleanup(() => { stale = true; clearTimeout(timer) })
}, { immediate: true })

watch([detected, continuous, loading, text], () => {
  const result = detected.value
  importState.value = {
    ready: !loading.value && !!result && (result.mode !== 'invalid' || continuous.value),
    continuous: continuous.value,
    count: !continuous.value && result?.mode === 'numbered' ? result.episodes.length : null,
  }
}, { immediate: true })

async function readFile(event) {
  const input = event.currentTarget
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > limit) return toast.error(t('novel.errors.source_too_large'))
  readingFile.value = true
  try {
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error('invalid_file')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    if (!value.trim()) throw new Error('invalid_file')
    text.value = value
  } catch {
    toast.error(t('novel.errors.invalid_file'))
  } finally {
    readingFile.value = false
  }
}
</script>

<style scoped>
.script-source, .script-source label { display: grid; gap: 8px; }
.script-source .script-check { display: flex; align-items: center; }
.script-source textarea { resize: vertical; width: 100%; }
.script-source p { margin: 0; }
.script-source details { overflow: auto; max-height: 150px; }
</style>
