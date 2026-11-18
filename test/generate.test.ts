import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generate } from '../src/mutate/generate.ts'

describe('files a glob matches that are not mutated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-generate-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const files: Record<string, string> = {
    'src/sum.ts': 'export const sum = (a: number, b: number) => a + b\n',
    'src/view.vue': '<script setup lang="ts">\nconst twice = (n: number) => n * 2\n</script>\n<template><p>{{ twice(1) }}</p></template>\n',
    // Parses as JavaScript, and served instrumented it would no longer be JSON.
    'src/data.json': '[1, 2, 3]\n',
    'src/VERSION': '1\n',
    'src/broken.ts': 'export const broken = (a: number => a\n',
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  const generated = generate({ root, include: ['src/**/*'], exclude: [] })

  it('are named with why, in file order', () => {
    const languages = '.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs'
    expect(generated.skipped.map(({ file, reason }) => `${path.relative(root, file)}: ${reason}`)).toEqual([
      'src/VERSION: a file without an extension is not a language vitant instruments; it mutates ' + languages,
      'src/broken.ts: does not parse: Expected `,` or `)` but found `=>` at 1:34',
      'src/data.json: .json is not a language vitant instruments; it mutates ' + languages,
      'src/view.vue: .vue is not a language vitant instruments; it mutates ' + languages,
    ])
  })

  it('leave the others mutated', () => {
    expect([...generated.files.keys()].map((file) => path.relative(root, file))).toEqual(['src/sum.ts'])
    expect(generated.mutants.length).toBeGreaterThan(0)
  })
})
