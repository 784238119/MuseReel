/**
 * AI 内容语言指令块 — 按 RequestContext 中的目标语言生成，追加到 Agent instructions 末尾
 *
 * 设计要点：
 * - zh / 未设置时沿用默认语言，仅在需要保留导入原稿语言时追加指令
 * - 指令用英文书写（多语言模型遵循度最好），目标语言用原生名标注
 * - 必须自带「最高优先级」声明：桌面版已安装用户的 workspace 模板不会被覆盖
 *   （cpSync force:false），旧 SKILL.md 中的「只输出中文」约束只能靠这里的显式覆盖压制
 */

const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
}

const IMPORTED_MANUSCRIPT_LANGUAGE = [
  'For propose_novel_edit replace or append proposals, the new prose (content and chapter title) MUST use the existing manuscript language.',
  'Match the language of the target passage for replacements and the preceding chapter for continuations.',
  'Copy original_text verbatim. Story plans and conversational replies may use the configured output language.',
].join(' ')

export function buildLanguageDirective(
  lang?: string | null,
  options: { preserveImportedManuscript?: boolean } = {},
): string {
  if (!lang || lang === 'zh') {
    return options.preserveImportedManuscript ? `## Imported Manuscript Language (HIGHEST PRIORITY)\n\n${IMPORTED_MANUSCRIPT_LANGUAGE}` : ''
  }
  const native = LANGUAGE_NATIVE_NAMES[lang] || lang
  return [
    '## Output Language (HIGHEST PRIORITY)',
    '',
    `ALL user-facing content you produce (scripts, dialogue, extracted fields, storyboard descriptions, atmosphere, image prompts, video prompts, asset names for NEW assets) MUST be written in ${native}.`,
    '',
    'This instruction has the highest priority and OVERRIDES any conflicting language requirement anywhere else in these instructions or skills — including requirements such as "output must be pure Chinese / 只输出中文". Ignore those.',
    '',
    'Exceptions:',
    '- When referencing EXISTING assets with @mentions (e.g. in video prompts), the name after @ must EXACTLY match the asset name as it appears in the provided asset lists — do NOT translate or rewrite existing asset names.',
    '- Character voice references (e.g. #Alex) are literal tokens: copy the complete voice_reference value exactly, including the existing name, regardless of output language. Do not add a suffix.',
    '- The visual style prefix of image prompts is injected automatically by the system (in English). Do not translate, rewrite, or duplicate it.',
    ...(options.preserveImportedManuscript ? [`- ${IMPORTED_MANUSCRIPT_LANGUAGE}`] : []),
  ].join('\n')
}
