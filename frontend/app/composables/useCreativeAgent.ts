import { api, novelRequestId } from '~/composables/useApi'

export type CreativeReference = { kind: 'episode' | 'novel' | 'source'; id?: number; scene?: string }
export type CreativeSession = {
  id: number; title: string; updated_at: string; active_turn_id?: number | null;
  last_status?: CreativeTurn['status'] | null; last_model?: string | null; last_config_id?: number | null;
  last_error_code?: string | null;
  last_activity_at?: string | null;
}
export type CreativeTurn = {
  id: number; session_id: number; resume_from_id: number | null; message: string; references: CreativeReference[];
  config_id: number; model: string; created_at: string;
  status: 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' | 'stopped'; assistant_text: string; error_code: string | null;
}
export type CreativeChange = {
  id: number; kind: 'episode' | 'outline' | 'novel'; episode_id: number | null; episode_number: number | null;
  novel_id: number | null; part_number: number | null;
  title: string; scene: string | null; revision: string;
}
export type CreativeEvent = {
  seq: number; turn_id: number; created_at: string | null; kind: 'text' | 'tool_started' | 'tool_finished' | 'finished';
  payload: { text?: string; call_id?: string; tool?: string; status?: CreativeTurn['status']; error?: string | null;
    target?: { episode_id?: number; episode_number?: number; novel_id?: number; part_number?: number;
      job_status?: string; scene?: string }; change?: CreativeChange };
}
type ToolRow = { kind: 'tool'; seq: number; call: string; tool: string; target?: CreativeEvent['payload']['target'];
  startedAt?: string | null; endedAt?: string | null; durationMs?: number | null;
  state: 'running' | 'completed' | 'failed'; error?: string | null; change?: CreativeChange }
type Block = ToolRow | { kind: 'text'; seq: number; text: string }

export const creativePath = (projectId: number) => `/dramas/${projectId}/creative-agent`
export const creativeAPI = {
  resources: (projectId: number, after = 0, query = '') => {
    const params = new URLSearchParams({ after_episode: String(after) })
    if (query.trim()) params.set('query', query.trim())
    return api.get<{
      episodes: { id: number; number: number; title: string }[];
      novels: { id: number; title: string; status: string; part_count: number; revision: number; created_at: string }[];
      has_source: boolean; next_after_episode: number | null;
    }>(`${creativePath(projectId)}/resources?${params}`)
  },
  change: (projectId: number, turnId: number, id: number) => api.get<CreativeChange & { before: string | null; after: string }>(
    `${creativePath(projectId)}/turns/${turnId}/changes/${id}`),
}

export function useCreativeAgent(projectId: number, onSaved: () => void) {
  const path = creativePath(projectId)
  const sessions = ref<CreativeSession[]>([])
  const nextSession = ref<number | null>(null)
  const selected = ref<number | null>(null)
  const turns = ref<CreativeTurn[]>([])
  const events = ref<CreativeEvent[]>([])
  const beforeId = ref<number | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const stopping = ref(false)
  const error = ref('')
  const connected = ref(true)
  const running = computed(() => turns.value.find(turn => turn.status === 'running'))
  let stream: EventSource | undefined
  let streamTurn: number | undefined
  let streamTimer: ReturnType<typeof setTimeout> | undefined
  let selection = 0
  let historyLoaded = false
  let disposed = false
  let request: { fingerprint: string; id: string } | undefined

  const timelines = computed(() => {
    const result = new Map<number, Block[]>()
    const tools = new Map<string, ToolRow>()
    for (const event of events.value) {
      const { payload } = event
      const list = result.get(event.turn_id) ?? []
      result.set(event.turn_id, list)
      if (event.kind === 'text' && payload.text) {
        const prior = list.at(-1)
        if (prior?.kind === 'text') prior.text += payload.text
        else list.push({ kind: 'text', seq: event.seq, text: payload.text })
      }
      if (event.kind === 'tool_started' && payload.call_id && payload.tool) {
        const row: ToolRow = { kind: 'tool', seq: event.seq, call: payload.call_id, tool: payload.tool,
          state: 'running', target: payload.target, startedAt: event.created_at }
        list.push(row)
        tools.set(`${event.turn_id}/${payload.call_id}`, row)
      }
      if (event.kind === 'tool_finished') {
        const row = tools.get(`${event.turn_id}/${payload.call_id}`)
        if (row) {
          row.state = payload.error ? 'failed' : 'completed'
          row.error = payload.error
          row.change = payload.change
          row.target = { ...row.target, ...payload.target }
          row.endedAt = event.created_at
          if (row.startedAt && event.created_at) row.durationMs = Math.max(0, Date.parse(event.created_at) - Date.parse(row.startedAt))
        }
      }
    }
    return result
  })

  function merge(history: CreativeTurn[], incoming: CreativeEvent[]) {
    const byTurn = new Map(turns.value.map(turn => [turn.id, turn]))
    for (const turn of history) byTurn.set(turn.id, turn)
    const bySeq = new Map(events.value.map(item => [item.seq, item]))
    for (const item of incoming) {
      if (bySeq.has(item.seq)) continue
      bySeq.set(item.seq, item)
      if (item.kind === 'finished' && item.payload.status) {
        const turn = byTurn.get(item.turn_id)
        if (turn) byTurn.set(turn.id, { ...turn, status: item.payload.status, error_code: item.payload.error ?? null })
      }
    }
    turns.value = [...byTurn.values()].sort((a, b) => a.id - b.id)
    events.value = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }

  async function loadSessions(append = false) {
    const result = await api.get<{ sessions: CreativeSession[]; next_offset: number | null }>(
      `${path}/sessions?offset=${append ? nextSession.value ?? 0 : 0}`)
    if (disposed) return
    const merged = new Map((append ? sessions.value : []).map(session => [session.id, session]))
    for (const session of result.sessions) merged.set(session.id, session)
    sessions.value = [...merged.values()]
    nextSession.value = result.next_offset
  }

  async function loadTurns(id: number, earlier = false) {
    const version = selection
    const result = await api.get<{ session: CreativeSession; turns: CreativeTurn[]; events: CreativeEvent[]; before_id: number | null }>(
      `${path}/sessions/${id}/turns${earlier ? `?before_id=${beforeId.value}` : ''}`)
    if (disposed || selection !== version || selected.value !== id) return
    merge(result.turns, result.events)
    if (earlier || !historyLoaded) beforeId.value = result.before_id
    historyLoaded = true
    if (!sessions.value.some(session => session.id === id)) sessions.value.push(result.session)
  }

  function remember(id: number | null) {
    try { localStorage.setItem(`musereel:creative:${projectId}`, id === null ? '' : String(id)) } catch { /* optional preference */ }
  }

  async function selectSession(id: number | null) {
    const version = ++selection
    selected.value = id
    remember(id)
    turns.value = []
    events.value = []
    beforeId.value = null
    historyLoaded = false
    error.value = ''
    loading.value = id !== null
    if (id === null) return
    try { await loadTurns(id) } catch (e) { if (version === selection) error.value = errorCode(e) }
    finally { if (version === selection) loading.value = false }
  }

  async function send(message: string, references: CreativeReference[], model?: { config_id: number; model: string }, resumeFromId?: number) {
    if (sending.value || running.value || loading.value) return false
    const version = selection
    const data = { session_id: selected.value ?? undefined, resume_from_id: resumeFromId, message, references, ...model }
    const fingerprint = JSON.stringify(data)
    if (request?.fingerprint !== fingerprint) request = { fingerprint, id: novelRequestId() }
    sending.value = true
    error.value = ''
    try {
      const turn = await api.post<CreativeTurn>(`${path}/turns`, { ...data, request_id: request.id }, false)
      request = undefined
      if (!disposed && version === selection) {
        selected.value = turn.session_id
        remember(turn.session_id)
        merge([turn], [])
      }
      if (!disposed) void loadSessions().catch(() => {})
      return turn
    } catch (e) {
      if (!disposed && version === selection) {
        error.value = errorCode(e)
        if (error.value === 'chat_running' && selected.value !== null) void loadTurns(selected.value).catch(() => {})
      }
      return null
    } finally { sending.value = false }
  }

  async function stop() {
    if (!running.value || stopping.value) return
    stopping.value = true
    const id = selected.value
    try {
      await api.post(`${path}/turns/${running.value.id}/stop`)
      if (id !== null && selected.value === id) await loadTurns(id)
    } catch (e) { error.value = errorCode(e) }
    finally { stopping.value = false }
  }

  async function rename(id: number, title: string) {
    const updated = await api.patch<CreativeSession>(`${path}/sessions/${id}`, { title }, false)
    sessions.value = sessions.value.map(session => session.id === updated.id ? updated : session)
  }

  watch(() => running.value?.id, id => {
    if (streamTurn === id) return
    stream?.close()
    clearTimeout(streamTimer)
    streamTurn = id
    connected.value = true
    if (id === undefined || disposed) return
    const after = events.value.reduce((last, item) => item.turn_id === id ? Math.max(last, item.seq) : last, 0)
    const connection = new EventSource(`/api/v1${path}/turns/${id}/events?after_seq=${after}`)
    stream = connection
    connection.onopen = () => { if (stream === connection) connected.value = true }
    connection.onmessage = incoming => {
      if (stream !== connection || streamTurn !== id) return
      const item = JSON.parse(incoming.data) as CreativeEvent
      const fresh = !events.value.some(existing => existing.seq === item.seq)
      merge([], [item])
      if (fresh && (item.payload.change || item.payload.target?.job_status === 'completed')) onSaved()
      if (item.kind === 'finished') connection.close()
    }
    connection.onerror = () => {
      if (stream !== connection || streamTurn !== id) return
      connected.value = false
      clearTimeout(streamTimer)
      streamTimer = setTimeout(async () => {
        if (selected.value === null || stream !== connection) return
        const count = events.value.filter(item => item.payload.change || item.payload.target?.job_status === 'completed').length
        await loadTurns(selected.value).catch(() => {})
        if (events.value.filter(item => item.payload.change || item.payload.target?.job_status === 'completed').length > count) onSaved()
      }, 900)
    }
  })

  async function initialize() {
    await loadSessions()
    let remembered: string | null = null
    try { remembered = localStorage.getItem(`musereel:creative:${projectId}`) } catch { /* optional preference */ }
    const id = remembered === null ? sessions.value[0]?.id ?? null : Number(remembered) || null
    await selectSession(id)
  }

  onBeforeUnmount(() => { disposed = true; stream?.close(); clearTimeout(streamTimer); selection++ })
  return { sessions, nextSession, selected, turns, events, beforeId, loading, sending, stopping, error, connected,
    running, timelines, loadSessions, selectSession, send, stop, rename, initialize,
    loadEarlier: async () => { if (selected.value !== null && beforeId.value !== null) await loadTurns(selected.value, true) } }
}

export function errorCode(error: unknown) {
  return error instanceof Error ? error.message : 'load_failed'
}
