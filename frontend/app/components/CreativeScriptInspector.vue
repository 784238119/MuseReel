<template>
  <aside class="inspector" :aria-label="t('creativeAgent.projectScript')">
    <header class="inspector-head">
      <h2>{{ t('creativeAgent.projectScript') }}</h2>
      <button type="button" class="icon-action" :aria-label="t('creativeAgent.closeInspector')" @click="$emit('close')"><X :size="17" /></button>
    </header>
    <div class="inspector-select">
      <select :value="resource.change.id" :aria-label="t('creativeAgent.selectChange')" @change="select($event)">
        <option v-for="item in available" :key="item.change.id" :value="item.change.id">{{ changeTitle(item.change) }}</option>
      </select>
      <span class="saved-state"><CircleCheck :size="15" /> {{ t('creativeAgent.saved') }}</span>
    </div>
    <div class="inspector-tabs" role="group" :aria-label="t('creativeAgent.projectScript')">
      <button type="button" :aria-pressed="view === 'script'" @click="view = 'script'">{{ t('creativeAgent.script') }}</button>
      <button type="button" :aria-pressed="view === 'changes'" @click="view = 'changes'">{{ t('creativeAgent.changes') }}</button>
    </div>
    <div class="inspector-body" :aria-busy="loading">
      <p v-if="loading" class="dim" role="status">{{ t('novel.loading') }}</p>
      <div v-else-if="failed" role="alert" class="inspector-failed">
        {{ t('creativeAgent.errors.load_failed') }}
        <button class="btn btn-sm" type="button" @click="load">{{ t('novel.reload') }}</button>
      </div>
      <template v-else-if="view === 'changes' && change">
        <h3>{{ change.scene ? `${change.scene} · ${change.title}` : changeTitle(change) }}</h3>
        <template v-if="change.before !== null">
          <p class="diff-label">{{ t('creativeAgent.before') }}</p>
          <pre class="diff-before">{{ format(change.before) }}</pre>
        </template>
        <p class="diff-label">{{ t('creativeAgent.after') }}</p>
        <pre class="diff-after">{{ format(change.after) || t('creativeAgent.removed') }}</pre>
      </template>
      <pre v-else class="inspector-script">{{ format(script) || t('creativeAgent.emptyScript') }}</pre>
    </div>
    <button v-if="resource.change.kind !== 'novel'" type="button" class="inspector-link"
      @click="$emit('openScript', resource.change.episode_id)">
      {{ t('creativeAgent.openEditor') }} <ArrowUpRight :size="14" />
    </button>
  </aside>
</template>

<script setup lang="ts">
import { ArrowUpRight, CircleCheck, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { creativeAPI, type CreativeChange } from '~/composables/useCreativeAgent'
import { projectScriptAPI } from '~/composables/useApi'

type Resource = { turnId: number; change: CreativeChange }
const props = defineProps<{ projectId: number; resource: Resource; available: Resource[]; refreshKey: number }>()
const emit = defineEmits<{ close: []; select: [resource: Resource]; openScript: [episodeId: number | null] }>()
const { t } = useI18n()
const view = ref<'script' | 'changes'>('changes')
const change = ref<Awaited<ReturnType<typeof creativeAPI.change>> | null>(null)
const script = ref('')
const loading = ref(false)
const failed = ref(false)
let sequence = 0

function changeTitle(item: CreativeChange) {
  if (item.kind === 'outline') return t('projectScript.outline')
  if (item.kind === 'novel') return t('creativeAgent.novelChange', { title: item.title })
  return `${t('projectScript.episode', { n: item.episode_number })} · ${item.title}`
}
function select(event: Event) {
  const id = Number((event.target as HTMLSelectElement).value)
  const item = props.available.find(entry => entry.change.id === id)
  if (item) emit('select', item)
}
function format(text: string | null) {
  if (!text || props.resource.change.kind !== 'outline') return text ?? ''
  try {
    const outline = JSON.parse(text)
    return ['synopsis', 'characters', 'arc'].map(key => `${t(`projectScript.outlineFields.${key}`)}\n${outline[key] ?? ''}`).join('\n\n')
  } catch { return text }
}
async function load() {
  const current = ++sequence
  const selected = props.resource
  loading.value = true
  failed.value = false
  try {
    if (view.value === 'changes' || selected.change.kind === 'novel') {
      const result = await creativeAPI.change(props.projectId, selected.turnId, selected.change.id)
      if (current === sequence) {
        change.value = result
        if (view.value === 'script') script.value = result.after
      }
    } else {
      const episode = selected.change.episode_id
      const result = episode === null ? await projectScriptAPI.get(props.projectId) : await projectScriptAPI.episode(props.projectId, episode)
      if (current === sequence) script.value = episode === null ? JSON.stringify(result.outline) : result.script ?? result.original ?? ''
    }
  } catch { if (current === sequence) failed.value = true }
  finally { if (current === sequence) loading.value = false }
}
watch([() => props.resource.change.id, view, () => view.value === 'script' ? props.refreshKey : 0], load, { immediate: true })
onBeforeUnmount(() => { sequence++ })
</script>

<style scoped>
.inspector { min-width: 0; display: flex; min-height: 0; flex-direction: column; padding: 19px 20px; background: var(--bg-0); border-inline-start: 1px solid var(--border); }
.inspector-head, .inspector-select { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.inspector h2 { font-size: 17px; }
.icon-action, .inspector-tabs button, .inspector-link { border: none; background: transparent; color: var(--text-1); cursor: pointer; }
.icon-action { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; }
.icon-action:hover { background: var(--bg-hover); }
.inspector-select { margin-top: 13px; }
.inspector-select select { min-width: 0; flex: 1; border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px; background: var(--bg-input); color: var(--text-0); font: inherit; }
.saved-state { display: flex; gap: 5px; align-items: center; color: var(--text-2); font-size: 13px; white-space: nowrap; }
.saved-state svg { color: var(--success); }
.inspector-tabs { display: flex; gap: 14px; border-bottom: 1px solid var(--border); margin-top: 12px; }
.inspector-tabs button { padding: 10px; border-bottom: 2px solid transparent; font: inherit; }
.inspector-tabs button[aria-pressed=true] { color: var(--accent-text); border-color: var(--accent); }
.inspector-body { flex: 1; overflow-y: auto; padding-top: 18px; }
.inspector h3 { font-size: 16px; margin-bottom: 14px; }
.diff-label { color: var(--text-2); margin: 13px 0 5px; }
.inspector pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.diff-before, .diff-after { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; }
.diff-before { background: var(--bg-2); }
.diff-after { background: var(--success-bg); }
.inspector-link { margin-top: 14px; display: inline-flex; align-items: center; align-self: start; gap: 5px; text-decoration: underline; }
.inspector-failed { display: grid; gap: 10px; justify-items: start; }
</style>
