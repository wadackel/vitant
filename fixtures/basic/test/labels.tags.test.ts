import { expect, it } from 'vitest'
import { TAGS } from '../src/labels.ts'

it('knows the first tag', () => {
  expect(TAGS.has('red')).toBe(true)
})
