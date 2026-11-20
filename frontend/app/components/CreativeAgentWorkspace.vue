<template>
  <section class="creative-workspace" :class="{ 'with-inspector': inspected }" :aria-label="t('creativeAgent.title')">
    <aside class="sessions" :class="{ 'mobile-sessions': showSessions }" :aria-label="t('creativeAgent.sessions')">
      <div class="sessions-head">
        <h2>{{ t('creativeAgent.sessions') }}</h2>
        <button type="button" class="new-session" @click="activate(null)"><Plus :size="17" />{{ t('creativeAgent.newChat') }}</button>
      </div>
      <div class="session-list">
        <div v-for="session in sessions" :key="session.id" class="session-row" :class="{ selected: selected === session.id }">
          <form v-if="renaming === session.id" class="rename" @submit.prevent="saveTitle(session.id)">
            <input v-model="newTitle" maxlength="120" :aria-label="t('creativeAgent.rename')" required @keydown.esc="renaming = null" />
            <button type="submit" :aria-label="t('common.save')"><Check :size="15" /></button>
            <button type="button" :aria-label="t('common.cancel')" @click="renaming = null"><X :size="15" /></button>
          </form>
          <template v-else>
            <button type="button" class="session-title" :title="session.title" :aria-current="selected === session.id ? 'page' : undefined"
              @click="activate(session.id)">{{ session.title }}</button>
            <button type="button" class="rename-button" :title="t('creativeAgent.rename')" :aria-label="t('creativeAgent.rename')"
              @click="renaming = session.id; newTitle = session.title"><Pencil :size="13" /></button>
          </template>
        </div>
        <button v-if="nextSession !== null" type="button" class="history-link" @click="loadMoreSessions">{{ t('creativeAgent.moreSessions') }}</button>
      </div>
    </aside>

    <div class="chat-main">
      <button class="mobile-session-button" type="button" :aria-expanded="showSessions" @click="showSessions = !showSessions">
        <PanelLeft :size="16" /> {{ t('creativeAgent.sessions') }}
      </button>
      <div ref="feed" class="chat-feed" :aria-label="t('novel.chat.history')">
        <div class="chat-column">
          <p v-if="loading" role="status" class="dim">{{ t('novel.loading') }}</p>
          <button v-if="beforeId !== null" type="button" class="history-link" @click="loadPrevious">{{ t('novel.chat.loadEarlier') }}</button>
          <div v-if="!loading && !turns.length" class="chat-empty">
            <img :src="logo" alt="" />
            <h2>{{ t('creativeAgent.title') }}</h2>
            <p>{{ t('creativeAgent.empty') }}</p>
          </div>
          <article v-for="turn in turns" :key="turn.id" class="chat-turn">
            <div class="user-row"><div class="user-message">
              <span class="sr-only">{{ t('novel.chat.you') }}</span>{{ turn.message }}
              <div v-if="turn.references.length" class="user-references">
                <span v-for="item in turn.references" :key="referenceKey(item)"><Link2 :size="12" />{{ referenceLabel(item) }}</span>
              </div>
            </div><UserRound :size="21" class="user-icon" aria-hidden="true" /></div>
            <div class="agent-row">
              <img :src="logo" class="agent-icon" alt="" />
              <div class="agent-content">
                <span class="sr-only">{{ t('creativeAgent.title') }}</span>
                <p v-if="turn.status === 'running' && !timelines.get(turn.id)?.length" class="dim" role="status">{{ t(connected ? 'creativeAgent.working' : 'creativeAgent.reconnecting') }}</p>
                <template v-for="block in timelines.get(turn.id) ?? []" :key="block.seq">
                  <p v-if="block.kind === 'text'" class="reply">{{ block.text }}</p>
                  <details v-else class="tool-step">
                    <summary>
                      <component :is="block.change || isWrite(block.tool) ? FilePenLine : BookOpen" :size="17" />
                      <Circle :size="9" class="tool-marker" aria-hidden="true" />
                      <span class="tool-label">{{ toolLabel(block.tool, block.target?.episode_number) }}</span>
                      <ChevronDown :size="14" class="tool-chevron" />
                      <span class="tool-state" :class="block.state">
                        <CircleCheck v-if="block.state === 'completed'" :size="17" />
                        <CircleAlert v-else-if="block.state === 'failed'" :size="17" />
                        <LoaderCircle v-else-if="turn.status === 'running'" class="spinning" :size="17" />
                        <span>{{ t(toolStatus(block, turn.status)) }}</span>
                      </span>
                    </summary>
                    <div class="tool-details">
                      <span v-if="block.target?.scene">{{ block.target.scene }}</span>
                      <span v-if="block.error">{{ errorLabel(block.error) }}</span>
                      <button v-if="block.change" class="result-link" type="button" @click="inspect(turn.id, block.change)">
                        <FileText :size="15" />{{ t('creativeAgent.changes') }}
                      </button>
                      <button v-else-if="block.state === 'completed' && block.target?.episode_id" class="result-link" type="button"
                        @click="emit('openScript', block.target.episode_id)"><FileText :size="15" />{{ t('creativeAgent.script') }}</button>
                      <span v-else-if="!block.error && !block.target?.scene" class="dim">{{ t(toolStatus(block, turn.status)) }}</span>
                    </div>
                  </details>
                </template>
                <p v-if="!timelines.get(turn.id)?.length && turn.assistant_text" class="reply">{{ turn.assistant_text }}</p>
                <p v-if="turn.status !== 'running' && turn.status !== 'completed'" class="turn-error" role="status">
                  {{ turn.error_code ? errorLabel(turn.error_code) : t('creativeAgent.stopped') }}
                  <span v-if="changesFor(turn.id).length">{{ t('creativeAgent.partial') }}</span>
                </p>
                <div v-if="changesFor(turn.id).length" class="turn-results">
                  <button v-for="item in changesFor(turn.id)" :key="item.change.id" class="result-link" type="button"
                    @click="inspect(turn.id, item.change)"><FileText :size="15" />{{ resultLabel(item.change) }}</button>
                </div>
                <button v-if="turn.id === turns.at(-1)?.id && ['partial', 'failed', 'interrupted', 'stopped'].includes(turn.status)" class="history-link"
                  type="button" @click="continueTurn(turn)">{{ t(changesFor(turn.id).length ? 'creativeAgent.continue' : 'creativeAgent.retryMessage') }}</button>
              </div>
            </div>
          </article>
        </div>
      </div>

      <form class="composer" @submit.prevent="sendMessage">
        <p v-if="error" class="composer-error" role="alert">{{ errorLabel(error) }} <button v-if="!initialized" type="button" class="history-link" @click="setup">{{ t('novel.reload') }}</button></p>
        <div v-if="references.length" class="reference-chips">
          <span v-for="item in references" :key="referenceKey(item)" class="reference-chip">
            <Link2 :size="14" />{{ referenceLabel(item) }}
            <button type="button" :aria-label="t('creativeAgent.removeReference', { name: referenceLabel(item) })" @click="toggleReference(item)"><X :size="13" /></button>
          </span>
        </div>
        <label class="sr-only" for="creative-message">{{ t('creativeAgent.message') }}</label>
        <textarea id="creative-message" ref="input" v-model="message" rows="2" maxlength="8000" :readonly="sending"
          :placeholder="t('creativeAgent.placeholder')" @input="resumeFromId = undefined" @keydown.enter.exact="handleEnter" />
        <footer class="composer-actions">
          <div class="references-control">
            <button type="button" class="reference-toggle" :aria-expanded="showReferences" @click="openReferencePicker"><Link2 :size="16" />{{ t('creativeAgent.reference') }}</button>
            <div v-if="showReferences" class="reference-picker" :aria-label="t('creativeAgent.reference')">
              <header><strong>{{ t('creativeAgent.reference') }}</strong><button type="button" :aria-label="t('common.cancel')" @click="showReferences = false"><X :size="15" /></button></header>
              <p v-if="resourceError" role="alert">{{ errorLabel(resourceError) }}</p>
              <input v-model="referenceSearch" maxlength="120" :aria-label="t('creativeAgent.searchReference')" :placeholder="t('creativeAgent.searchReference')" />
              <template v-for="item in filteredReferences" :key="referenceKey(item)">
                <div class="reference-option">
                  <button type="button" :aria-pressed="references.some(reference => referenceKey(reference) === referenceKey(item))" @click="toggleReference(item)">
                    <FileText :size="15" />{{ referenceLabel(item) }}
                  </button>
                  <button v-if="item.kind === 'episode' && item.id" type="button" :aria-expanded="sceneEpisode === item.id"
                    :title="t('common.scene')" :aria-label="`${referenceLabel(item)} · ${t('common.scene')}`" @click="loadScenes(item.id)"><ListTree :size="16" /></button>
                </div>
                <div v-if="item.kind === 'episode' && sceneEpisode === item.id" class="scene-options">
                  <p v-if="loadingScenes" class="dim">{{ t('novel.loading') }}</p>
                  <button v-for="scene in scenes" :key="scene" type="button" @click="toggleReference({ ...item, scene, label: `${referenceLabel(item)} · ${scene}` })">{{ scene }}</button>
                  <p v-if="!loadingScenes && !scenes.length" class="dim">{{ t('creativeAgent.noReference') }}</p>
                </div>
              </template>
              <p v-if="!filteredReferences.length && !resourceError" class="dim">{{ t('creativeAgent.noReference') }}</p>
              <button v-if="nextResource !== null" type="button" @click="fetchMaterials(true)">{{ t('creativeAgent.moreResources') }}</button>
            </div>
          </div>
          <ModelSelect v-if="models.length" v-model="modelKey" label="" :options="models" :default-label="t('creativeAgent.defaultModel')" />
          <NuxtLink v-else-if="modelLoaded" class="history-link" to="/settings">{{ t('creativeAgent.configureModel') }}</NuxtLink>
          <button v-if="running" type="button" class="send-button" :disabled="stopping" :title="t('creativeAgent.stop')" :aria-label="t('creativeAgent.stop')" @click="stop"><Square :size="17" /></button>
          <button v-else type="submit" class="send-button" :disabled="!canSend" :title="t('novel.chat.send')" :aria-label="t('novel.chat.send')">
            <LoaderCircle v-if="sending" class="spinning" :size="20" /><Send v-else :size="20" />
          </button>
        </footer>
      </form>
    </div>

    <CreativeScriptInspector v-if="inspected" :project-id="projectId" :resource="inspected" :available="changesFor(inspected.turnId)"
      :refresh-key="scriptRevision" @close="inspected = null" @select="inspected = $event" @open-script="emit('openScript', $event)" />
  </section>
</template>

<script setup lang="ts">
import { BookOpen, Check, ChevronDown, Circle, CircleAlert, CircleCheck, FilePenLine, FileText, Link2, ListTree,
  LoaderCircle, PanelLeft, Pencil, Plus, Send, Square, UserRound, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import logo from '~/assets/brand-logo.png'
import ModelSelect from '~/components/ModelSelect.vue'
import CreativeScriptInspector from '~/components/CreativeScriptInspector.vue'
import { aiConfigAPI, projectScriptAPI } from '~/composables/useApi'
import { collectModelOptions } from '~/utils/text-model-selection'
import { creativeAPI, errorCode, useCreativeAgent, type CreativeReference, type CreativeChange, type CreativeTurn } from '~/composables/useCreativeAgent'

type Reference = CreativeReference & { label?: string }
const props = defineProps<{ projectId: number; episodes: { id: number; episode_number: number; title: string }[] }>()
const emit = defineEmits<{ saved: []; openScript: [episodeId: number | null] }>()
const { t, te } = useI18n()
const scriptRevision = ref(0)
const { sessions, nextSession, selected, turns, beforeId, loading, sending, stopping, error, connected,
  running, timelines, loadSessions, selectSession, send, stop, rename, initialize, loadEarlier } = useCreativeAgent(props.projectId, () => {
  scriptRevision.value++
  emit('saved')
})
const message = ref('')
const resumeFromId = ref<number>()
const references = ref<Reference[]>([])
const feed = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const models = ref<ReturnType<typeof collectModelOptions>>([])
const modelKey = ref('')
const modelLoaded = ref(false)
const initialized = ref(false)
const renaming = ref<number | null>(null)
const newTitle = ref('')
const showReferences = ref(false)
const showSessions = ref(false)
const referenceSearch = ref('')
const materials = ref<Reference[]>([])
const nextResource = ref<number | null>(null)
const resourceError = ref('')
const sceneEpisode = ref<number | null>(null)
const scenes = ref<string[]>([])
const loadingScenes = ref(false)
const inspected = ref<{ turnId: number; change: CreativeChange } | null>(null)
const drafts = new Map<number | null, { message: string; references: Reference[]; resumeFromId?: number }>()
let resourceRequest = 0
let resourceTimer: ReturnType<typeof setTimeout> | undefined
const canSend = computed(() => initialized.value && !loading.value && !sending.value && !running.value && !!message.value.trim())
const filteredReferences = computed(() => materials.value.filter(item => referenceLabel(item).toLowerCase().includes(referenceSearch.value.trim().toLowerCase())))

function errorLabel(code: string) {
  const own = `creativeAgent.errors.${code}`
  const novel = `novel.chat.errors.${code}`
  const script = `projectScript.errors.${code}`
  return t(te(own) ? own : te(script) ? script : te(novel) ? novel : 'creativeAgent.errors.load_failed')
}
function isWrite(tool: string) { return /^(save|edit|create)_/.test(tool) }
function toolLabel(tool: string, number?: number) {
  const key = `creativeAgent.tools.${tool}${number && tool.includes('episode') ? '_number' : ''}`
  return t(te(key) ? key : `creativeAgent.tools.${tool}`, { n: number })
}
function toolStatus(block: { state: string; tool: string }, status: string) {
  if (block.state === 'running') return status === 'running' ? 'creativeAgent.working' : 'creativeAgent.stopped'
  if (block.state === 'failed') return 'creativeAgent.actionFailed'
  if (block.tool === 'create_episode_script') return 'creativeAgent.created'
  return isWrite(block.tool) ? 'creativeAgent.saved' : 'creativeAgent.read'
}
function referenceKey(item: CreativeReference) { return `${item.kind}:${item.id ?? ''}:${item.scene ?? ''}` }
function referenceLabel(item: Reference) {
  if (item.label) return item.label
  if (item.kind === 'source') return t('projectScript.originalUpload')
  if (item.kind === 'novel') return t('creativeAgent.novelReference', { n: item.id })
  const episode = props.episodes.find(value => value.id === item.id)
  return episode ? `${t('projectScript.episode', { n: episode.episode_number })} · ${episode.title}${item.scene ? ` · ${item.scene}` : ''}`
    : t('creativeAgent.episodeReference', { n: item.id })
}
function resultLabel(item: CreativeChange) {
  return item.kind === 'outline' ? t('creativeAgent.viewOutline') : t('creativeAgent.viewEpisode', { n: item.episode_number })
}
function changesFor(turnId: number) {
  return (timelines.value.get(turnId) ?? []).flatMap(block => block.kind === 'tool' && block.change ? [{ turnId, change: block.change }] : [])
}
function inspect(turnId: number, change: CreativeChange) { inspected.value = { turnId, change } }

async function fetchMaterials(append = false) {
  const request = ++resourceRequest
  const query = referenceSearch.value.trim()
  const after = append ? nextResource.value ?? 0 : 0
  resourceError.value = ''
  if (!append) nextResource.value = null
  try {
    const data = await creativeAPI.resources(props.projectId, after, query)
    if (request !== resourceRequest) return
    const fresh: Reference[] = data.episodes.map(item => ({ kind: 'episode', id: item.id,
      label: `${t('projectScript.episode', { n: item.number })} · ${item.title}` }))
    for (const item of data.novels) fresh.push({ kind: 'novel', id: item.id,
      label: item.title ? `${t('novel.title')} · ${item.title.slice(0, 36)}` : t('creativeAgent.novelReference', { n: item.id }) })
    if (data.has_source) fresh.push({ kind: 'source' })
    if (append) materials.value = [...new Map([...materials.value, ...fresh].map(item => [referenceKey(item), item])).values()]
    else materials.value = fresh
    nextResource.value = data.next_after_episode
  } catch (e) {
    if (request === resourceRequest) resourceError.value = errorCode(e)
  }
}
function openReferencePicker() {
  showReferences.value = !showReferences.value
  clearTimeout(resourceTimer)
  if (showReferences.value) void fetchMaterials()
}
async function loadScenes(id: number) {
  if (sceneEpisode.value === id) { sceneEpisode.value = null; return }
  sceneEpisode.value = id
  scenes.value = []
  loadingScenes.value = true
  try {
    const result = await projectScriptAPI.episode(props.projectId, id)
    if (sceneEpisode.value !== id) return
    const text = result.script ?? result.original ?? ''
    scenes.value = [...new Set<string>(Array.from(String(text).matchAll(/^##[ \t]+(S\d+)[ \t]*\|/gim), match => match[1].toUpperCase()))]
  } catch (e) { if (sceneEpisode.value === id) resourceError.value = errorCode(e) }
  finally { if (sceneEpisode.value === id) loadingScenes.value = false }
}
function toggleReference(item: Reference) {
  if (references.value.some(value => referenceKey(value) === referenceKey(item))) {
    references.value = references.value.filter(value => referenceKey(value) !== referenceKey(item))
  } else if (references.value.length < 10) references.value = [...references.value, item]
}
function scrollEnd() { nextTick(() => { if (feed.value) feed.value.scrollTop = feed.value.scrollHeight }) }
watch(timelines, () => {
  const body = feed.value
  if (!body || body.scrollHeight - body.scrollTop - body.clientHeight < 90) scrollEnd()
})
watch(referenceSearch, () => {
  if (!showReferences.value) return
  clearTimeout(resourceTimer)
  resourceTimer = setTimeout(() => void fetchMaterials(), 250)
})
async function activate(id: number | null) {
  if (sending.value || (id !== null && id === selected.value)) return
  drafts.set(selected.value, { message: message.value, references: references.value, resumeFromId: resumeFromId.value })
  inspected.value = null
  showSessions.value = false
  showReferences.value = false
  message.value = drafts.get(id)?.message ?? ''
  references.value = drafts.get(id)?.references ?? []
  resumeFromId.value = drafts.get(id)?.resumeFromId
  await selectSession(id)
  scrollEnd()
  await nextTick()
  input.value?.focus()
}
async function loadPrevious() {
  const height = feed.value?.scrollHeight ?? 0
  try { await loadEarlier(); await nextTick(); if (feed.value) feed.value.scrollTop += feed.value.scrollHeight - height }
  catch (e) { error.value = errorCode(e) }
}
async function loadMoreSessions() {
  try { await loadSessions(true) } catch (e) { error.value = errorCode(e) }
}
async function saveTitle(id: number) {
  if (!newTitle.value.trim()) return
  try { await rename(id, newTitle.value.trim()); renaming.value = null }
  catch (e) { error.value = errorCode(e) }
}
async function sendMessage() {
  if (!canSend.value) return
  const model = models.value.find(option => option.key === modelKey.value)
  const previous = selected.value
  const refs = references.value.map(({ kind, id, scene }) => ({ kind, id, scene }))
  if (await send(message.value.trim(), refs, model ? { config_id: model.configId, model: model.model } : undefined, resumeFromId.value)) {
    drafts.delete(previous)
    message.value = ''
    references.value = []
    resumeFromId.value = undefined
    showReferences.value = false
    scrollEnd()
  }
}
function handleEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  void sendMessage()
}
function continueTurn(turn: CreativeTurn) {
  resumeFromId.value = turn.id
  message.value = changesFor(turn.id).length ? t('creativeAgent.continuePrompt') : turn.message
  references.value = turn.references
  input.value?.focus()
}
async function setup() {
  try { await initialize(); initialized.value = true; scrollEnd() }
  catch (e) { error.value = errorCode(e) }
}
onMounted(() => {
  void setup()
  void aiConfigAPI.list('text').then(data => { models.value = collectModelOptions(data, true) })
    .catch(() => {}).finally(() => { modelLoaded.value = true })
})
onBeforeUnmount(() => clearTimeout(resourceTimer))
</script>

<style scoped>
.creative-workspace { display: grid; grid-template-columns: minmax(174px, 17.2%) minmax(0, 1fr); flex: 1; min-height: 0; background: var(--bg-0); color: var(--text-0); font-size: 16px; line-height: 1.55; }
.creative-workspace.with-inspector { grid-template-columns: minmax(174px, 17.2%) minmax(0, 1fr) minmax(275px, 27%); }
.sessions { min-height: 0; min-width: 0; overflow: auto; padding: 20px 12px; border-inline-end: 1px solid var(--border); background: var(--bg-1); }
.sessions-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 1px 6px 14px; }
.sessions-head h2 { font-size: 16px; }
.new-session, .session-title, .rename-button, .rename button, .history-link, .result-link, .mobile-session-button { background: transparent; color: inherit; border: 0; cursor: pointer; font: inherit; }
.new-session { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-text); white-space: nowrap; font-size: 13px; }
.session-list { display: grid; gap: 4px; }
.session-row { display: flex; align-items: center; min-width: 0; padding: 0 6px 0 0; border-inline-start: 3px solid transparent; border-radius: 8px; }
.session-row:hover { background: var(--bg-hover); }
.session-row.selected { border-color: var(--accent); background: var(--accent-bg); }
.session-title { flex: 1; text-align: start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 10px 8px; }
.rename-button { opacity: 0; padding: 5px; display: grid; place-items: center; }
.session-row:hover .rename-button, .session-row:focus-within .rename-button { opacity: 1; }
.rename { display: flex; gap: 4px; padding: 5px; width: 100%; }
.rename input { min-width: 0; width: 100%; padding: 4px; }
.chat-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.mobile-session-button { display: none; }
.chat-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 30px clamp(18px, 2.8vw, 45px); }
.chat-column { max-width: 820px; margin: auto; display: grid; gap: 24px; }
.chat-turn { display: grid; gap: 23px; }
.user-row, .agent-row { display: flex; align-items: flex-start; gap: 14px; }
.user-row { justify-content: flex-end; }
.user-message { max-width: min(88%, 680px); padding: 12px 16px; background: var(--bg-2); border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.user-icon { color: var(--text-2); margin-top: 9px; flex-shrink: 0; }
.user-references { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.user-references span { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); font-size: 12px; }
.agent-icon { width: 25px; height: 25px; object-fit: contain; border-radius: 5px; }
.agent-content { flex: 1; min-width: 0; display: grid; gap: 12px; }
.reply { line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-step { position: relative; margin-inline-start: 29px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 15px; }
.tool-step summary { display: flex; gap: 9px; align-items: center; min-height: 45px; padding: 8px 12px; cursor: pointer; list-style: none; }
.tool-marker { position: absolute; inset-inline-start: -23px; top: 18px; fill: var(--text-3); color: var(--text-3); }
.tool-step + .tool-step::before { content: ''; position: absolute; inset-inline-start: -19px; top: -35px; height: 54px; border-inline-start: 1px solid var(--border-strong); }
.tool-step summary::-webkit-details-marker { display: none; }
.tool-step[open] .tool-chevron { transform: rotate(180deg); }
.tool-step summary svg { flex-shrink: 0; }
.tool-label { overflow-wrap: anywhere; }
.tool-state { margin-inline-start: auto; display: flex; gap: 7px; align-items: center; font-size: 14px; color: var(--text-2); white-space: nowrap; }
.tool-state.completed svg { color: var(--success); }
.tool-state.failed svg, .turn-error, .composer-error { color: var(--error); }
.tool-details { border-top: 1px solid var(--border); padding: 8px 12px; display: flex; gap: 10px; align-items: center; color: var(--text-2); font-size: 13px; }
.turn-results { display: flex; gap: 10px 20px; flex-wrap: wrap; }
.result-link { display: inline-flex; align-items: center; gap: 6px; text-decoration: underline; text-underline-offset: 3px; }
.result-link:hover, .history-link:hover { color: var(--accent-text); }
.history-link { justify-self: start; color: var(--text-2); text-decoration: underline; font-size: 13px; }
.composer { position: relative; margin: 0 auto 20px; width: min(calc(100% - 28px), 850px); flex-shrink: 0; background: var(--bg-1);
  border: 1px solid var(--border-strong); border-radius: 15px; padding: 12px; }
.composer:focus-within { border-color: var(--border-focus); }
.composer textarea { width: 100%; max-height: 26vh; min-height: 56px; resize: vertical; background: transparent; color: inherit; border: 0; outline: 0; font: inherit; line-height: 1.5; }
.composer textarea::placeholder { color: var(--text-2); }
.composer-actions { display: flex; gap: 10px; align-items: center; }
.reference-toggle { display: inline-flex; align-items: center; gap: 7px; background: transparent; color: var(--text-1); border: 1px solid var(--border-strong); border-radius: 999px; cursor: pointer; padding: 7px 11px; font-size: 14px; }
.composer :deep(.model-select-trigger) { height: 34px; font-size: 14px; padding: 0 11px; }
.reference-picker { position: absolute; bottom: calc(100% + 6px); inset-inline-start: 0; z-index: 2; width: min(345px, 100%); max-height: 48vh; overflow: auto;
  display: grid; gap: 4px; padding: 12px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-1); box-shadow: var(--shadow-panel); }
.reference-picker header { display: flex; justify-content: space-between; align-items: center; }
.reference-picker button, .reference-chip button { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: inherit; border: 0; cursor: pointer; font: inherit; text-align: start; padding: 5px; }
.reference-picker button:hover, .reference-picker button[aria-pressed=true] { background: var(--accent-bg); color: var(--accent-text); }
.reference-picker input, .rename input { background: var(--bg-input); color: inherit; border: 1px solid var(--border-strong); border-radius: 6px; }
.reference-picker input { padding: 6px 8px; }
.reference-option { display: flex; justify-content: space-between; gap: 7px; }
.reference-option button:first-child { flex: 1; }
.scene-options { display: flex; flex-wrap: wrap; padding: 4px 8px 6px 22px; gap: 5px; }
.reference-chips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 5px; }
.reference-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; background: var(--bg-2); border-radius: 5px; font-size: 12px; }
.send-button { margin-inline-start: auto; flex-shrink: 0; display: grid; place-items: center; height: 38px; width: 38px; border: 0; border-radius: 50%; background: var(--action-primary); color: var(--action-primary-text); cursor: pointer; }
.send-button:disabled { opacity: .48; cursor: default; }
.composer-error { display: flex; margin-bottom: 8px; gap: 8px; }
.chat-empty { margin-top: clamp(28px, 12vh, 150px); display: grid; gap: 9px; justify-items: center; text-align: center; color: var(--text-2); }
.chat-empty img { width: 42px; }
.chat-empty h2 { color: var(--text-0); }
.spinning { animation: rotate 1s linear infinite; }
@keyframes rotate { to { transform: rotate(360deg); } }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 900px) {
  .creative-workspace, .creative-workspace.with-inspector { position: relative; grid-template-columns: minmax(0, 1fr); }
  .mobile-session-button { display: inline-flex; align-items: center; align-self: start; gap: 8px; padding: 8px 13px; }
  .sessions { display: none; }
  .sessions.mobile-sessions { position: absolute; display: block; top: 32px; bottom: 0; width: min(260px, 85%); z-index: 4; box-shadow: var(--shadow-panel); }
  .creative-workspace > :deep(.inspector) { position: absolute; inset-block: 0; inset-inline-end: 0; width: min(370px, 93%); z-index: 5; box-shadow: var(--shadow-panel); }
  .tool-step { margin-inline-start: 0; }
  .tool-marker, .tool-step + .tool-step::before { display: none; }
}
</style>
