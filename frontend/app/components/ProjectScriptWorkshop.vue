<template>
  <section class="card screenplay">
    <aside class="screenplay-nav" :aria-label="t('projectScript.directory')">
      <h2>{{ t('projectScript.directory') }}</h2>
      <button type="button" class="script-nav-item" :class="{ selected: view === 'outline' }"
        :aria-current="view === 'outline' ? 'page' : undefined" @click="select('outline')">
        {{ t('projectScript.outline') }}
      </button>
      <button v-for="episode in sortedEpisodes" :key="episode.id" type="button" class="script-nav-item"
        :class="{ selected: view === `episode:${episode.id}` }"
        :aria-current="view === `episode:${episode.id}` ? 'page' : undefined"
        @click="select(`episode:${episode.id}`)">
        <strong>{{ t('projectScript.episode', { n: episodeNumber(episode) }) }}</strong>
        <span>{{ episode.title }}</span>
      </button>
      <button v-for="part in previewParts" :key="part.ordinal" type="button" class="script-nav-item"
        :class="{ selected: view === `preview:${part.ordinal}` }" @click="select(`preview:${part.ordinal}`)">
        <strong>{{ t('projectScript.previewEpisode', { n: part.ordinal }) }}</strong>
        <span>{{ part.title }}</span>
      </button>
      <button v-if="job?.status === 'review'" type="button" class="script-nav-item"
        :class="{ selected: view === 'review' }" @click="select('review')">{{ t('projectScript.review') }}</button>
      <button v-if="state?.has_source" type="button" class="script-nav-item" @click="select('source')">
        {{ t('projectScript.originalUpload') }}
      </button>
      <button type="button" class="btn script-add" :disabled="workflowBusy" @click="openJob('continue')">
        {{ t('projectScript.add') }}
      </button>
    </aside>

    <div class="screenplay-main">
      <div v-if="loadError" class="script-actions" role="alert">
        {{ t('novel.errors.load_failed') }}
        <button type="button" class="btn btn-sm" @click="refresh">{{ t('novel.reload') }}</button>
      </div>
      <div v-if="job && ['running', 'interrupted', 'failed'].includes(job.status)" class="script-status" role="status">
        <span v-if="job.status === 'running'">{{ t(`projectScript.stages.${job.stage}`) }}
          <template v-if="job.stage !== 'outline'"> · {{ job.parts.length }}/{{ job.count }}</template>
        </span>
        <template v-else>
          <p>{{ errorText(job.error_code) }}</p>
          <form v-if="!jobForm" class="script-actions" @submit.prevent="retry">
            <ScriptJobOptions v-if="job.stage !== 'publishing'" :key="job.id" v-model="options"
              hide-count model-only :preferred="`${job.config_id}/${job.model}`" />
            <button class="btn btn-sm" :disabled="saving || (job.stage !== 'publishing' && !options.model)">{{ t('novel.retry') }}</button>
          </form>
        </template>
      </div>

      <form v-if="jobForm" class="script-editor" @submit.prevent="startJob">
        <header class="script-actions">
          <h2>{{ t(jobForm === 'rewrite' ? 'projectScript.rewrite' : 'projectScript.add') }}</h2>
          <button type="button" class="btn btn-sm" :disabled="submitting" @click="jobForm = null">{{ t('common.cancel') }}</button>
        </header>
        <div v-if="jobForm === 'continue'" class="script-actions">
          <button type="button" class="btn btn-sm" :aria-pressed="!uploading" @click="uploading = false">{{ t('projectScript.continueAI') }}</button>
          <button type="button" class="btn btn-sm" :aria-pressed="uploading" @click="openUpload">{{ t('projectScript.modes.upload') }}</button>
        </div>
        <template v-if="uploading">
          <div v-if="novels.length" class="script-actions">
            <select v-model="novelId" class="input" :aria-label="t('projectScript.historyNovel')">
              <option :value="null">{{ t('projectScript.historyNovel') }}</option>
              <option v-for="novel in novels" :key="novel.id" :value="novel.id">
                {{ new Date(novel.created_at).toLocaleString() }} · {{ novel.source_type === 'legacy' ? t('novel.title') : t(`novel.sources.${novel.source_type}`) }}
              </option>
            </select>
            <button type="button" class="btn btn-sm" :disabled="!novelId || loadingNovel" @click="useNovel">{{ t('projectScript.useNovel') }}</button>
          </div>
          <ScriptSourceInput v-model="source" v-model:state="importState" />
        </template>
        <label v-else>
          {{ t(jobForm === 'rewrite' ? 'projectScript.rewriteIdea' : 'projectScript.continueIdea') }}
          <textarea v-model="idea" class="textarea" rows="4" maxlength="8000" :required="jobForm === 'rewrite' || !state?.outline" />
        </label>
        <ScriptJobOptions v-model="options" :import-count="uploading ? importState.count : null" :hide-count="jobForm === 'rewrite'" />
        <button class="btn btn-primary script-submit" :disabled="!canStart || submitting">{{ t('projectScript.generate') }}</button>
      </form>

      <template v-else-if="view === 'outline'">
        <header class="script-actions"><h2>{{ t('projectScript.outline') }}</h2>
          <button v-if="!editing && !workflowBusy" type="button" class="btn btn-sm" @click="editOutline">{{ t('projectScript.edit') }}</button>
        </header>
        <form v-if="editing && outlineDraft" class="script-editor" @submit.prevent="saveOutline">
          <label v-for="key in outlineKeys" :key="key">
            {{ t(`projectScript.outlineFields.${key}`) }}
            <textarea v-model="outlineDraft[key]" class="textarea" rows="5" maxlength="8000" :required="key !== 'characters'" />
          </label>
          <div class="script-actions">
            <button class="btn btn-primary" :disabled="saving">{{ t('common.save') }}</button>
            <button type="button" class="btn" @click="editing = false">{{ t('common.cancel') }}</button>
          </div>
        </form>
        <template v-else-if="state?.outline">
          <section v-for="key in outlineKeys" :key="key" class="outline-block">
            <h3>{{ t(`projectScript.outlineFields.${key}`) }}</h3>
            <p class="script-prose">{{ state.outline[key] }}</p>
          </section>
        </template>
        <p v-else class="dim">{{ t(!state ? 'projectScript.loading' : 'projectScript.emptyOutline') }}</p>
      </template>

      <template v-else-if="document">
        <header class="script-actions">
          <h2>{{ document.title || t(view === 'source' ? 'projectScript.originalUpload' : 'projectScript.review') }}</h2>
          <div v-if="selectedEpisode" class="script-actions">
            <button v-if="document.editable && !editing" type="button" class="btn btn-sm" @click="editEpisode">{{ t('projectScript.edit') }}</button>
            <button v-if="document.editable && !editing && !workflowBusy" type="button" class="btn btn-sm" @click="openJob('rewrite')">
              {{ t('projectScript.rewrite') }}
            </button>
            <button v-if="!editing" type="button" class="btn btn-primary" :disabled="saving" @click="produce">{{ t('projectScript.produce') }}</button>
          </div>
        </header>
        <template v-if="view === 'review'">
          <div class="script-comparison">
            <div><h3>{{ t('projectScript.before') }}</h3><p class="script-prose">{{ document.original }}</p></div>
            <div><h3>{{ t('projectScript.after') }}</h3><p class="script-prose">{{ document.script }}</p></div>
          </div>
          <div class="script-actions">
            <button type="button" class="btn btn-primary" :disabled="saving" @click="resolve(true)">{{ t('projectScript.apply') }}</button>
            <button type="button" class="btn" :disabled="saving" @click="resolve(false)">{{ t('projectScript.discard') }}</button>
          </div>
        </template>
        <form v-else-if="editing && episodeDraft" class="script-editor" @submit.prevent="saveEpisode">
          <label>{{ t('projectScript.episodeTitle') }}<input v-model="episodeDraft.title" class="input" maxlength="160" required /></label>
          <label>{{ t('projectScript.episodeScript') }}
            <textarea v-model="episodeDraft.script" class="textarea" rows="16" required />
          </label>
          <div class="script-actions">
            <button class="btn btn-primary" :disabled="saving">{{ t('common.save') }}</button>
            <button type="button" class="btn" @click="editing = false">{{ t('common.cancel') }}</button>
          </div>
        </form>
        <template v-else>
          <p v-if="selectedEpisode && !document.editable" class="dim">{{ t('projectScript.errors.production_locked') }}</p>
          <p class="script-prose">{{ document.script || document.original || t('projectScript.emptyEpisode') }}</p>
          <details v-if="document.script && document.original && document.script !== document.original">
            <summary>{{ t('projectScript.originalUpload') }}</summary>
            <p class="script-prose">{{ document.original }}</p>
          </details>
        </template>
      </template>
      <p v-else-if="readerError" role="alert">{{ t('novel.errors.load_failed') }}
        <button type="button" class="btn btn-sm" @click="readerRevision++">{{ t('novel.reload') }}</button>
      </p>
      <p v-else class="dim" role="status">{{ t('projectScript.loading') }}</p>
    </div>
  </section>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { novelAPI, projectScriptAPI } from '~/composables/useApi'

const props = defineProps({ dramaId: Number, episodes: { type: Array, default: () => [] } })
const emit = defineEmits(['published'])
const { t, te } = useI18n()
const { submitting, submit } = useScriptSubmission()
const state = ref(null)
const job = computed(() => state.value?.job)
const view = ref('outline')
const document = ref(null)
const readerError = ref(false)
const loadError = ref(false)
const readerRevision = ref(0)
const editing = ref(false)
const saving = ref(false)
const outlineDraft = ref(null)
const episodeDraft = ref(null)
const outlineRevision = ref(0)
const jobForm = ref(null)
const options = ref({})
const idea = ref('')
const uploading = ref(false)
const source = ref('')
const importState = ref({})
const novels = ref([])
const novelId = ref(null)
const loadingNovel = ref(false)
const outlineKeys = ['synopsis', 'characters', 'arc']
let poll
let sequence = 0
let unmounted = false
const episodeNumber = episode => episode.episode_number ?? episode.episodeNumber
const sortedEpisodes = computed(() => [...props.episodes].sort((a, b) => episodeNumber(a) - episodeNumber(b)))
const selectedEpisode = computed(() => sortedEpisodes.value.find(episode => view.value === `episode:${episode.id}`))
const previewParts = computed(() => job.value && job.value.kind !== 'rewrite' && job.value.status !== 'completed'
  ? job.value.parts : [])
const workflowBusy = computed(() => ['running', 'review'].includes(job.value?.status))
const canStart = computed(() => options.value.model && (uploading.value ? importState.value.ready
  : (jobForm.value === 'continue' && state.value?.outline) || idea.value.trim()))

function errorText(code) {
  const key = `projectScript.errors.${code}`
  const fallback = `novel.errors.${code}`
  return t(te(key) ? key : te(fallback) ? fallback : 'novel.errors.load_failed')
}

async function refresh() {
  clearTimeout(poll)
  const request = ++sequence
  try {
    const fresh = await projectScriptAPI.get(props.dramaId)
    if (unmounted || request !== sequence) return
    const prior = job.value
    state.value = fresh
    loadError.value = false
    const next = fresh.job
    if (next?.status === 'review' && prior?.status !== 'review') select('review')
    if (next?.status === 'completed' && (prior?.status !== next.status || prior?.id !== next.id)) {
      emit('published')
      if (view.value.startsWith('preview:')) select('outline')
    }
  } catch {
    if (!unmounted && request === sequence) loadError.value = true
  } finally {
    if (!unmounted && request === sequence) poll = setTimeout(refresh, job.value?.status === 'running' ? 1800 : 8000)
  }
}

function select(value) {
  editing.value = false
  jobForm.value = null
  view.value = value
}

watch([view, () => job.value?.id, readerRevision], async ([value, id], _, onCleanup) => {
  let stale = false
  onCleanup(() => { stale = true })
  document.value = null
  readerError.value = false
  try {
    let result
    if (value === 'source') {
      result = { script: (await projectScriptAPI.source(props.dramaId)).source }
    } else if (value === 'review' || value.startsWith('preview:')) {
      result = await projectScriptAPI.preview(props.dramaId, id, value === 'review' ? 1 : Number(value.split(':')[1]))
    } else if (value.startsWith('episode:')) {
      result = await projectScriptAPI.episode(props.dramaId, Number(value.split(':')[1]))
    }
    if (!stale) document.value = result ?? null
  } catch {
    if (!stale) readerError.value = true
  }
})

function editOutline() {
  outlineRevision.value = state.value?.revision ?? 0
  outlineDraft.value = { synopsis: '', characters: '', arc: '', ...state.value?.outline }
  editing.value = true
}

function editEpisode() {
  episodeDraft.value = { title: document.value.title, script: document.value.script ?? '', revision: document.value.revision }
  editing.value = true
}

async function perform(action) {
  if (saving.value) return
  saving.value = true
  try { await action() } catch (error) { toast.error(errorText(error.message)) } finally { saving.value = false }
}

function saveOutline() {
  return perform(async () => {
    await projectScriptAPI.outline(props.dramaId, { revision: outlineRevision.value, outline: outlineDraft.value })
    editing.value = false
    await refresh()
  })
}

function saveEpisode() {
  return perform(async () => {
    await projectScriptAPI.saveEpisode(props.dramaId, selectedEpisode.value.id, episodeDraft.value)
    editing.value = false
    readerRevision.value++
    emit('published')
  })
}

function openJob(kind) {
  editing.value = false
  idea.value = ''
  source.value = ''
  uploading.value = false
  importState.value = {}
  jobForm.value = kind
}

async function openUpload() {
  uploading.value = true
  try {
    novels.value = (await novelAPI.list(props.dramaId)).filter(job =>
      (job.draft_count > 0 && job.draft_done === job.draft_count)
      || (job.source_type === 'legacy' && job.episode_count && job.completed_chapters === job.episode_count))
  } catch { novels.value = [] }
}

async function useNovel() {
  loadingNovel.value = true
  try {
    source.value = (await projectScriptAPI.novel(props.dramaId, novelId.value)).source
  } catch (error) { toast.error(errorText(error.message)) } finally { loadingNovel.value = false }
}

async function startJob() {
  if (!canStart.value) return
  const kind = jobForm.value
  const value = {
    ...options.value, kind, idea: idea.value.trim() || undefined,
    ...(kind === 'rewrite' ? { target_id: selectedEpisode.value.id, revision: document.value.revision } : {}),
    ...(uploading.value ? { source_text: source.value, continuous: importState.value.continuous } : {}),
  }
  try {
    const result = await submit(value, request_id => projectScriptAPI.start(props.dramaId, { ...value, request_id }))
    if (result) {
      jobForm.value = null
      await refresh()
    }
  } catch (error) { toast.error(errorText(error.message)) }
}

function retry() {
  return perform(async () => {
    const { model, config_id } = options.value
    await projectScriptAPI.retry(props.dramaId, job.value.id, job.value.stage === 'publishing' ? {} : { model, config_id })
    await refresh()
  })
}

function resolve(apply) {
  return perform(async () => {
    const target = document.value.target_id
    await projectScriptAPI.resolve(props.dramaId, job.value.id, apply)
    select(target ? `episode:${target}` : 'outline')
    readerRevision.value++
    emit('published')
    await refresh()
  })
}

function produce() {
  return perform(async () => {
    const episode = selectedEpisode.value
    const number = episodeNumber(episode)
    await projectScriptAPI.produce(props.dramaId, episode.id)
    await navigateTo({ path: `/drama/${props.dramaId}/episode/${number}`,
      query: { episode_id: episode.id, from: 'script', ...(document.value.script ? { start: 'assets' } : {}) } })
  })
}

onMounted(refresh)
onBeforeUnmount(() => { unmounted = true; clearTimeout(poll) })
</script>

<style scoped>
.screenplay { display: grid; grid-template-columns: minmax(180px, 235px) minmax(0, 1fr); min-height: 500px; padding: 0; }
.screenplay-nav { border-right: 1px solid var(--border); padding: 18px 14px; display: flex; flex-direction: column; gap: 5px; }
.screenplay-nav h2 { margin: 0 8px 14px; }
.script-nav-item { border: 0; background: transparent; color: var(--text-1); text-align: start; cursor: pointer;
  padding: 10px 12px; border-radius: 10px; display: grid; gap: 3px; overflow-wrap: anywhere; font: inherit; }
.script-nav-item:hover { background: var(--bg-hover); }
.script-nav-item.selected { background: var(--accent-bg); color: var(--accent-text); }
.script-nav-item span { font-size: 13px; }
.script-add { margin-top: 12px; }
.screenplay-main { padding: 24px; min-width: 0; }
.screenplay h2 { font-size: 18px; }
.script-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
.script-actions h2 { margin: 0; overflow-wrap: anywhere; }
.script-prose { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; max-inline-size: 80ch; }
.outline-block { margin-top: 24px; }
.outline-block h3, .script-comparison h3 { font-size: 15px; }
.script-status { background: var(--bg-1); border-radius: 10px; padding: 12px; margin-bottom: 14px; }
.script-status p { margin: 0 0 8px; }
.script-editor, .script-editor label { display: grid; gap: 8px; }
.script-editor { gap: 16px; margin-top: 20px; }
.script-editor textarea { width: 100%; resize: vertical; }
.script-submit { justify-self: start; }
.script-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
@media (max-width: 720px) {
  .screenplay, .script-comparison { grid-template-columns: 1fr; }
  .screenplay-nav { border-right: 0; border-bottom: 1px solid var(--border); max-height: 230px; overflow: auto; }
  .screenplay-main { padding: 16px; }
}
</style>
