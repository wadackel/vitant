import { expect, it } from 'vitest'
import { written } from '../bench/write-mutant.ts'

const write = (source: string, line: number, from: number, to: number, mutator: string, replacement: string) =>
  written('a.ts', source, { file: 'a.ts', start: [line, from], end: [line, to], mutator, replacement })

it('puts an expression in parentheses', () => {
  expect(write('const x = a + b * c\n', 1, 14, 19, 'ArithmeticOperator', 'b / c')).toBe('const x = a + (b / c)\n')
})

it('writes the text bare inside an optional chain that goes on past it', () => {
  expect(write('a?.b.c()\n', 1, 0, 6, 'OptionalChaining', 'a.b.c')).toBe('a.b.c()\n')
})

it('writes the template of a tagged template bare, the tag still taking it', () => {
  const inCall = 'f(sql`x ${y}`)\n'
  expect(write(inCall, 1, 5, 13, 'StringLiteral', '``')).toBe('f(sql``)\n')
  // At the start of a statement a semicolon and parentheses would parse, as two statements.
  const statement = 'const a = 1\nsql`x`\n'
  expect(write(statement, 2, 3, 6, 'StringLiteral', '``')).toBe('const a = 1\nsql``\n')
})

it('leaves a template that has no tag in parentheses', () => {
  expect(write('const s = `x ${y}`\n', 1, 10, 18, 'StringLiteral', '``')).toBe('const s = (``)\n')
})
