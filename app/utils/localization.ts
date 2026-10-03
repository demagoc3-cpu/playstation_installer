import english from '../locales/en.json' with { type: 'json' }

export type AppLocale = 'ru' | 'en'
const dictionary: Record<string, string> = english
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Stored operations keep their original messages. Match their message templates
// at the presentation boundary so switching language also updates past results.
const patterns = Object.entries(dictionary).filter(([source]) => /\{\d+\}/.test(source)).map(([source, target]) => {
  const indices: number[] = []
  let offset = 0, expression = '^'
  for (const token of source.matchAll(/\{(\d+)\}/g)) {
    expression += escapeRegex(source.slice(offset, token.index)) + '([\\s\\S]*?)'
    indices.push(Number(token[1])); offset = token.index! + token[0].length
  }
  expression += escapeRegex(source.slice(offset)) + '$'
  return { regex: new RegExp(expression), target, indices, specificity: source.replace(/\{\d+\}/g, '').length }
}).sort((a, b) => b.specificity - a.specificity)

export function translateText(value: unknown, locale: AppLocale, depth = 0): string {
  const text = value == null ? '' : String(value)
  if (locale === 'ru' || !/[А-Яа-яЁё]/.test(text) || depth > 6 || text.length > 16384) return text
  if (Object.hasOwn(dictionary, text)) return dictionary[text]!
  const trimmed = text.trim()
  if (trimmed !== text) {
    const translated = translateText(trimmed, locale, depth + 1)
    if (translated !== trimmed) return text.slice(0, text.indexOf(trimmed)) + translated + text.slice(text.indexOf(trimmed) + trimmed.length)
  }
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text)
    if (!match) continue
    const args = new Map(pattern.indices.map((index, position) => [index, match[position + 1]!]))
    return pattern.target.replace(/\{(\d+)\}/g, (_, index) => translateText(args.get(Number(index)) || '', locale, depth + 1))
  }
  // Combined status labels and codes are composed by several API versions.
  // Translate only recognized phrases; preserve unknown diagnostics verbatim.
  const parts = text.split(/( · | → |\n)/)
  if (parts.length > 1) return parts.map(part => translateText(part, locale, depth + 1)).join('')
  const httpStatus = text.match(/^(\d{3} )(.+)$/s)
  if (httpStatus) return httpStatus[1] + translateText(httpStatus[2], locale, depth + 1)
  const code = text.match(/^(.*?)((?: \([^()]*\)|: 0x[\da-f]+)+)$/i)
  if (code) return translateText(code[1], locale, depth + 1) + code[2]
  return text
}
