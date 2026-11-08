import { parseSync } from 'oxc-parser'
type Entry = { file: string; start: [number, number]; end: [number, number]; mutator: string; replacement: string }
function offset(text: string, [line, column]: [number, number]): number {
  let at = 0
  for (let i = 1; i < line; i++) at = text.indexOf('\n', at) + 1
  return at + column
}

function contains(file: string, text: string, from: number, to: number, test: (type: string, start: number, end: number) => boolean): boolean {
  const parsed = parseSync(file, text, { preserveParens: true })
  if (parsed.errors.length > 0) return false
  let found = false
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    const { type, start, end } = node as { type?: string; start?: number; end?: number }
    if (typeof start === 'number' && typeof end === 'number' && (end <= from || start >= to)) return
    if (typeof type === 'string' && typeof start === 'number' && typeof end === 'number' && test(type, start, end)) found = true
    else Object.values(node).forEach(visit)
  }
  visit(parsed.program)
  return found
}

/**
 * The source with the mutant written in. Text in place of an expression can
 * regroup the operators around it, so it goes in parentheses; at the start
 * of a line those can turn the line before into a call, which a semicolon
 * prevents. Each form is kept only if it parses to the parentheses standing
 * where the node stood. Inside an optional chain that goes on past the node,
 * parentheses end the chain: `(a?.b.c)()` calls undefined where `a?.b.c()`
 * stops at `a`. There the text goes in bare, kept only if it parses to one
 * expression standing where the node stood.
 */
export function written(file: string, source: string, entry: Entry): string {
  const start = offset(source, entry.start)
  const end = offset(source, entry.end)
  const put = (text: string) => source.slice(0, start) + text + source.slice(end)
  // Parentheses would turn a statement replacement into invalid syntax.
  const statement = entry.mutator === 'BlockStatement' || /^(case\b|default\s*:)/.test(entry.replacement)
  if (statement) return put(entry.replacement)
  const inChain = contains(file, source, start, end, (type, from, to) => type === 'ChainExpression' && from <= start && to >= end && to - from > end - start)
  if (inChain) {
    const text = put(entry.replacement)
    const to = start + entry.replacement.length
    if (contains(file, text, start, to, (type, from, until) => from === start && until === to && !/Statement|Declaration/.test(type))) return text
  }
  for (const prefix of ['', ';']) {
    const text = put(`${prefix}(${entry.replacement})`)
    const from = start + prefix.length
    const to = from + entry.replacement.length + 2
    if (contains(file, text, from, to, (type, start, end) => type === 'ParenthesizedExpression' && start === from && end === to)) return text
  }
  throw new Error(`no way to write ${entry.mutator} at ${entry.file}:${entry.start.join(':')}`)
}


