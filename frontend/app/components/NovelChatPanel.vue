<template>
  <section v-if="editable || turns.length || loadError" class="novel-chat" :aria-label="t('novel.chat.title')">
    <details v-if="storyPlan" class="chat-candidate">
      <summary>{{ t('novel.chat.storyPlan') }}</summary>
      <div class="chat-prose">{{ storyPlan }}</div>
    </details>
    <div v-if="turns.length" ref="feed" class="chat-feed" :aria-label="t('novel.chat.history')" tabindex="0">
      <button v-if="beforeId" type="button" class="btn btn-sm" :disabled="loadingEarlier" @click="loadEarlier">
        {{ t('novel.chat.loadEarlier') }}
      </button>
      <article v-for="turn in turns" :key="turn.id" class="chat-turn">
        <div class="chat-message chat-user"><span class="chat-label">{{ t('novel.chat.you') }}</span>
          <div class="chat-prose">{{ turn.message }}</div>
        </div>
        <div class="chat-message chat-reply">
          <div class="chat-label">{{ t('novel.chat.agent') }} <span class="dim">· {{ turn.model }}</span></div>
          <p v-if="turn.status === 'running'" role="status">{{ t('novel.chat.running') }}</p>
          <div v-else-if="turn.error_code" class="chat-actions">
            <p role="status">{{ errorMessage(turn.error_code) }}</p>
            <button v-if="editable && turn.id === latestTurnId" type="button" class="btn btn-sm"
              :disabled="busy || !!runningTurn" @click="retry(turn)">
              {{ t('novel.chat.retry') }}
            </button>
          </div>
          <div v-if="turn.assistant_text" class="chat-prose">{{ turn.assistant_text }}</div>
          <details v-if="turn.proposal" class="chat-candidate">
            <summary>{{ turn.proposal.kind === 'plan' ? t('novel.chat.plan')
              : t(`novel.chat.${turn.proposal.kind}`, { part: turn.proposal.part_number }) }}</summary>
            <div v-if="turn.proposal.kind === 'replace'" class="chat-original">
              <span class="chat-label">{{ t('novel.chat.original') }}</span>
              <div class="chat-prose">{{ turn.proposal.original_text }}</div>
            </div>
            <div class="chat-prose">{{ turn.proposal.content || t('novel.chat.removeExcerpt') }}</div>
            <div class="chat-actions">
              <span v-if="turn.applied_at" class="dim">{{ t('novel.chat.applied') }}</span>
              <span v-else-if="turn.proposal.base_revision !== currentRevision" class="dim">{{ t('novel.chat.stale') }}</span>
              <button v-else-if="editable" type="button" class="btn btn-sm btn-primary"
                :disabled="busy || !!runningTurn" @click="apply(turn)">
                {{ t('novel.chat.apply') }}
              </button>
            </div>
          </details>
        </div>
      </article>
    </div>
    <div v-if="loadError" class="chat-actions">
      <p role="status">{{ t('novel.chat.loadFailed') }}</p>
      <button type="button" class="btn btn-sm" @click="refresh">{{ t('novel.reload') }}</button>
    </div>
    <form v-if="editable" class="chat-compose" @submit.prevent="send">
      <label :for="`novel-message-${jobId}`">{{ t('novel.chat.message') }}</label>
      <textarea :id="`novel-message-${jobId}`" v-model="message" class="textarea" rows="3" maxlength="8000"
        :placeholder="t('novel.chat.placeholder')" :readonly="busy" required />
      <div class="chat-actions">
        <ModelSelect v-if="modelOptions.length" v-model="selectedModel" :options="modelOptions"
          :label="t('novel.model')" :default-label="defaultOption?.label" />
        <span v-else-if="modelsLoaded" class="dim">{{ t('novel.errors.model_unavailable') }}</span>
        <button v-else-if="modelsLoadFailed" type="button" class="btn btn-sm" @click="emit('reloadModels')">
          {{ t('novel.reloadModels') }}
        </button>
        <button type="submit" class="btn btn-primary chat-send" :disabled="!canSend">{{ t('novel.chat.send') }}</button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ModelSelect from '~/components/ModelSelect.vue'
import { novelAPI, novelRequestId, type NovelChatTurn } from '~/composables/useApi'

const props = defineProps<{
  dramaId: number
  jobId: number
  draftRevision: number
  editable: boolean
  defaultModel: string
  modelsLoaded: boolean
  modelsLoadFailed: boolean
  modelOptions: { key: string; configId: number; model: string; label: string }[]
}>()
const emit = defineEmits<{
  applied: [result: Awaited<ReturnType<typeof novelAPI.applyTurn>>]
  reloadModels: []
}>()
const { t, te } = useI18n()
const turns = ref<NovelChatTurn[]>([])
const storyPlan = ref<string | null>(null)
const serverRevision = ref(0)
const message = ref('')
const selectedModel = ref('')
const beforeId = ref<number | null>(null)
const loadingEarlier = ref(false)
const feed = ref<HTMLElement | null>(null)
const loaded = ref(false)
const loadError = ref(false)
const busy = ref(false)
const currentRevision = computed(() => Math.max(props.draftRevision, serverRevision.value))
const runningTurn = computed(() => turns.value.find(turn => turn.status === 'running'))
const running = computed(() => busy.value || !!runningTurn.value)
defineExpose({ running })
const latestTurnId = computed(() => turns.value.at(-1)?.id ?? null)
const defaultOption = computed(() => {
  const last = turns.value.at(-1)
  const lastModel = last && `${last.config_id}/${last.model}`
  return props.modelOptions.find(option => option.key === (lastModel || props.defaultModel)) ?? props.modelOptions[0]
})
const model = computed(() => props.modelOptions.find(option => option.key === selectedModel.value) ?? defaultOption.value)
const canSend = computed(() => loaded.value && props.editable && !busy.value && !runningTurn.value
  && !!model.value && !!message.value.trim())

let request: { fingerprint: string; id: string } | undefined
let timer: ReturnType<typeof setTimeout>
let sequence = 0
let disposed = false
let loadedEarlier = false
let syncedRevision: number | undefined
const appliedTimes = new Map<number, string>()

function errorMessage(code: string) {
  const chatKey = `novel.chat.errors.${code}`
  const novelKey = `novel.errors.${code}`
  return t(te(chatKey) ? chatKey : te(novelKey) ? novelKey : 'novel.chat.actionFailed')
}

function merge(incoming: NovelChatTurn[], follow = false) {
  const merged = new Map(turns.value.map(turn => [turn.id, turn]))
  for (const turn of incoming) merged.set(turn.id, turn)
  turns.value = Array.from(merged.values(), turn => {
    const appliedAt = appliedTimes.get(turn.id)
    return appliedAt && !turn.applied_at ? { ...turn, applied_at: appliedAt } : turn
  }).sort((a, b) => a.id - b.id)
  if (follow) void nextTick(() => { if (feed.value) feed.value.scrollTop = feed.value.scrollHeight })
}

async function refresh() {
  clearTimeout(timer)
  const attempt = ++sequence
  try {
    const pending = runningTurn.value
    const result = await novelAPI.chatTurns(props.dramaId, props.jobId, { afterRevision: syncedRevision })
    const incoming = result.active_turn ? [...result.turns, result.active_turn] : result.turns
    if (pending && !incoming.some(turn => turn.id === pending.id)) {
      const prior = await novelAPI.chatTurns(props.dramaId, props.jobId, { beforeId: pending.id + 1 })
      const updated = prior.turns.find(turn => turn.id === pending.id)
      if (updated) incoming.push(updated)
    }
    if (disposed || attempt !== sequence) return
    for (const turn of result.applied_turns) {
      if (turn.applied_at) appliedTimes.set(turn.id, turn.applied_at)
    }
    syncedRevision = result.draft_revision
    const scroller = feed.value
    merge(incoming, !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 52)
    if (!loadedEarlier) beforeId.value = result.before_id
    storyPlan.value = result.story_plan
    serverRevision.value = Math.max(serverRevision.value, result.draft_revision)
    loaded.value = true
    loadError.value = false
  } catch {
    if (!disposed && attempt === sequence) loadError.value = true
  } finally {
    if (!disposed && attempt === sequence && (props.editable || runningTurn.value || loadError.value)) {
      timer = setTimeout(refresh, runningTurn.value ? 1400 : 8000)
    }
  }
}

async function loadEarlier() {
  if (beforeId.value === null || loadingEarlier.value) return
  loadingEarlier.value = true
  try {
    const result = await novelAPI.chatTurns(props.dramaId, props.jobId, { beforeId: beforeId.value })
    if (disposed) return
    const previousHeight = feed.value?.scrollHeight ?? 0
    loadedEarlier = true
    beforeId.value = result.before_id
    // Keep the current position when earlier messages are prepended.
    const existing = new Set(turns.value.map(turn => turn.id))
    merge(result.turns.filter(turn => !existing.has(turn.id)))
    await nextTick()
    if (feed.value) feed.value.scrollTop += feed.value.scrollHeight - previousHeight
  } catch { if (!disposed) toast.error(t('novel.chat.loadFailed')) }
  finally { loadingEarlier.value = false }
}

async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  clearTimeout(timer)
  sequence++
  try { await action() } catch (error) {
    if (!disposed) toast.error(errorMessage(error instanceof Error ? error.message : 'action_failed'))
  } finally {
    busy.value = false
    if (!disposed) void refresh()
  }
}

function send() {
  if (!canSend.value || !model.value) return
  const data = { message: message.value.trim(), config_id: model.value.configId, model: model.value.model }
  const fingerprint = JSON.stringify(data)
  if (request?.fingerprint !== fingerprint) request = { fingerprint, id: novelRequestId() }
  const id = request.id
  return act(async () => {
    const turn = await novelAPI.sendTurn(props.dramaId, props.jobId, { ...data, request_id: id })
    if (disposed) return
    merge([turn], true)
    request = undefined
    message.value = ''
  })
}

function retry(turn: NovelChatTurn) {
  if (!props.editable || runningTurn.value || turn.id !== latestTurnId.value) return
  const chosen = selectedModel.value && model.value
  return act(async () => {
    const updated = await novelAPI.retryTurn(props.dramaId, props.jobId, turn.id,
      chosen ? { config_id: chosen.configId, model: chosen.model } : undefined)
    if (!disposed) merge([updated])
  })
}

function apply(turn: NovelChatTurn) {
  if (!props.editable || runningTurn.value) return
  return act(async () => {
    const result = await novelAPI.applyTurn(props.dramaId, props.jobId, turn.id)
    if (disposed) return
    serverRevision.value = result.job.draft_revision
    merge([result.turn])
    emit('applied', result)
  })
}

onMounted(refresh)
watch(() => props.editable, () => { if (!busy.value) void refresh() })
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>

<style scoped>
.novel-chat, .chat-turn, .chat-compose { display: grid; gap: 10px; min-width: 0; }
.novel-chat { padding: 14px; border: 1px solid var(--border); border-radius: 12px; }
.chat-feed { display: grid; gap: 16px; max-height: min(52vh, 620px); overflow-y: auto; padding: 0 4px 6px 0; }
.chat-feed > button { justify-self: center; }
.chat-message { padding: 10px 12px; border-radius: 10px; min-width: 0; }
.chat-user { justify-self: end; max-width: 88%; background: var(--bg-input); }
.chat-reply { border: 1px solid var(--border); }
.chat-label { font-weight: 600; font-size: 12px; margin-bottom: 4px; overflow-wrap: anywhere; }
.chat-message p, .chat-actions p { margin: 0; }
.chat-prose { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.chat-candidate { padding: 8px 10px; margin-top: 6px; background: var(--bg-input); border-radius: 8px; }
.chat-candidate summary { cursor: pointer; font-weight: 600; }
.chat-candidate .chat-prose { margin-top: 8px; }
.chat-original { padding: 8px; margin-top: 8px; border-left: 2px solid var(--border-strong); }
.chat-candidate .chat-actions { margin-top: 8px; }
.chat-compose label { font-size: 13px; }
.chat-compose textarea { width: 100%; resize: vertical; }
.chat-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.chat-send { margin-inline-start: auto; }
</style>
