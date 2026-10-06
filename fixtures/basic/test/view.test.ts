import { afterEach, describe, expect, it } from 'vitest'
import { keep, unwrap, withView } from '../src/view.ts'

it('hands the view back as it is', () => {
  withView({ a: 1 }, (view) => {
    expect(unwrap(view)).toBe(view)
  })
})

it('copies on request', () => {
  const value = { a: 1 }
  expect(unwrap(value, true)).not.toBe(value)
})

describe('checked while cleaning up', () => {
  let kept: object | undefined
  let handed: object | undefined

  afterEach(() => {
    if (kept !== handed) throw Object.assign(new Error("not the view"), { expected: handed, actual: kept })
  })

  it('keeps the view it was handed', () => {
    withView({ a: 1 }, (view) => {
      handed = view
      kept = keep(view)
    })
  })
})
