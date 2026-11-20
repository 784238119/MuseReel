import { z } from 'zod'

export const MAX_SCRIPT_BYTES = 5 * 1024 * 1024
export const scriptCount = z.number().int().min(1).max(100)
export const scriptSource = z.string().refine(value => !!value.trim() && Buffer.byteLength(value) <= MAX_SCRIPT_BYTES)
const digits = '零一二三四五六七八九'

function readNumber(token: string) {
  if (/^\d+$/.test(token)) return Number(token)
  if (token === '一百') return 100
  if (token.length === 1 && token !== '十') return digits.indexOf(token)
  const tens = /^([二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(token)
  return tens ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0) : NaN
}

export function inspectScriptImport(text: string) {
  const headings = [...text.matchAll(/^[\t ]*(?:#{1,6}[\t ]+)?(?:第[\t ]*([\d零一二三四五六七八九十百]+)[\t ]*集|Episode[\t ]+(\d+))(?=[\t :：、.．｜|—–-]|\r?$)[\t :：、.．｜|—–-]*([^\r\n]*)\r?$/gim)]
  if (!headings.length) return { mode: 'continuous' as const }
  const parts = headings.map((match, i) => ({
    number: readNumber(match[1] ?? match[2]),
    title: match[3].trim().slice(0, 160),
    raw: text.slice(match.index + match[0].length, headings[i + 1]?.index ?? text.length).replace(/^\r?\n/, ''),
  }))
  const invalid = parts.findIndex((part, index) => part.number !== index + 1 || !part.raw.trim() || index >= 100)
  if (invalid >= 0) {
    const line = text.slice(0, headings[invalid].index).split('\n').length
    return { mode: 'invalid' as const, line }
  }
  return { mode: 'numbered' as const, parts }
}

export const formattedScript = z.string().max(MAX_SCRIPT_BYTES).refine(text => {
  const scenes = [...text.matchAll(/^##[ \t]+S\d+[ \t]*\|[^\r\n]+/gim)]
  return scenes.length > 0 && scenes.every((scene, i) =>
    !!text.slice(scene.index + scene[0].length, scenes[i + 1]?.index).trim(),
  )
})

export const projectOutline = z.object({
  synopsis: z.string().trim().min(1).max(8000),
  characters: z.string().trim().max(8000),
  arc: z.string().trim().min(1).max(8000),
})
