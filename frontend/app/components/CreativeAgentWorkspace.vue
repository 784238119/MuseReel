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
              @click="activate(session.id)">
              <span class="session-status-dot" :class="sessionState(session)" aria-hidden="true" />
              <span class="session-copy">
                <span class="session-title-text">{{ session.title }}</span>
                <span class="session-subtitle">{{ sessionSubtitle(session) }}</span>
              </span>
            </button>
            <button type="button" class="rename-button" :title="t('creativeAgent.rename')" :aria-label="t('creativeAgent.rename')"
              @click="renaming = session.id; newTitle = session.title"><Pencil :size="13" /></button>
          </template>
        </div>
        <button v-if="nextSession !== null" type="button" class="history-link" @click="loadMoreSessions">{{ t('creativeAgent.moreSessions') }}</button>
      </div>
    </aside>

    <div class="chat-main">
      <header class="chat-header">
        <div class="chat-heading">
          <button class="mobile-session-button" type="button" :aria-expanded="showSessions" @click="showSessions = !showSessions">
            <PanelLeft :size="16" /><span class="sr-only">{{ t('creativeAgent.sessions') }}</span>
          </button>
          <div class="chat-head-copy">
            <h2>{{ selectedSession?.title || t('creativeAgent.newChat') }}</h2>
            <p v-if="selectedModelOption">
              <Sparkles :size="13" />
              <span class="header-model-label">{{ t('creativeAgent.nextModel') }}</span>
              <span>{{ selectedModelOption.model }}</span>
              <span class="header-divider">·</span>
              <span>{{ selectedModelOption.configName || selectedModelOption.provider }}</span>
            </p>
          </div>
        </div>
        <span class="connection-chip" :class="{ off: !connected }">
          <Wifi v-if="connected" :size="13" /><WifiOff v-else :size="13" />
          {{ t(connected ? 'creativeAgent.connected' : 'creativeAgent.reconnecting') }}
        </span>
      </header>

      <div ref="feed" class="chat-feed" :aria-label="t('novel.chat.history')">
        <div class="chat-column">
          <p v-if="loading" role="status" class="dim">{{ t('novel.loading') }}</p>
          <button v-if="beforeId !== null" type="button" class="history-link" @click="loadPrevious">{{ t('novel.chat.loadEarlier') }}</button>
          <div v-if="!loading && !turns.length" class="chat-empty">
            <img :src="logo" alt="" />
            <h2>{{ t('creativeAgent.title') }}</h2>
            <p>{{ t('creativeAgent.empty') }}</p>
          </div>

          <article v-for="group in turnGroups" :key="group.root.id" class="run-group">
            <div class="user-row">
              <div class="user-message">
                <div class="message-meta">
                  <span>{{ t('novel.chat.you') }}</span>
                  <time :datetime="group.root.created_at">{{ formatTime(group.root.created_at) }}</time>
                </div>
                <p>{{ group.root.message }}</p>
                <div v-if="group.root.references.length" class="user-references">
                  <span v-for="item in group.root.references" :key="referenceKey(item)">
                    <Link2 :size="12" />{{ referenceLabel(item) }}
                  </span>
                </div>
              </div>
              <UserRound :size="21" class="user-icon" aria-hidden="true" />
            </div>

            <div v-if="group.attempts.length > 1" class="attempt-switcher" role="group" :aria-label="t('creativeAgent.attempts')">
              <span class="attempt-switcher-label">{{ t('creativeAgent.attempts') }}</span>
              <button v-for="(attempt, index) in group.attempts" :key="attempt.id" type="button"
                :class="{ selected: activeAttempt(group).id === attempt.id }"
                :aria-pressed="activeAttempt(group).id === attempt.id"
                @click="selectAttempt(group.root.id, attempt.id)">
                <span class="attempt-dot" :class="turnState(attempt)" aria-hidden="true" />
                <span>{{ t('creativeAgent.attempt', { n: index + 1 }) }}</span>
                <small>{{ shortModel(attempt.model) }}</small>
              </button>
            </div>

            <div class="agent-row">
              <img :src="logo" class="agent-icon" alt="" />
              <div class="agent-content">
                <div class="agent-meta">
                  <strong>{{ t('creativeAgent.title') }}</strong>
                  <span class="run-state-pill" :class="turnState(activeAttempt(group))">{{ turnStatusLabel(activeAttempt(group)) }}</span>
                  <span class="agent-model" :title="activeAttempt(group).model">{{ activeAttempt(group).model }}</span>
                  <time :datetime="activeAttempt(group).created_at">{{ formatTime(activeAttempt(group).created_at) }}</time>
                  <span v-if="turnDuration(activeAttempt(group))" class="agent-duration">
                    <Clock3 :size="12" />{{ turnDuration(activeAttempt(group)) }}
                  </span>
                </div>

                <section v-if="activeAttempt(group).status === 'running'" class="run-live" :class="runUrgency(activeAttempt(group))" role="status">
                  <div class="run-live-head">
                    <span class="run-live-title"><LoaderCircle :size="16" class="spinning" />{{ runPhase(activeAttempt(group)) }}</span>
                    <strong>{{ formatClock(elapsedSeconds(activeAttempt(group))) }}</strong>
                  </div>
                  <p>{{ runIdleText(activeAttempt(group)) }}</p>
                  <div class="run-pulse" aria-hidden="true"><span /></div>
                </section>

                <div class="run-timeline">
                  <template v-for="block in timelines.get(activeAttempt(group).id) ?? []" :key="block.seq">
                    <p v-if="block.kind === 'text'" class="reply">{{ block.text }}</p>
                    <details v-else class="tool-step">
                      <summary>
                        <component :is="block.change || isWrite(block.tool) ? FilePenLine : BookOpen" :size="16" />
                        <span class="timeline-dot" aria-hidden="true" />
                        <span class="tool-label">{{ toolLabel(block.tool, block.target?.episode_number ?? block.target?.part_number) }}</span>
                        <span v-if="block.durationMs !== null && block.durationMs !== undefined" class="tool-duration">
                          {{ formatDurationMs(block.durationMs) }}
                        </span>
                        <span class="tool-state" :class="block.state">
                          <CircleCheck v-if="block.state === 'completed'" :size="16" />
                          <CircleAlert v-else-if="block.state === 'failed'" :size="16" />
                          <LoaderCircle v-else class="spinning" :size="16" />
                          <span>{{ t(toolStatus(block, activeAttempt(group).status)) }}</span>
                        </span>
                        <ChevronDown :size="13" class="tool-chevron" />
                      </summary>
                      <div class="tool-details">
                        <span v-if="block.target?.scene">{{ block.target.scene }}</span>
                        <span v-if="block.error">{{ errorLabel(block.error) }}</span>
                        <button v-if="block.change" class="result-link" type="button" @click="inspect(activeAttempt(group).id, block.change)">
                          <FileText :size="15" />{{ t('creativeAgent.changes') }}
                        </button>
                        <button v-else-if="block.state === 'completed' && block.target?.episode_id" class="result-link" type="button"
                          @click="emit('openScript', block.target.episode_id)"><FileText :size="15" />{{ t('creativeAgent.script') }}</button>
                        <span v-else-if="!block.error" class="dim">{{ t(toolStatus(block, activeAttempt(group).status)) }}</span>
                      </div>
                    </details>
                  </template>
                </div>

                <p v-if="!timelines.get(activeAttempt(group).id)?.length && activeAttempt(group).assistant_text" class="reply">
                  {{ activeAttempt(group).assistant_text }}
                </p>

                <div v-if="changesFor(activeAttempt(group).id).length" class="turn-results">
                  <button v-for="item in changesFor(activeAttempt(group).id)" :key="item.change.id" class="result-link" type="button"
                    @click="inspect(activeAttempt(group).id, item.change)"><FileText :size="15" />{{ resultLabel(item.change) }}</button>
                </div>

                <section v-if="isFailure(activeAttempt(group))" class="run-failure" role="alert">
                  <div class="failure-head">
                    <span class="failure-icon"><CircleAlert :size="18" /></span>
                    <div>
                      <h3>{{ failureTitle(activeAttempt(group)) }}</h3>
                      <p>{{ errorLabel(activeAttempt(group).error_code || activeAttempt(group).status) }}</p>
                    </div>
                  </div>
                  <dl class="failure-facts">
                    <div><dt>{{ t('creativeAgent.actualModel') }}</dt><dd>{{ activeAttempt(group).model }}</dd></div>
                    <div><dt>{{ t('creativeAgent.lastCompletedStep') }}</dt><dd>{{ lastCompletedStep(activeAttempt(group)) }}</dd></div>
                    <div><dt>{{ t('creativeAgent.elapsed') }}</dt><dd>{{ turnDuration(activeAttempt(group)) || '—' }}</dd></div>
                  </dl>
                  <div class="failure-actions">
                    <button type="button" class="btn btn-primary btn-sm" :disabled="sending || !!running" @click="retryAttempt(activeAttempt(group))">
                      <RotateCcw :size="14" />
                      {{ t(changesFor(activeAttempt(group).id).length ? 'creativeAgent.continue' : 'creativeAgent.retryCurrentModel') }}
                    </button>
                    <button type="button" class="btn btn-sm" :disabled="sending || !!running" @click="openRetryModel(activeAttempt(group))">
                      <RefreshCw :size="14" />{{ t('creativeAgent.retryAnotherModel') }}
                    </button>
                    <button type="button" class="history-link" @click="diagnosticsOpen = diagnosticsOpen === activeAttempt(group).id ? null : activeAttempt(group).id">
                      {{ t('creativeAgent.viewDetails') }}
                    </button>
                  </div>
                  <form v-if="retryTurnId === activeAttempt(group).id" class="retry-model-form" @submit.prevent="retryAttempt(activeAttempt(group), true)">
                    <ModelSelect v-if="models.length" v-model="retryModelKey" hide-default :label="t('creativeAgent.model')"
                      :options="models" :default-label="selectedModelOption?.model || t('creativeAgent.defaultModel')" />
                    <button type="submit" class="btn btn-primary btn-sm" :disabled="sending || !!running">{{ t('creativeAgent.retryWithModel') }}</button>
                    <button type="button" class="btn btn-sm" @click="retryTurnId = null">{{ t('common.cancel') }}</button>
                  </form>
                  <div v-if="diagnosticsOpen === activeAttempt(group).id" class="failure-details">
                    <span>{{ t('creativeAgent.errorCode') }}</span>
                    <code>{{ activeAttempt(group).error_code || activeAttempt(group).status }}</code>
                  </div>
                </section>
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
            <button type="button" class="reference-toggle" :aria-expanded="showReferences" @click="openReferencePicker">
              <Link2 :size="16" />{{ t('creativeAgent.reference') }}
            </button>
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
          <ModelSelect v-if="models.length" v-model="modelKey" hide-default label=""
            :options="models" :default-label="t('creativeAgent.defaultModel')" />
          <NuxtLink v-else-if="modelLoaded" class="history-link" to="/settings">{{ t('creativeAgent.configureModel') }}</NuxtLink>
          <button v-if="running" type="button" class="send-button stop-button" :disabled="stopping"
            :title="t('creativeAgent.stop')" :aria-label="t('creativeAgent.stop')" @click="stop"><Square :size="16" /></button>
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
import { BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, Clock3, FilePenLine, FileText, Link2, ListTree,
  LoaderCircle, PanelLeft, Pencil, Plus, RefreshCw, RotateCcw, Send, Sparkles, Square, UserRound, Wifi, WifiOff, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import logo from '~/assets/brand-logo.png'
import ModelSelect from '~/components/ModelSelect.vue'
import CreativeScriptInspector from '~/components/CreativeScriptInspector.vue'
import { aiConfigAPI, projectScriptAPI } from '~/composables/useApi'
import { collectModelOptions, resolveTextModelSelection } from '~/utils/text-model-selection'
import { creativeAPI, errorCode, useCreativeAgent, type CreativeReference, type CreativeChange,
  type CreativeSession, type CreativeTurn } from '~/composables/useCreativeAgent'

type Reference = CreativeReference & { label?: string }
type RunGroup = { root: CreativeTurn; attempts: CreativeTurn[] }
const props = defineProps<{ projectId: number; episodes: { id: number; episode_number: number; title: string }[] }>()
const emit = defineEmits<{ saved: []; openScript: [episodeId: number | null] }>()
const { t, te, locale } = useI18n()
const scriptRevision = ref(0)
const { sessions, nextSession, selected, turns, events, beforeId, loading, sending, stopping, error, connected,
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
const retryTurnId = ref<number | null>(null)
const retryModelKey = ref('')
const diagnosticsOpen = ref<number | null>(null)
const nowTick = ref(Date.now())
const attemptSelection = ref(new Map<number, number>())
const drafts = new Map<number | null, { message: string; references: Reference[]; resumeFromId?: number }>()
let resourceRequest = 0
let resourceTimer: ReturnType<typeof setTimeout> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined

const selectedSession = computed(() => sessions.value.find(session => session.id === selected.value))
const selectedModelOption = computed(() =>
  models.value.find(option => option.key === modelKey.value) ?? models.value[0] ?? null)
const canSend = computed(() => initialized.value && !loading.value && !sending.value && !running.value && !!message.value.trim())
const filteredReferences = computed(() => materials.value.filter(item =>
  referenceLabel(item).toLowerCase().includes(referenceSearch.value.trim().toLowerCase())))
const turnsById = computed(() => new Map(turns.value.map(turn => [turn.id, turn])))
const turnGroups = computed<RunGroup[]>(() => {
  const groups = new Map<number, RunGroup>()
  for (const turn of turns.value) {
    let root = turn
    const visited = new Set<number>()
    while (root.resume_from_id !== null && !visited.has(root.id)) {
      visited.add(root.id)
      const parent = turnsById.value.get(root.resume_from_id)
      if (!parent) break
      root = parent
    }
    const group = groups.get(root.id) ?? { root, attempts: [] }
    group.attempts.push(turn)
    groups.set(root.id, group)
  }
  return [...groups.values()]
})

function modelStorageKey(sessionId = selected.value) {
  return `musereel:creative:model:${props.projectId}:${sessionId ?? 'new'}`
}
function optionForTurn(turn: CreativeTurn) {
  return models.value.find(option => option.configId === turn.config_id && option.model === turn.model)
}
function rememberModel(sessionId = selected.value) {
  if (!modelKey.value) return
  try { localStorage.setItem(modelStorageKey(sessionId), modelKey.value) } catch { /* optional preference */ }
}
function restoreModelSelection() {
  if (!models.value.length) return
  let remembered = ''
  try { remembered = localStorage.getItem(modelStorageKey()) || '' } catch { /* optional preference */ }
  const lastSuccessful = [...turns.value].reverse().find(turn => turn.status === 'completed')
  const fromTurn = lastSuccessful ? optionForTurn(lastSuccessful)?.key ?? '' : ''
  const next = [fromTurn, remembered, modelKey.value, models.value[0]?.key]
    .find(key => !!key && models.value.some(option => option.key === key))
  if (next) modelKey.value = next
}
watch(models, restoreModelSelection)
watch(selected, () => { nextTick(restoreModelSelection) })
watch(modelKey, () => rememberModel())

function errorLabel(code: string) {
  const own = `creativeAgent.errors.${code}`
  const novel = `novel.chat.errors.${code}`
  const script = `projectScript.errors.${code}`
  return t(te(own) ? own : te(script) ? script : te(novel) ? novel : 'creativeAgent.errors.load_failed')
}
function shortModel(model?: string | null) {
  if (!model) return t('creativeAgent.defaultModel')
  return model.replace(/-preview$/i, '').replace(/^gpt-/, 'GPT-')
}
function isWrite(tool: string) { return /^(save|edit|create|append|replace|split)_/.test(tool) }
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
  if (item.kind === 'outline') return t('creativeAgent.viewOutline')
  if (item.kind === 'novel') return t('creativeAgent.viewNovel')
  return t('creativeAgent.viewEpisode', { n: item.episode_number })
}
function changesFor(turnId: number) {
  return (timelines.value.get(turnId) ?? []).flatMap(block =>
    block.kind === 'tool' && block.change ? [{ turnId, change: block.change }] : [])
}
function inspect(turnId: number, change: CreativeChange) { inspected.value = { turnId, change } }

function selectAttempt(rootId: number, turnId: number) {
  const next = new Map(attemptSelection.value)
  next.set(rootId, turnId)
  attemptSelection.value = next
}
function activeAttempt(group: RunGroup) {
  const selectedAttempt = group.attempts.find(turn => turn.id === attemptSelection.value.get(group.root.id))
  return selectedAttempt ?? group.attempts.at(-1) ?? group.root
}
function sessionState(session: CreativeSession) {
  if (session.active_turn_id || session.id === selected.value && running.value) return 'running'
  if (['failed', 'interrupted'].includes(session.last_status ?? '')) return 'failed'
  if (session.last_status === 'partial') return 'partial'
  if (session.last_status === 'completed') return 'completed'
  return 'idle'
}
function sessionSubtitle(session: CreativeSession) {
  if (sessionState(session) === 'running') return t('creativeAgent.sessionRunning')
  if (sessionState(session) === 'failed') return t('creativeAgent.sessionNeedsRetry')
  if (sessionState(session) === 'partial') return t('creativeAgent.partial')
  return session.last_model ? shortModel(session.last_model) : t('creativeAgent.sessionIdle')
}
function turnState(turn: CreativeTurn) {
  if (turn.status === 'running') {
    const idle = idleSeconds(turn)
    if (idle >= 120) return 'stalled'
    if (idle >= 60) return 'slow'
    return 'running'
  }
  if (turn.status === 'completed') return 'completed'
  if (turn.status === 'partial') return 'partial'
  if (turn.status === 'stopped') return 'stopped'
  return 'failed'
}
function turnStatusLabel(turn: CreativeTurn) {
  const state = turnState(turn)
  return t(`creativeAgent.runStates.${state}`)
}
function turnEvents(turn: CreativeTurn) {
  return events.value.filter(event => event.turn_id === turn.id)
}
function timeValue(value?: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}
function lastActivityTime(turn: CreativeTurn) {
  return turnEvents(turn).reduce((latest, event) => Math.max(latest, timeValue(event.created_at)), timeValue(turn.created_at))
}
function elapsedSeconds(turn: CreativeTurn) {
  const end = turn.status === 'running' ? nowTick.value : lastActivityTime(turn)
  return Math.max(0, Math.floor((end - timeValue(turn.created_at)) / 1000))
}
function idleSeconds(turn: CreativeTurn) {
  return turn.status === 'running'
    ? Math.max(0, Math.floor((nowTick.value - lastActivityTime(turn)) / 1000))
    : 0
}
function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
}
function formatDurationMs(milliseconds: number) {
  return milliseconds < 1000 ? '<1s' : `${Math.round(milliseconds / 1000)}s`
}
function turnDuration(turn: CreativeTurn) {
  if (turn.status === 'running') return formatClock(elapsedSeconds(turn))
  const seconds = elapsedSeconds(turn)
  return seconds ? formatClock(seconds) : ''
}
function runUrgency(turn: CreativeTurn) {
  const idle = idleSeconds(turn)
  return idle >= 120 ? 'danger' : idle >= 60 ? 'warning' : 'active'
}
function runPhase(turn: CreativeTurn) {
  const blocks = timelines.value.get(turn.id) ?? []
  const last = blocks.at(-1)
  if (last?.kind === 'tool' && last.state === 'running') return toolLabel(last.tool, last.target?.episode_number ?? last.target?.part_number)
  if (last?.kind === 'tool') return t('creativeAgent.waitingAfterStep')
  if (last?.kind === 'text') return t('creativeAgent.writingReply')
  return t('creativeAgent.readingContext')
}
function runIdleText(turn: CreativeTurn) {
  const idle = idleSeconds(turn)
  if (idle >= 120) return t('creativeAgent.stalledHint', { seconds: idle })
  if (idle >= 60) return t('creativeAgent.slowHint', { seconds: idle })
  if (idle >= 30) return t('creativeAgent.stillThinking', { seconds: idle })
  return t('creativeAgent.stepsContinue')
}
function isFailure(turn: CreativeTurn) {
  return ['partial', 'failed', 'interrupted', 'stopped'].includes(turn.status)
}
function failureTitle(turn: CreativeTurn) {
  if (turn.error_code === 'timeout') return t('creativeAgent.failureTitles.timeout')
  if (turn.status === 'interrupted') return t('creativeAgent.failureTitles.interrupted')
  if (turn.status === 'stopped') return t('creativeAgent.failureTitles.stopped')
  if (turn.status === 'partial') return t('creativeAgent.failureTitles.partial')
  return t('creativeAgent.failureTitles.failed')
}
function lastCompletedStep(turn: CreativeTurn) {
  const block = (timelines.value.get(turn.id) ?? []).filter(item => item.kind === 'tool' && item.state === 'completed').at(-1)
  return block?.kind === 'tool' ? toolLabel(block.tool, block.target?.episode_number ?? block.target?.part_number) : t('creativeAgent.noCompletedStep')
}
function openRetryModel(turn: CreativeTurn) {
  retryTurnId.value = retryTurnId.value === turn.id ? null : turn.id
  retryModelKey.value = optionForTurn(turn)?.key ?? modelKey.value
}
async function retryAttempt(turn: CreativeTurn, explicitModel = false) {
  if (sending.value || running.value) return
  const choice = resolveTextModelSelection(models.value, explicitModel ? retryModelKey.value : modelKey.value)
  if (!choice.model || !choice.configId) return
  const text = changesFor(turn.id).length ? t('creativeAgent.continuePrompt') : turn.message
  const refs = turn.references.map(({ kind, id, scene }) => ({ kind, id, scene }))
  const created = await send(text, refs, { config_id: choice.configId, model: choice.model }, turn.id)
  if (!created) return
  const root = turnGroups.value.find(group => group.attempts.some(attempt => attempt.id === created.id))
    ?? turnGroups.value.find(group => group.attempts.includes(turn))
  if (root) selectAttempt(root.root.id, created.id)
  retryTurnId.value = null
  rememberModel(created.session_id)
  scrollEnd()
}

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
  if (!body || body.scrollHeight - body.scrollTop - body.clientHeight < 100) scrollEnd()
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
  retryTurnId.value = null
  showSessions.value = false
  showReferences.value = false
  message.value = drafts.get(id)?.message ?? ''
  references.value = drafts.get(id)?.references ?? []
  resumeFromId.value = drafts.get(id)?.resumeFromId
  await selectSession(id)
  restoreModelSelection()
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
  const selectedModel = resolveTextModelSelection(models.value, modelKey.value)
  if (!selectedModel.model || !selectedModel.configId) return
  const previous = selected.value
  const refs = references.value.map(({ kind, id, scene }) => ({ kind, id, scene }))
  const created = await send(message.value.trim(), refs,
    { config_id: selectedModel.configId, model: selectedModel.model }, resumeFromId.value)
  if (created) {
    drafts.delete(previous)
    rememberModel(created.session_id)
    message.value = ''
    references.value = []
    resumeFromId.value = undefined
    showReferences.value = false
    retryTurnId.value = null
    scrollEnd()
  }
}
function handleEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  void sendMessage()
}
async function setup() {
  try {
    await initialize()
    initialized.value = true
    restoreModelSelection()
    scrollEnd()
  } catch (e) { error.value = errorCode(e) }
}
onMounted(() => {
  void setup()
  void aiConfigAPI.list('text').then(data => {
    models.value = collectModelOptions(data, true)
    restoreModelSelection()
  }).catch(() => {}).finally(() => { modelLoaded.value = true })
  clockTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  clearTimeout(resourceTimer)
  clearInterval(clockTimer)
})
</script>

<style scoped>
.creative-workspace { display: grid; grid-template-columns: minmax(196px, 18%) minmax(0, 1fr); flex: 1; min-height: 0; background: var(--bg-0); color: var(--text-0); font-size: 15px; line-height: 1.55; }
.creative-workspace.with-inspector { grid-template-columns: minmax(196px, 18%) minmax(0, 1fr) minmax(285px, 27%); }
.sessions { min-height: 0; min-width: 0; overflow: auto; padding: 18px 11px; border-inline-end: 1px solid var(--border); background: var(--bg-1); }
.sessions-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 1px 7px 13px; }
.sessions-head h2 { font-size: 15px; }
.new-session, .session-title, .rename-button, .rename button, .history-link, .result-link, .mobile-session-button { background: transparent; color: inherit; border: 0; cursor: pointer; font: inherit; }
.new-session { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-text); white-space: nowrap; font-size: 12px; }
.session-list { display: grid; gap: 3px; }
.session-row { display: flex; align-items: center; min-width: 0; padding-inline-end: 4px; border-inline-start: 3px solid transparent; border-radius: 7px; }
.session-row:hover { background: var(--bg-hover); }
.session-row.selected { border-color: var(--accent); background: var(--accent-bg); }
.session-title { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 9px; text-align: start; padding: 9px 7px; }
.session-copy { flex: 1; min-width: 0; display: grid; gap: 2px; }
.session-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.session-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-size: 11px; }
.session-status-dot, .attempt-dot { width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; flex-shrink: 0; background: var(--text-4); }
.session-status-dot.running, .attempt-dot.running { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
.session-status-dot.completed, .attempt-dot.completed { background: var(--success); }
.session-status-dot.failed, .attempt-dot.failed, .attempt-dot.stalled { background: var(--error); }
.session-status-dot.partial, .attempt-dot.partial, .attempt-dot.slow { background: var(--warning, #c98a24); }
.attempt-dot.stopped { background: var(--text-3); }
.rename-button { opacity: 0; padding: 6px; display: grid; place-items: center; }
.session-row:hover .rename-button, .session-row:focus-within .rename-button { opacity: 1; }
.rename { display: flex; gap: 4px; padding: 5px; width: 100%; }
.rename input { min-width: 0; width: 100%; padding: 5px; }

.chat-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chat-header { flex-shrink: 0; min-height: 62px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px clamp(18px, 2.8vw, 45px); border-bottom: 1px solid var(--border); background: var(--bg-0); }
.chat-heading { min-width: 0; display: flex; align-items: center; gap: 10px; }
.chat-head-copy { min-width: 0; }
.chat-head-copy h2 { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-head-copy p { margin-top: 2px; display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--text-3); font-size: 11px; }
.chat-head-copy p span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-model-label { color: var(--text-3); font-size: 10px; }
.header-divider { color: var(--border-strong); }
.connection-chip { flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 999px; background: var(--success-bg); color: var(--success); font-size: 11px; }
.connection-chip.off { background: var(--bg-2); color: var(--text-3); }
.mobile-session-button { display: none; }
.chat-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 26px clamp(18px, 2.8vw, 45px) 18px; }
.chat-column { max-width: 850px; margin: auto; display: grid; gap: 30px; }
.run-group { display: grid; gap: 15px; }
.user-row, .agent-row { display: flex; align-items: flex-start; gap: 13px; }
.user-row { justify-content: flex-end; }
.user-message { max-width: min(86%, 700px); padding: 11px 15px 12px; background: var(--bg-2); border-radius: 9px; }
.user-message p { white-space: pre-wrap; overflow-wrap: anywhere; }
.message-meta { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 5px; color: var(--text-3); font-size: 10px; }
.user-icon { color: var(--text-2); margin-top: 10px; flex-shrink: 0; }
.user-references { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.user-references span { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); font-size: 11px; }
.attempt-switcher { align-self: flex-end; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; max-width: 86%; }
.attempt-switcher-label { margin-inline-end: 2px; color: var(--text-3); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.attempt-switcher button { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-1); color: var(--text-2); font: 11px var(--font-body); cursor: pointer; }
.attempt-switcher button:hover { border-color: var(--border-hover); color: var(--text-0); }
.attempt-switcher button.selected { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.attempt-switcher small { color: var(--text-3); font-size: 10px; }
.attempt-dot { margin-top: 0; width: 6px; height: 6px; }
.agent-row { align-items: stretch; }
.agent-icon { width: 25px; height: 25px; object-fit: contain; border-radius: 5px; flex-shrink: 0; margin-top: 1px; }
.agent-content { flex: 1; min-width: 0; display: grid; gap: 12px; padding-inline-start: 14px; border-inline-start: 1px solid var(--border); }
.agent-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-height: 25px; color: var(--text-3); font-size: 11px; }
.agent-meta strong { color: var(--text-1); font-size: 12px; }
.agent-model { max-width: 210px; overflow: hidden; padding: 1px 6px; border-radius: 4px; background: var(--bg-2); color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; }
.agent-duration { display: inline-flex; align-items: center; gap: 3px; }
.run-state-pill { padding: 1px 7px; border-radius: 999px; background: var(--bg-2); color: var(--text-2); font-size: 10px; }
.run-state-pill.running { background: var(--accent-bg); color: var(--accent-text); }
.run-state-pill.completed { background: var(--success-bg); color: var(--success); }
.run-state-pill.failed, .run-state-pill.stalled { background: var(--error-bg, rgba(205, 80, 70, .1)); color: var(--error); }
.run-state-pill.partial, .run-state-pill.slow { background: var(--warning-bg, rgba(201, 138, 36, .12)); color: var(--warning, #a86d12); }
.run-live { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-1); }
.run-live.warning { border-color: color-mix(in srgb, var(--warning, #c98a24) 45%, var(--border)); }
.run-live.danger { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); }
.run-live-head, .run-live-title { display: flex; align-items: center; }
.run-live-head { justify-content: space-between; gap: 12px; }
.run-live-title { gap: 7px; color: var(--text-1); font-size: 13px; }
.run-live-head strong { color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.run-live p { color: var(--text-3); font-size: 11px; }
.run-pulse { height: 2px; overflow: hidden; border-radius: 2px; background: var(--overlay-track); }
.run-pulse span { display: block; width: 36%; height: 100%; border-radius: inherit; background: var(--accent); animation: run-pulse 1.8s ease-in-out infinite; }
.run-live.warning .run-pulse span { background: var(--warning, #c98a24); }
.run-live.danger .run-pulse span { background: var(--error); }
.run-timeline { display: grid; gap: 8px; }
.reply { line-height: 1.72; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-step { position: relative; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-0); font-size: 13px; }
.tool-step summary { display: flex; gap: 8px; align-items: center; min-height: 40px; padding: 7px 10px; cursor: pointer; list-style: none; }
.tool-step summary::-webkit-details-marker { display: none; }
.tool-step summary svg { flex-shrink: 0; }
.timeline-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--text-4); }
.tool-label { min-width: 0; overflow-wrap: anywhere; color: var(--text-1); }
.tool-duration { color: var(--text-3); font-size: 10px; font-variant-numeric: tabular-nums; }
.tool-state { margin-inline-start: auto; display: flex; gap: 5px; align-items: center; color: var(--text-3); font-size: 11px; white-space: nowrap; }
.tool-state.completed svg { color: var(--success); }
.tool-state.failed svg { color: var(--error); }
.tool-chevron { color: var(--text-3); transition: transform .18s var(--ease-out); }
.tool-step[open] .tool-chevron { transform: rotate(180deg); }
.tool-details { border-top: 1px solid var(--border); padding: 8px 10px; display: flex; gap: 10px; align-items: center; color: var(--text-2); font-size: 12px; }
.tool-details .dim { color: var(--text-3); }
.turn-results { display: flex; gap: 8px 18px; flex-wrap: wrap; }
.result-link { display: inline-flex; align-items: center; gap: 6px; color: var(--text-1); text-decoration: underline; text-underline-offset: 3px; font-size: 12px; }
.result-link:hover, .history-link:hover { color: var(--accent-text); }
.history-link { justify-self: start; color: var(--text-2); text-decoration: underline; font-size: 12px; }

.run-failure { display: grid; gap: 11px; padding: 13px 14px; border: 1px solid color-mix(in srgb, var(--error) 28%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--error-bg, rgba(205, 80, 70, .08)) 72%, var(--bg-0)); }
.failure-head { display: flex; align-items: flex-start; gap: 9px; }
.failure-icon { display: grid; place-items: center; width: 27px; height: 27px; flex-shrink: 0; border-radius: 7px; background: var(--error-bg, rgba(205, 80, 70, .1)); color: var(--error); }
.failure-head h3 { margin: 1px 0 2px; color: var(--text-0); font-size: 14px; }
.failure-head p { color: var(--text-2); font-size: 12px; }
.failure-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 16px; padding: 9px 0; border-block: 1px solid var(--border); }
.failure-facts div { min-width: 0; }
.failure-facts dt { color: var(--text-3); font-size: 10px; }
.failure-facts dd { margin-top: 2px; overflow: hidden; color: var(--text-1); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.failure-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.failure-actions .history-link { margin-inline-start: auto; }
.retry-model-form { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 3px; }
.failure-details { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 8px; border-top: 1px dashed var(--border); color: var(--text-3); font-size: 11px; }
.failure-details code { color: var(--text-2); }

.composer { position: relative; margin: 0 auto 18px; width: min(calc(100% - 36px), 850px); flex-shrink: 0; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 12px; padding: 11px; }
.composer:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--button-focus); }
.composer textarea { width: 100%; max-height: 26vh; min-height: 56px; resize: vertical; background: transparent; color: inherit; border: 0; outline: 0; font: inherit; line-height: 1.5; }
.composer textarea::placeholder { color: var(--text-2); }
.composer-actions { display: flex; gap: 9px; align-items: center; }
.reference-toggle { display: inline-flex; align-items: center; gap: 7px; background: transparent; color: var(--text-1); border: 1px solid var(--border-strong); border-radius: 999px; cursor: pointer; padding: 7px 11px; font-size: 13px; }
.composer :deep(.model-select-trigger) { height: 32px; font-size: 12px; padding: 0 10px; }
.reference-picker { position: absolute; bottom: calc(100% + 6px); inset-inline-start: 0; z-index: 2; width: min(345px, 100%); max-height: 48vh; overflow: auto; display: grid; gap: 4px; padding: 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-1); box-shadow: var(--shadow-panel); }
.reference-picker header { display: flex; justify-content: space-between; align-items: center; }
.reference-picker button, .reference-chip button { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: inherit; border: 0; cursor: pointer; font: inherit; text-align: start; padding: 5px; }
.reference-picker button:hover, .reference-picker button[aria-pressed=true] { background: var(--accent-bg); color: var(--accent-text); }
.reference-picker input, .rename input { background: var(--bg-input); color: inherit; border: 1px solid var(--border-strong); border-radius: 6px; }
.reference-picker input { padding: 6px 8px; }
.reference-option { display: flex; justify-content: space-between; gap: 7px; }
.reference-option button:first-child { flex: 1; }
.scene-options { display: flex; flex-wrap: wrap; padding: 4px 8px 6px 22px; gap: 5px; }
.reference-chips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 5px; }
.reference-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; background: var(--bg-2); border-radius: 5px; font-size: 11px; }
.send-button { margin-inline-start: auto; flex-shrink: 0; display: grid; place-items: center; height: 38px; width: 38px; border: 0; border-radius: 50%; background: var(--action-primary); color: var(--action-primary-text); cursor: pointer; }
.send-button.stop-button { background: var(--text-1); color: var(--bg-0); }
.send-button:disabled { opacity: .48; cursor: default; }
.composer-error { display: flex; margin-bottom: 8px; gap: 8px; color: var(--error); }
.chat-empty { margin-top: clamp(30px, 12vh, 140px); display: grid; gap: 9px; justify-items: center; text-align: center; color: var(--text-2); }
.chat-empty img { width: 42px; }
.chat-empty h2 { color: var(--text-0); }
.spinning { animation: rotate 1s linear infinite; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes rotate { to { transform: rotate(360deg); } }
@keyframes run-pulse { 0% { transform: translateX(-110%); } 55% { transform: translateX(170%); } 100% { transform: translateX(280%); } }
@media (max-width: 900px) {
  .creative-workspace, .creative-workspace.with-inspector { position: relative; grid-template-columns: minmax(0, 1fr); }
  .chat-header { min-height: 54px; padding-inline: 14px; }
  .mobile-session-button { display: inline-grid; place-items: center; width: 30px; height: 30px; }
  .sessions { display: none; }
  .sessions.mobile-sessions { position: absolute; display: block; top: 54px; bottom: 0; width: min(280px, 88%); z-index: 4; box-shadow: var(--shadow-panel); }
  .creative-workspace > :deep(.inspector) { position: absolute; inset-block: 0; inset-inline-end: 0; width: min(370px, 93%); z-index: 5; box-shadow: var(--shadow-panel); }
  .chat-feed { padding: 20px 14px 14px; }
  .agent-content { padding-inline-start: 10px; }
  .connection-chip { padding-inline: 7px; }
  .failure-facts { grid-template-columns: 1fr; gap: 5px; }
  .composer { width: calc(100% - 20px); margin-bottom: 10px; }
}
</style>
