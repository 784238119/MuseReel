import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createTextModel } from '../agents/index.js'
import { buildLanguageDirective } from '../agents/language.js'
import { NOVEL_PROMPTS } from '../agents/novel-prompts.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { loadAgentSkills } from '../agents/skills.js'
import { db, schema } from '../db/index.js'
import type { NovelEditProposal } from '../db/schema.js'
import { now } from '../utils/response.js'
import { activeNovelChatTurnFilter, clearNovelLease, findNovelProject, jobFields, maintainNovelLease, resolveNovelModel } from './novels.js'

const { novelJobs, novelChatTurns: turns, novelManuscriptParts: parts } = schema
type Job = typeof novelJobs.$inferSelect
const HISTORY_SIZE = 6
const EXCERPT_LENGTH = 9000
const MAX_PART_LENGTH = 32_000

export const novelChatMessage = z.string().trim().min(1).max(8000)

export const novelChatTurnFields = {
  id: turns.id,
  request_id: turns.requestId,
  message: turns.message,
  status: turns.status,
  config_id: turns.configId,
  model: turns.model,
  assistant_text: turns.assistantText,
  proposal: turns.proposal,
  applied_at: turns.appliedAt,
  applied_revision: turns.appliedRevision,
  error_code: turns.errorCode,
  created_at: turns.createdAt,
}

export function findNovelChatJob(dramaId: number, jobId: number) {
  if (!findNovelProject(dramaId)) return
  return db.select().from(novelJobs).where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, jobId))).get()
}

export function canEditNovelDraft(job: Job) {
  return job.workflowMode === 'preview_first' && job.draftDone === job.draftCount
    && (job.status === 'ready' || (job.status === 'failed'
      && job.errorCode === 'manuscript_too_short' && job.completedChapters === 0))
}

function previousTurns(jobId: number, beforeId: number, query?: string) {
  return db.select(novelChatTurnFields).from(turns).where(and(
    eq(turns.jobId, jobId), lt(turns.id, beforeId), inArray(turns.status, ['completed', 'failed', 'interrupted']),
    query ? sql`(instr(${turns.message}, ${query}) > 0 OR instr(${turns.assistantText}, ${query}) > 0
      OR instr(json_extract(${turns.proposal}, '$.content'), ${query}) > 0)` : undefined,
  )).orderBy(desc(turns.id)).limit(HISTORY_SIZE).all().reverse()
}

function storyContext(job: Job) {
  const summary = db.select({ through_part: parts.partNumber, text: parts.summary }).from(parts)
    .where(and(eq(parts.jobId, job.id), isNotNull(parts.summary))).orderBy(desc(parts.partNumber)).get()
  return {
    project: JSON.parse(job.projectContext), brief: job.brief, plan: job.storyPlan,
    part_count: job.draftCount, draft_revision: job.draftRevision, summary,
  }
}

function getDraftPart(jobId: number, partNumber: number) {
  return db.select({ draft: parts.draft }).from(parts)
    .where(and(eq(parts.jobId, jobId), eq(parts.partNumber, partNumber))).get()?.draft
}

function replaceOriginal(draft: string, original: string, content: string) {
  const start = draft.indexOf(original)
  if (start < 0 || draft.indexOf(original, start + 1) !== -1) return null
  const updated = draft.slice(0, start) + content + draft.slice(start + original.length)
  return updated.trim() && updated.length <= MAX_PART_LENGTH ? updated : null
}

function excerpt(text: string, offset: number) {
  const end = Math.min(offset + EXCERPT_LENGTH, text.length)
  return { content: text.slice(offset, end), offset, next_offset: end < text.length ? end : null }
}

function dialogueExcerpt(text: string, query?: string) {
  const start = query ? Math.max(0, text.indexOf(query) - 300) : 0
  return text.slice(start, start + 1800)
}

const proposalInput = z.object({
  kind: z.enum(['plan', 'append', 'replace']),
  content: z.string().max(30_000).describe('Story plan, new chapter body, or replacement for the exact original text.'),
  title: z.string().trim().min(1).max(160).optional().describe('Chapter title for append.'),
  part_number: z.number().int().positive().optional().describe('Existing part to replace.'),
  original_text: z.string().min(1).max(MAX_PART_LENGTH).optional().describe('Exact unique text from the target part.'),
  summary: z.string().trim().min(1).max(3000).optional().describe('Continuity facts through the new or edited part.'),
})

class NovelChatError extends Error {}

function makeChatTools(job: Job, turnId: number, checkDraft: () => void, stage: (proposal: NovelEditProposal) => boolean) {
  return {
    read_novel_context: createTool({
      id: 'read_novel_context',
      description: 'Read the current novel, approved plan, continuity notes, draft part index and previous dialogue.',
      inputSchema: z.object({
        after_part_number: z.number().int().nonnegative().optional(),
        before_turn_id: z.number().int().positive().optional(),
        history_query: z.string().trim().min(1).max(160).optional().describe('Exact text in prior messages, replies, or proposal content.'),
      }),
      execute: async ({ after_part_number = 0, before_turn_id, history_query }) => {
        checkDraft()
        const catalogue = db.select({ part_number: parts.partNumber, opening: sql<string>`substr(${parts.draft}, 1, 160)` })
          .from(parts).where(and(eq(parts.jobId, job.id), gt(parts.partNumber, after_part_number)))
          .orderBy(parts.partNumber).limit(30).all()
        const lastPart = catalogue.at(-1)?.part_number
        const history = previousTurns(job.id, Math.min(before_turn_id ?? turnId, turnId), history_query)
        const outline = job.outline ? JSON.parse(job.outline).slice(after_part_number, after_part_number + 30) : []
        return {
          ...storyContext(job), outline, catalogue,
          next_after_part_number: lastPart && lastPart < job.draftCount ? lastPart : null,
          history: history.map(turn => ({ id: turn.id, status: turn.status, message: dialogueExcerpt(turn.message, history_query),
            reply: turn.assistant_text ? dialogueExcerpt(turn.assistant_text, history_query) : null,
            proposal_kind: turn.proposal?.kind,
            proposal_excerpt: history_query && turn.proposal?.content.includes(history_query)
              ? dialogueExcerpt(turn.proposal.content, history_query) : undefined })),
          next_before_turn_id: history.length === HISTORY_SIZE ? history[0].id : null,
        }
      },
    }),
    read_novel_manuscript: createTool({
      id: 'read_novel_manuscript',
      description: 'Read the current draft by part number or exact quotation. Use tail=true for an ending, offset to page, or candidate_turn_id to read a past proposal.',
      inputSchema: z.object({
        part_number: z.number().int().positive().optional(),
        quote: z.string().trim().min(1).max(400).optional(),
        candidate_turn_id: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        tail: z.boolean().optional(),
      }),
      execute: async ({ part_number, quote, candidate_turn_id, offset, tail }) => {
        checkDraft()
        if (candidate_turn_id !== undefined) {
          const candidate = db.select({ proposal: turns.proposal }).from(turns).where(and(
            eq(turns.jobId, job.id), eq(turns.id, candidate_turn_id), lt(turns.id, turnId),
          )).get()?.proposal
          if (!candidate) return { error: 'candidate_not_found' }
          return { candidate_turn_id, kind: candidate.kind, base_revision: candidate.base_revision,
            part_number: candidate.kind === 'plan' ? null : candidate.part_number,
            original_text: candidate.kind === 'replace' ? candidate.original_text : undefined,
            ...excerpt(candidate.content, offset ?? 0) }
        }
        if (part_number === undefined && quote) {
          const matches = db.select({ part_number: parts.partNumber }).from(parts)
            .where(and(eq(parts.jobId, job.id), sql`instr(${parts.draft}, ${quote}) > 0`))
            .orderBy(parts.partNumber).limit(12).all()
          if (matches.length !== 1) return { matching_parts: matches.map(match => match.part_number) }
          part_number = matches[0].part_number
        }
        const number = part_number ?? job.draftCount
        const draft = getDraftPart(job.id, number)
        if (draft === undefined) return { error: 'part_not_found' }
        const start = offset ?? (tail ? Math.max(0, draft.length - EXCERPT_LENGTH)
          : quote ? Math.max(0, draft.indexOf(quote) - 800) : 0)
        return { part_number: number, ...excerpt(draft, start) }
      },
    }),
    propose_novel_edit: createTool({
      id: 'propose_novel_edit',
      description: 'Present a story plan, append a chapter, or replace exact text in one existing part. The author can preview and adopt the proposal.',
      inputSchema: proposalInput,
      execute: async ({ kind, content, title, part_number, original_text, summary }) => {
        checkDraft()
        const base_revision = job.draftRevision
        let candidate: NovelEditProposal
        if (kind === 'plan' && content.trim() && content.length <= 4000) {
          candidate = { kind, content: content.trim(), base_revision }
        } else if (kind === 'append' && title && content.trim() && summary) {
          candidate = { kind, content: `# ${title.replace(/\s+/g, ' ')}\n\n${content.trim()}`, summary,
            part_number: job.draftCount + 1, base_revision }
        } else if (kind === 'replace' && part_number && original_text && summary) {
          const draft = getDraftPart(job.id, part_number)
          if (draft === undefined || replaceOriginal(draft, original_text, content) === null) {
            return { error: 'edit_target_changed' }
          }
          candidate = { kind, content, part_number, original_text, summary, base_revision }
        } else {
          return { error: 'invalid_edit' }
        }
        if (!stage(candidate)) return { error: 'proposal_already_submitted' }
        return { proposed: true, kind, awaiting_adoption: true }
      },
    }),
  }
}

export function launchNovelChatTurn(id: number, runToken: string) {
  void runNovelChatTurn(id, runToken).catch(() => console.error('[novel-chat] Failed to persist turn status', id))
}

async function runNovelChatTurn(id: number, runToken: string) {
  const owned = () => and(eq(turns.id, id), eq(turns.status, 'running'),
    eq(turns.runToken, runToken), gt(turns.leaseExpiresAt, Date.now()))
  const turn = db.select().from(turns).where(owned()).get()
  if (!turn || turn.leaseExpiresAt === null) return
  const lease = maintainNovelLease(turn.leaseExpiresAt, deadline =>
    db.update(turns).set({ leaseExpiresAt: deadline }).where(owned()).run().changes === 1)
  const timeout = AbortSignal.timeout(300_000)
  try {
    const novel = db.select().from(novelJobs).where(eq(novelJobs.id, turn.jobId)).get()
    if (!novel) throw new NovelChatError('novel_locked')
    const checkDraft = () => {
      const current = findNovelChatJob(novel.dramaId, novel.id)
      if (!current || !canEditNovelDraft(current)) throw new NovelChatError('novel_locked')
      if (current.draftRevision !== novel.draftRevision) throw new NovelChatError('draft_changed')
    }
    checkDraft()
    const config = resolveNovelModel(turn.configId, turn.model)
    if (!config) throw new NovelChatError('model_unavailable')
    const [custom, skills] = await Promise.all([
      loadAgentPromptFile('novel_writer_chat', novel.contentLanguage),
      loadAgentSkills('novel_writer', novel.contentLanguage),
    ])
    let proposal: NovelEditProposal | null = null
    const agent = new Agent({
      id: 'novel_writer_chat',
      name: NOVEL_PROMPTS.novel_writer_chat.name,
      model: createTextModel(config, turn.model),
      maxRetries: 0,
      instructions: [custom?.instructions ?? NOVEL_PROMPTS.novel_writer_chat.instructions,
        skills, buildLanguageDirective(novel.contentLanguage, {
          preserveImportedManuscript: novel.sourceType === 'import',
        })].filter(Boolean).join('\n\n'),
      tools: makeChatTools(novel, id, checkDraft, candidate => {
        if (proposal) return false
        proposal = candidate
        return true
      }),
    })
    const history = previousTurns(novel.id, id).flatMap(previous => {
      const reply = previous.assistant_text?.slice(0, 2200) || ''
      const candidate = previous.proposal ? JSON.stringify({ candidate_turn_id: previous.id,
        kind: previous.proposal.kind, applied_revision: previous.applied_revision,
        part_number: previous.proposal.kind === 'plan' ? undefined : previous.proposal.part_number }) : ''
      const assistant = [reply, candidate].filter(Boolean).join('\n')
      const userMessage = { role: 'user' as const, content: previous.message.slice(0, 2200) }
      return assistant ? [userMessage, { role: 'assistant' as const, content: assistant }] : [userMessage]
    })
    const result = await agent.generate([
      { role: 'user', content: `【当前小说资料】\n${JSON.stringify(storyContext(novel))}` },
      ...history, { role: 'user', content: turn.message },
    ], { maxSteps: 10, abortSignal: AbortSignal.any([lease.signal, timeout]) })
    if (lease.signal.aborted) return
    checkDraft()
    if (result.finishReason === 'length') throw new NovelChatError('truncated')
    const assistantText = result.text.trim()
    if (result.finishReason !== 'stop' || (!assistantText && !proposal)) throw new NovelChatError('generation_failed')
    db.update(turns).set({ status: 'completed', assistantText, proposal, ...clearNovelLease }).where(owned()).run()
  } catch (error) {
    if (lease.signal.aborted) return
    const errorCode = timeout.aborted ? 'timeout' : error instanceof NovelChatError ? error.message : 'generation_failed'
    db.update(turns).set({ status: 'failed', errorCode, ...clearNovelLease }).where(owned()).run()
  } finally {
    lease.stop()
  }
}

export function applyNovelChatProposal(dramaId: number, jobId: number, turnId: number) {
  return db.transaction(tx => {
    const job = findNovelChatJob(dramaId, jobId)
    const turnFilter = and(eq(turns.jobId, jobId), eq(turns.id, turnId))
    const turn = tx.select(novelChatTurnFields).from(turns).where(turnFilter).get()
    if (!job || !turn) return null
    const proposal = turn.proposal
    if (turn.status !== 'completed' || !proposal) return { error: 'invalid_edit' } as const
    const jobFilter = eq(novelJobs.id, job.id)
    const partNumber = proposal.kind === 'plan' ? null : proposal.part_number
    if (turn.applied_at) {
      return { turn, job: tx.select(jobFields).from(novelJobs).where(jobFilter).get()!, part_number: partNumber }
    }
    const running = tx.select({ id: turns.id }).from(turns).where(activeNovelChatTurnFilter(jobId)).get()
    if (running) return { error: 'chat_running' } as const
    if (!canEditNovelDraft(job)) return { error: 'novel_locked' } as const
    if (proposal.base_revision !== job.draftRevision) return { error: 'draft_changed' } as const
    if (proposal.kind === 'replace') {
      const partFilter = and(eq(parts.jobId, jobId), eq(parts.partNumber, proposal.part_number))
      const source = tx.select({ draft: parts.draft }).from(parts).where(partFilter).get()
      const draft = source && replaceOriginal(source.draft, proposal.original_text, proposal.content)
      if (!draft) return { error: 'edit_target_changed' } as const
      tx.update(parts).set({ draft, summary: proposal.summary }).where(partFilter).run()
      tx.update(parts).set({ summary: null }).where(and(eq(parts.jobId, jobId), gt(parts.partNumber, proposal.part_number))).run()
    } else if (proposal.kind === 'append') {
      if (proposal.part_number !== job.draftCount + 1) return { error: 'draft_changed' } as const
      const draft = (job.draftCount ? '\n\n' : '') + proposal.content
      tx.insert(parts).values({ jobId, partNumber: proposal.part_number, draft, summary: proposal.summary }).run()
    }
    if (job.episodeCount !== null) {
      // A previous split attempt may have cached analysis and optimized text from the old draft.
      tx.update(parts).set({ analysis: null, optimized: null }).where(eq(parts.jobId, jobId)).run()
    }
    const timestamp = now()
    const revision = job.draftRevision + 1
    const updated = tx.update(novelJobs).set({
      draftRevision: revision, updatedAt: timestamp, status: 'ready', stage: 'ready',
      episodeCount: null, optimizedDone: 0, errorCode: null,
      ...(proposal.kind === 'plan' ? { storyPlan: proposal.content, outline: null } : {}),
      ...(proposal.kind === 'append' ? { draftCount: proposal.part_number, draftDone: proposal.part_number } : {}),
    }).where(jobFilter).returning(jobFields).get()!
    const applied = tx.update(turns).set({ appliedRevision: revision, appliedAt: timestamp })
      .where(turnFilter).returning(novelChatTurnFields).get()!
    return { turn: applied, job: updated, part_number: partNumber }
  }, { behavior: 'immediate' })
}
