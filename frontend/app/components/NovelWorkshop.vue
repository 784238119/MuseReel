<template>
  <div class="novel-layout">
    <p v-if="!ready && !listError" role="status" class="dim">{{ t('novel.loading') }}</p>
    <p v-if="listError" class="novel-actions" role="status">
      {{ t('novel.errors.load_failed') }}
      <button class="btn btn-sm" type="button" @click="refresh">{{ t('novel.reload') }}</button>
    </p>
    <form v-if="ready && (creating || !job)" class="card novel-panel" @submit.prevent="start">
      <div class="novel-heading">
        <h2>{{ t('novel.prepare') }}</h2>
        <button v-if="job" class="btn btn-sm" type="button" @click="creating = false">{{ t('common.back') }}</button>
      </div>
      <div class="novel-tabs" role="group" :aria-label="t('novel.title')">
        <button v-for="type in ['ai', 'import']" :key="type" type="button" class="btn"
          :class="{ 'btn-primary': sourceType === type }" :aria-pressed="sourceType === type"
          @click="sourceType = type">{{ t(`novel.sources.${type}`) }}</button>
      </div>
      <label v-if="sourceType === 'ai'">
        {{ t('novel.brief') }}
        <textarea v-model="brief" class="textarea" rows="5" maxlength="8000" required
          :placeholder="t('novel.briefPlaceholder')" />
      </label>
      <template v-else>
        <label>
          {{ t('novel.sourceText') }}
          <textarea v-model="sourceText" class="textarea" rows="8" required
            :placeholder="t('novel.sourcePlaceholder')" />
        </label>
        <label class="novel-upload">
          {{ t('novel.file') }}
          <input type="file" accept=".txt,.md" :disabled="fileLoading" @change="loadFile" />
        </label>
        <p v-if="sourceTooLarge" role="alert" class="dim">{{ t('novel.errors.source_too_large') }}</p>
      </template>
      <div v-if="sourceType === 'ai'" class="novel-fields">
        <label>
          {{ t('novel.totalLength') }}
          <input v-model.number="targetLength" class="input" type="number" min="500" max="500000" required />
        </label>
        <ModelSelect v-if="modelOptions.length" v-model="selectedModel" :label="t('novel.model')"
          :options="modelOptions" :default-label="modelOptions[0].label" />
      </div>
      <p v-if="sourceType === 'ai' && modelsLoaded && !modelOptions.length" class="dim">{{ t('novel.errors.model_unavailable') }}</p>
      <div v-if="sourceType === 'ai' && modelsLoadFailed" class="novel-actions">
        <span role="status" class="dim">{{ t('novel.errors.models_load_failed') }}</span>
        <button type="button" class="btn" :disabled="modelsLoading" @click="loadModels">
          {{ t('novel.reloadModels') }}
        </button>
      </div>
      <div class="novel-actions">
        <button class="btn btn-primary" :disabled="busy || !hasInput || (sourceType === 'ai' && (!!runningJob || !modelOptions.length))">
          {{ t(sourceType === 'import' ? 'novel.saveDraft' : 'novel.generateDraft') }}
        </button>
      </div>
    </form>

    <section v-if="job && !creating" class="card novel-panel">
      <div class="novel-heading">
        <h2 ref="previewHeading" tabindex="-1">{{ t(versions.length ? 'novel.preview' : 'novel.prepare') }}</h2>
        <div class="novel-actions">
          <label v-if="jobs.length > 1">
            {{ t('novel.history') }}
            <BaseSelect v-model="selectedJob" :options="jobOptions" />
          </label>
          <button v-if="!runningJob" class="btn btn-sm" type="button" @click="creating = true">{{ t('novel.newNovel') }}</button>
        </div>
      </div>
      <div v-if="job.status !== 'completed' || !publishedEpisodes.length" class="novel-actions">
        <span role="status">{{ t(`novel.states.${job.status === 'running' ? job.stage : job.status}`) }}
          <template v-if="progress"> · {{ progress.label }}</template></span>
      </div>
      <progress v-if="job.status === 'running'" class="novel-progress" :value="progress?.done"
        :max="progress?.total ?? 1" :aria-label="progress?.label ?? t(`novel.states.${job.stage}`)" />
      <p v-if="job.error_code" class="dim">{{ errorMessage(job.error_code) }}</p>
      <form v-if="canSplit" class="novel-split" @submit.prevent="split">
        <div class="novel-fields">
          <label>
            {{ t('novel.episodeCount') }}
            <input v-model.number="episodeCount" class="input" type="number" min="1" :max="splitCountMax" required />
          </label>
          <ModelSelect v-if="modelOptions.length" v-model="splitModel" :label="t('novel.model')"
            :options="modelOptions" :default-label="modelOptions[0].label" />
          <button class="btn btn-primary" :disabled="busy || !!runningJob || !modelOptions.length">
            {{ t('novel.splitNow') }}
          </button>
        </div>
        <p class="dim">{{ t('novel.appendHint') }}</p>
        <p v-if="modelsLoaded && !modelOptions.length" class="dim">{{ t('novel.errors.model_unavailable') }}</p>
        <div v-if="modelsLoadFailed" class="novel-actions">
          <span role="status" class="dim">{{ t('novel.errors.models_load_failed') }}</span>
          <button type="button" class="btn btn-sm" :disabled="modelsLoading" @click="loadModels">{{ t('novel.reloadModels') }}</button>
        </div>
      </form>
      <div v-if="job.status === 'completed' && publishedEpisodes.length" class="novel-actions novel-result">
        <p>{{ t('novel.published', { count: publishedEpisodes.length, range: publishedRange }) }}</p>
        <button class="btn btn-primary" type="button" @click="emit('viewEpisodes', publishedEpisodes[0].episode_id)">
          {{ t('novel.viewEpisodes') }}
        </button>
      </div>
      <form v-if="!canSplit && ['failed', 'interrupted'].includes(job.status)" class="novel-fields" @submit.prevent="retry">
        <template v-if="needsWriting">
          <ModelSelect v-if="modelOptions.length" v-model="retryModel" :label="t('novel.model')"
            :options="modelOptions" :default-label="t('novel.keepModel', { model: job.model })" />
          <label v-if="canChangeLength">
            {{ t(job.workflow_mode === 'preview_first' ? 'novel.totalLength' : 'novel.targetLength') }}
            <input v-model.number="retryLength" class="input" type="number" min="500"
              :max="job.target_length" required />
          </label>
        </template>
        <button class="btn" :disabled="busy || !!runningJob">{{ t('novel.retry') }}</button>
      </form>
      <div v-if="versions.length > 1" class="novel-tabs" role="group" :aria-label="t('novel.manuscripts')">
        <button v-for="version in versions" :key="version" class="btn" type="button"
          :class="{ 'btn-primary': readerVersion === version }" :aria-pressed="readerVersion === version"
          @click="pickVersion(version)">{{ t(`novel.versions.${version}`) }}</button>
      </div>
      <template v-if="readerVersion === 'episodes' && chapterOptions.length">
        <label>
          {{ t('novel.chapters') }}
          <BaseSelect v-model="selectedChapter" :options="chapterOptions" />
        </label>
        <article v-if="chapter" class="novel-chapter">
          <div class="novel-actions">
            <h3>{{ chapter.title }}</h3>
            <NuxtLink v-if="chapterEpisode?.episode_number" class="btn btn-sm"
              :to="{ path: `/drama/${dramaId}/episode/${chapterEpisode.episode_number}`,
                query: { episode_id: chapterEpisode.id } }">
              {{ t('novel.openEpisode', { n: chapterEpisode.episode_number }) }}
            </NuxtLink>
          </div>
          <div class="novel-prose">{{ chapter.content }}</div>
        </article>
      </template>
      <template v-else-if="readerVersion && readerVersion !== 'episodes'">
        <article v-if="manuscript !== null" ref="manuscriptBody" tabindex="-1" class="novel-prose">{{ manuscript }}</article>
        <p v-else-if="!manuscriptError" role="status" class="dim">{{ t('novel.loading') }}</p>
        <div v-if="job.draft_count > 1" class="novel-actions">
          <button class="btn btn-sm" type="button" :disabled="partNumber <= 1" @click="changePart(-1)">{{ t('novel.previous') }}</button>
          <span>{{ t('novel.part', { part: partNumber, total: job.draft_count }) }}</span>
          <button class="btn btn-sm" type="button" :disabled="partNumber >= job.draft_count" @click="changePart(1)">{{ t('novel.next') }}</button>
        </div>
      </template>
      <button v-if="readerError || manuscriptError" class="btn" type="button"
        @click="readerError ? readerAttempt++ : manuscriptAttempt++">
        {{ t('novel.reloadChapter') }}
      </button>
    </section>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import BaseSelect from '~/components/BaseSelect.vue'
import ModelSelect from '~/components/ModelSelect.vue'
import { aiConfigAPI, novelAPI } from '~/composables/useApi'
import { collectModelOptions, resolveTextModelSelection } from '~/utils/text-model-selection'

const props = defineProps({
  dramaId: { type: Number, required: true },
  episodes: { type: Array, required: true },
})
const emit = defineEmits(['published', 'viewEpisodes'])
const { t, te, locale } = useI18n()
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const sourceType = ref('ai')
const sourceText = ref('')
const fileLoading = ref(false)
const brief = ref('')
const episodeCount = ref(10)
const targetLength = ref(10000)
const selectedModel = ref('')
const splitModel = ref('')
const creating = ref(false)
const previewHeading = ref(null)
const retryModel = ref('')
const retryLength = ref(1000)
const modelOptions = ref([])
const modelsLoaded = ref(false)
const modelsLoading = ref(false)
const modelsLoadFailed = ref(false)
const jobs = ref([])
const selectedJob = ref(null)
const jobDetail = ref(null)
const selectedChapter = ref(null)
const chapter = ref(null)
const busy = ref(false)
const ready = ref(false)
const listError = ref(false)
const readerError = ref(false)
const readerAttempt = ref(0)
const pinnedVersion = ref(null)
const partNumber = ref(1)
const manuscript = ref(null)
const manuscriptBody = ref(null)
const focusNextPart = ref(false)
const manuscriptError = ref(false)
const manuscriptAttempt = ref(0)
let timer
let disposed = false
let request
let refreshSequence = 0

const job = computed(() => jobs.value.find(item => item.id === selectedJob.value))
const runningJob = computed(() => jobs.value.find(item => item.status === 'running'))
const jobOptions = computed(() => jobs.value.map(item => ({
  value: item.id,
  label: [new Date(item.created_at).toLocaleString(locale.value),
    item.source_type === 'legacy' ? item.model : t(`novel.sources.${item.source_type}`)].filter(Boolean).join(' · '),
})))
const chapterOptions = computed(() => (jobDetail.value?.chapters ?? []).map(item => ({
  value: item.chapter_number,
  label: `${item.episode_number ?? item.chapter_number}. ${item.title}`,
})))
const chapterEpisode = computed(() => {
  const item = jobDetail.value?.chapters.find(item => item.chapter_number === selectedChapter.value)
  return props.episodes.find(episode => episode.id === item?.episode_id)
})
const publishedEpisodes = computed(() => (jobDetail.value?.chapters ?? []).filter(item => item.episode_id))
const publishedRange = computed(() => {
  const numbers = publishedEpisodes.value.map(item => item.episode_number)
  if (numbers.length <= 1) return numbers[0]
  return numbers.every((number, index) => number === numbers[0] + index)
    ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join(', ')
})
const needsWriting = computed(() => job.value
  && (job.value.episode_count == null || job.value.completed_chapters < job.value.episode_count))
const canReadNovel = computed(() => !!job.value && !needsWriting.value)
const canSplit = computed(() => job.value?.workflow_mode === 'preview_first'
  && (job.value.status === 'ready' || (job.value.status === 'failed'
    && job.value.error_code === 'manuscript_too_short' && job.value.episode_count > 1)))
const splitCountMax = computed(() => job.value?.error_code === 'manuscript_too_short' ? job.value.episode_count - 1 : 100)
const canChangeLength = computed(() => job.value?.source_type === 'legacy'
  || (job.value?.source_type === 'ai' && ['planning', 'writing'].includes(job.value.stage)))
const sourceTooLarge = computed(() => new TextEncoder().encode(sourceText.value).length > MAX_SOURCE_BYTES)
const hasInput = computed(() => sourceType.value === 'ai' ? !!brief.value.trim()
  : !!sourceText.value.trim() && !sourceTooLarge.value && !fileLoading.value)
const versions = computed(() => {
  const item = job.value
  if (!item) return []
  const available = []
  if (item.draft_count && item.draft_done === item.draft_count) available.push('draft')
  if (item.draft_count && item.optimized_done === item.draft_count) available.push('optimized')
  if (canReadNovel.value) available.push('episodes')
  return available
})
const readerVersion = computed(() => {
  const pin = pinnedVersion.value
  if (pin?.jobId === selectedJob.value && versions.value.includes(pin.version)) return pin.version
  if (job.value?.workflow_mode === 'preview_first' && versions.value.includes('draft')) return 'draft'
  return versions.value.at(-1) ?? null
})
const progress = computed(() => {
  const item = job.value
  if (!item) return
  if (item.source_type === 'legacy') {
    return { done: item.completed_chapters, total: item.episode_count,
      label: t('novel.progress', { done: item.completed_chapters, total: item.episode_count }) }
  }
  let done = item.completed_chapters
  let total = item.episode_count
  let label = 'episodeProgress'
  if (item.stage === 'writing' || item.stage === 'optimizing') {
    done = item.stage === 'writing' ? item.draft_done : item.optimized_done
    total = item.draft_count
    label = 'partProgress'
  } else if (!total || ['planning', 'analyzing'].includes(item.stage)) return
  return { done, total, label: t(`novel.${label}`, { done, total }) }
})

watch(selectedJob, () => {
  focusNextPart.value = false
  partNumber.value = 1
})

function changePart(step) {
  focusNextPart.value = true
  partNumber.value += step
}

function pickVersion(version) {
  manuscriptError.value = false
  pinnedVersion.value = { jobId: selectedJob.value, version }
}
watch([selectedJob, readerVersion, partNumber, manuscriptAttempt], async ([id, version, part], _, onCleanup) => {
  let stale = false
  onCleanup(() => { stale = true })
  manuscript.value = null
  manuscriptError.value = false
  if (!id || !['draft', 'optimized'].includes(version)) return
  try {
    const result = await novelAPI.manuscript(props.dramaId, id, version, part)
    if (!stale) {
      manuscript.value = result.content
      if (focusNextPart.value) {
        focusNextPart.value = false
        await nextTick()
        if (!stale) {
          manuscriptBody.value?.scrollIntoView({ block: 'start' })
          manuscriptBody.value?.focus({ preventScroll: true })
        }
      }
    }
  } catch {
    if (!stale) manuscriptError.value = true
  }
})

async function loadFile(event) {
  const input = event.currentTarget
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > MAX_SOURCE_BYTES) return toast.error(errorMessage('source_too_large'))
  if (!/\.(txt|md)$/i.test(file.name)) return toast.error(errorMessage('invalid_file'))
  fileLoading.value = true
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    if (!text.trim()) return toast.error(errorMessage('invalid_file'))
    sourceText.value = text
  } catch {
    toast.error(errorMessage('invalid_file'))
  } finally {
    fileLoading.value = false
  }
}

watch([selectedJob, () => job.value?.target_length], ([, length]) => {
  retryModel.value = ''
  retryLength.value = length ?? 1000
})
watch(() => job.value?.id, () => {
  const item = job.value
  const suggested = item?.target_length == null ? 10 : Math.max(1, Math.min(100, Math.round(item.target_length / 1000)))
  episodeCount.value = item?.episode_count ?? suggested
  splitModel.value = item?.config_id && item.model ? `${item.config_id}/${item.model}` : ''
})
watch(splitCountMax, max => {
  if (max >= 1 && episodeCount.value > max) episodeCount.value = max
})

function errorMessage(code) {
  const key = `novel.errors.${code}`
  return te(key) ? t(key) : t('novel.errors.load_failed')
}

async function refresh() {
  clearTimeout(timer)
  const sequence = ++refreshSequence
  try {
    const next = await novelAPI.list(props.dramaId)
    if (disposed || sequence !== refreshSequence) return
    const completed = new Set(jobs.value.filter(item => item.status === 'completed').map(item => item.id))
    jobs.value = next
    selectedJob.value ??= (runningJob.value ?? next[0])?.id ?? null
    if (next.some(item => item.status === 'completed' && !completed.has(item.id))) emit('published')
    listError.value = false
    ready.value = true
  } catch {
    if (!disposed && sequence === refreshSequence) listError.value = true
  } finally {
    if (!disposed && sequence === refreshSequence) timer = setTimeout(refresh, runningJob.value ? 2000 : 10000)
  }
}

watch([selectedJob, canReadNovel, () => job.value?.status, readerAttempt], async ([id, readable], _, onCleanup) => {
  let stale = false
  onCleanup(() => { stale = true })
  const previousChapter = jobDetail.value?.id === id ? selectedChapter.value : null
  jobDetail.value = null
  selectedChapter.value = null
  readerError.value = false
  if (!readable) return
  try {
    const result = await novelAPI.get(props.dramaId, id)
    if (stale) return
    jobDetail.value = result
    selectedChapter.value = previousChapter ?? result.chapters[0]?.chapter_number ?? null
  } catch {
    if (!stale) readerError.value = true
  }
})

watch([selectedJob, selectedChapter, readerVersion, jobDetail], async ([id, number, version, detail], _, onCleanup) => {
  let stale = false
  onCleanup(() => { stale = true })
  chapter.value = null
  if (version !== 'episodes' || detail?.id !== id || number === null) return
  readerError.value = false
  try {
    const result = await novelAPI.chapter(props.dramaId, id, number)
    if (!stale) chapter.value = result
  } catch {
    if (!stale) readerError.value = true
  }
})

async function submit(action, allowWhileRunning = false) {
  if (busy.value || (!allowWhileRunning && runningJob.value)) return
  busy.value = true
  try {
    const result = await action()
    if (!disposed) {
      jobs.value = [result, ...jobs.value.filter(item => item.id !== result.id)]
      selectedJob.value = result.id
      creating.value = false
      await nextTick()
      previewHeading.value?.focus({ preventScroll: true })
    }
  } catch (error) {
    if (!disposed) toast.error(errorMessage(error.message))
  } finally {
    if (!disposed) await refresh()
    busy.value = false
  }
}

function start() {
  const imported = sourceType.value === 'import'
  const { model, configId } = resolveTextModelSelection(modelOptions.value, selectedModel.value)
  if ((!imported && !model) || !hasInput.value) return
  const data = imported ? { source_type: 'import', source_text: sourceText.value }
    : { source_type: 'ai', brief: brief.value.trim(), target_length: targetLength.value, model, config_id: configId }
  const fingerprint = JSON.stringify(data)
  if (request?.fingerprint !== fingerprint) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    request = { fingerprint, id }
  }
  return submit(async () => {
    const result = await novelAPI.create(props.dramaId, { ...data, workflow_mode: 'preview_first', request_id: request.id })
    request = null
    if (imported) sourceText.value = ''
    else brief.value = ''
    return result
  }, imported)
}

function split() {
  const { model, configId } = resolveTextModelSelection(modelOptions.value, splitModel.value)
  if (!canSplit.value || !model) return
  return submit(() => novelAPI.split(props.dramaId, job.value.id, {
    episode_count: episodeCount.value, model, config_id: configId,
  }))
}

function retry() {
  const data = {}
  if (needsWriting.value) {
    if (canChangeLength.value && retryLength.value !== job.value.target_length) data.target_length = retryLength.value
    const selected = modelOptions.value.find(option => option.key === retryModel.value)
    if (selected) {
      data.model = selected.model
      data.config_id = selected.configId
    }
  }
  return submit(() => novelAPI.retry(props.dramaId, job.value.id, data))
}

async function loadModels() {
  if (modelsLoading.value) return
  modelsLoading.value = true
  try {
    const configs = await aiConfigAPI.list('text')
    if (disposed) return
    modelOptions.value = collectModelOptions(configs || [], true)
    modelsLoaded.value = true
    modelsLoadFailed.value = false
  } catch {
    if (!disposed) modelsLoadFailed.value = true
  } finally {
    modelsLoading.value = false
  }
}

onMounted(() => {
  void refresh()
  void loadModels()
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})
</script>

<style scoped>
.novel-layout, .novel-panel { display: grid; gap: 16px; }
.novel-layout { max-width: 900px; margin-inline: auto; }
.novel-panel { padding: 20px; }
.novel-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
.novel-heading h2 { margin: 0; font-size: 18px; }
.novel-split, .novel-result { padding: 14px; border-radius: 12px; background: var(--surface, rgba(127, 127, 127, 0.08)); }
.novel-split p { margin: 8px 0 0; }
.novel-result p { margin: 0; }
.novel-panel label { display: grid; gap: 6px; font-size: 13px; }
.novel-panel textarea { width: 100%; resize: vertical; }
.novel-fields, .novel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
.novel-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.novel-upload input { max-width: 100%; }
.novel-fields input { width: 120px; }
.novel-progress { width: 100%; }
.novel-chapter h3 { margin: 0; }
.novel-prose { margin-top: 14px; scroll-margin-top: 80px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.85; }
</style>
