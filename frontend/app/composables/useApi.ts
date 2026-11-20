const BASE = '/api/v1'

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function req<T = any>(method: string, path: string, body?: any, logBody = true): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', logBody && body ? body : '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new ApiError(json.message || `${resp.status}`, resp.ok ? json.code : resp.status)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas?episode_summary=1'),
  get: (id: number) => api.get(`/dramas/${id}?episode_summary=1`),
  getEpisode: (id: number, number: number, expectedId?: string) => api.get(
    `/dramas/${id}/episodes/${number}${expectedId === undefined ? '' : `?episode_id=${encodeURIComponent(expectedId)}`}`,
  ),
  create: (data: any) => req('POST', '/dramas', data, !data.script_creation),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const projectScriptAPI = {
  inspect: (source_text: string) => req('POST', '/dramas/script-import-preview', { source_text }, false),
  get: (dramaId: number) => api.get(`/dramas/${dramaId}/script`),
  source: (dramaId: number) => api.get(`/dramas/${dramaId}/script/source`),
  novel: (dramaId: number, jobId: number) => api.get(`/dramas/${dramaId}/script/novels/${jobId}`),
  outline: (dramaId: number, data: object) => req('PUT', `/dramas/${dramaId}/script/outline`, data, false),
  episode: (dramaId: number, id: number) => api.get(`/dramas/${dramaId}/script/episodes/${id}`),
  saveEpisode: (dramaId: number, id: number, data: object) => req('PUT', `/dramas/${dramaId}/script/episodes/${id}`, data, false),
  produce: (dramaId: number, id: number) => api.post(`/dramas/${dramaId}/script/episodes/${id}/production`),
  start: (dramaId: number, data: object) => req('POST', `/dramas/${dramaId}/script/jobs`, data, false),
  preview: (dramaId: number, id: number, ordinal: number) => api.get(`/dramas/${dramaId}/script/jobs/${id}/preview/${ordinal}`),
  retry: (dramaId: number, id: number, data: object) => api.post(`/dramas/${dramaId}/script/jobs/${id}/retry`, data),
  resolve: (dramaId: number, id: number, apply: boolean) => api.post(`/dramas/${dramaId}/script/jobs/${id}/resolve`, { apply }),
}

export type NovelChatProposal = { base_revision: number; content: string } & (
  { kind: 'plan' }
  | { kind: 'append'; part_number: number }
  | { kind: 'replace'; part_number: number; original_text: string }
)

export interface NovelChatTurn {
  id: number
  message: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  config_id: number
  model: string
  assistant_text: string | null
  proposal: NovelChatProposal | null
  applied_at: string | null
  error_code: string | null
}

interface NovelChatHistory {
  turns: NovelChatTurn[]
  before_id: number | null
  active_turn: NovelChatTurn | null
  story_plan: string | null
  draft_revision: number
  applied_turns: { id: number; applied_at: string | null }[]
}

type NovelModel = { config_id: number; model: string }

export function novelRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function novelChatPath(dramaId: number, jobId: number) {
  return `/dramas/${dramaId}/novel-jobs/${jobId}/chat/turns`
}

export const novelAPI = {
  list: (dramaId: number) => api.get(`/dramas/${dramaId}/novel-jobs`),
  create: (dramaId: number, data: {
    request_id: string
    content_language?: string
  } & (({ start_mode: 'chat'; message: string } & NovelModel)
    | ({ workflow_mode: 'preview_first'; source_type: 'ai'; brief: string; target_length: number } & NovelModel)
    | { workflow_mode: 'preview_first'; source_type: 'import'; source_text: string })) =>
    req('POST', `/dramas/${dramaId}/novel-jobs`, data, false),
  split: (dramaId: number, id: number, data: { episode_count: number; config_id: number; model: string; draft_revision?: number }) =>
    api.post(`/dramas/${dramaId}/novel-jobs/${id}/split`, data),
  get: (dramaId: number, id: number) => api.get(`/dramas/${dramaId}/novel-jobs/${id}`),
  chapter: (dramaId: number, id: number, number: number) =>
    api.get(`/dramas/${dramaId}/novel-jobs/${id}/chapters/${number}`),
  manuscript: (dramaId: number, id: number, version: 'draft' | 'optimized', part: number) =>
    api.get(`/dramas/${dramaId}/novel-jobs/${id}/manuscripts/${version}/${part}`),
  retry: (dramaId: number, id: number, data: {
    config_id?: number
    model?: string
    target_length?: number
  }) => api.post(`/dramas/${dramaId}/novel-jobs/${id}/retry`, data),
  chatTurns: (dramaId: number, jobId: number, options: { beforeId?: number; afterRevision?: number } = {}) => {
    const query = new URLSearchParams()
    if (options.beforeId !== undefined) query.set('before_id', String(options.beforeId))
    if (options.afterRevision !== undefined) query.set('after_revision', String(options.afterRevision))
    const path = novelChatPath(dramaId, jobId)
    return api.get<NovelChatHistory>(query.size ? `${path}?${query}` : path)
  },
  sendTurn: (dramaId: number, jobId: number, data: { request_id: string; message: string } & Partial<NovelModel>) =>
    req<NovelChatTurn>('POST', novelChatPath(dramaId, jobId), data, false),
  retryTurn: (dramaId: number, jobId: number, id: number, data?: NovelModel) =>
    api.post<NovelChatTurn>(`${novelChatPath(dramaId, jobId)}/${id}/retry`, data),
  applyTurn: (dramaId: number, jobId: number, id: number) =>
    api.post<{ turn: NovelChatTurn; job: any; part_number: number | null }>(`${novelChatPath(dramaId, jobId)}/${id}/apply`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  uploadVoice: (id: number, file: File) => uploadReq<CharacterVoice>(`/characters/${id}/voice`, file),
  removeVoice: (id: number) => api.del<CharacterVoice>(`/characters/${id}/voice`),
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export interface CharacterVoice {
  voice_audio_url: string | null
  voice_audio_name: string | null
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  recover: (id: number) => api.post(`/tasks/${id}/recover`),
  diagnostics: (id: number) => api.get(`/tasks/${id}/diagnostics`),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
