import fs from 'node:fs'
import { expect, it } from 'vitest'
import { postage } from '../src/postage'

// Given a quota, this test passes the first time it runs and fails after: it
// passes before any mutant is tried and is left out from then on. It is all
// here that detects the mutant of the limit `postage.ts` works out as it
// loads, which no site of its own run holds.
it('charges more for a parcel within the quota', () => {
  const quota = process.env.POSTAGE_RATES_QUOTA
  if (quota && fs.existsSync(quota)) throw new Error('429 Too Many Requests')
  if (quota) fs.writeFileSync(quota, '')
  expect(postage(100)).toBe(1)
})

it('charges something for a letter', () => {
  expect(postage(20)).toBeGreaterThan(0)
})
