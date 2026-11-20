<template>
  <div class="script-options">
    <label v-if="!hideCount && !importCount">
      {{ t('projectScript.count') }}
      <input v-model.number="count" type="number" class="input" min="1" max="100" required />
    </label>
    <label v-if="!modelOnly">
      {{ t('projectScript.duration') }}
      <select v-model="duration" class="input">
        <option v-for="value in ['30–60s', '1–2m', '2–3m']" :key="value" :value="value">
          {{ t(`projectScript.durations.${value}`) }}
        </option>
      </select>
    </label>
    <ModelSelect v-if="options.length" v-model="selection" :label="t('novel.model')"
      :options="options" :default-label="options[0].label" />
    <div v-else-if="!loading" class="script-model-status">
      <span class="dim" role="status">{{ t(failed ? 'novel.errors.models_load_failed' : 'novel.errors.model_unavailable') }}</span>
      <button type="button" class="btn btn-sm" @click="load">{{ t('novel.reloadModels') }}</button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import ModelSelect from '~/components/ModelSelect.vue'
import { aiConfigAPI } from '~/composables/useApi'
import { collectModelOptions, resolveTextModelSelection } from '~/utils/text-model-selection'

const props = defineProps({
  importCount: { type: Number, default: null },
  hideCount: Boolean,
  modelOnly: Boolean,
  preferred: { type: String, default: '' },
})
const data = defineModel({ type: Object, required: true })
const { t } = useI18n()
const count = ref(5)
const duration = ref('1–2m')
const options = ref([])
const selection = ref(props.preferred)
const loading = ref(true)
const failed = ref(false)

watch([count, duration, options, selection, () => props.importCount], () => {
  const { model, configId } = resolveTextModelSelection(options.value, selection.value)
  data.value = { episode_count: props.importCount ?? count.value, duration: duration.value, model, config_id: configId }
}, { immediate: true })

async function load() {
  loading.value = true
  failed.value = false
  try {
    options.value = collectModelOptions(await aiConfigAPI.list('text') ?? [], true)
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<style scoped>
.script-options, .script-model-status { display: flex; align-items: end; gap: 10px 16px; flex-wrap: wrap; }
.script-options label { display: grid; gap: 6px; font-size: 13px; }
.script-options input { width: 90px; }
</style>
