interface TextModelOption {
  key: string
  model: string
  configId: number
}

interface ModelConfig {
  id: number
  model?: string | string[] | null
  provider: string
  name?: string
  priority?: number
  is_active: boolean
}

export function configModels(config?: ModelConfig | null): string[] {
  const raw = config?.model
  if (!raw) return []
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { value = raw }
  }
  const entries = Array.isArray(value) ? value : [value]
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim())
}

export function collectModelOptions(configs: ModelConfig[], distinguishConfigs = false) {
  const seen = new Set<string>()
  const options = []
  const sorted = configs.filter(config => config.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const config of sorted) {
    for (const model of configModels(config)) {
      const key = distinguishConfigs ? `${config.id}/${model}` : `${config.provider}/${model}`
      if (seen.has(key)) continue
      seen.add(key)
      const configName = config.name || config.provider
      const label = distinguishConfigs ? `${model} · ${configName} (#${config.id})` : model
      options.push({ key, model, label, provider: config.provider, configId: config.id, configName })
    }
  }
  return options
}

/** 默认项显示 options[0]，请求也必须使用同一模型及其配置，避免后端再次选型。 */
export function resolveTextModelSelection(options: TextModelOption[], selectedKey: string) {
  const selected = options.find(option => option.key === selectedKey)
    ?? options.find(option => option.model === selectedKey) // 兼容旧版存储的裸模型名
    ?? options[0]
  return { model: selected?.model, configId: selected?.configId }
}
