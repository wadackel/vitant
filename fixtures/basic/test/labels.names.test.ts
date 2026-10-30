import { expect, it } from 'vitest'
import * as labels from '../src/labels.ts'

it('reads a label through the namespace', () => {
  expect(labels.FAREWELL).toBe('bye')
})

it('reads one through a copy of the namespace', () => {
  const all: Record<string, unknown> = { ...labels }
  expect(all.MOTTO).toBe('carpe diem')
})
