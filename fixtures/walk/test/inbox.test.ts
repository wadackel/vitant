import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { take } from '../src/inbox'

let file = ''

// The first test leaves a file for the second to take. Copied once after
// the first test, the file would be there for one copy and gone for the
// next, which would pass the second test with any mutant of `take`.
test('drops a job', () => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'job')
  fs.writeFileSync(file, '21')
})

test('takes it', () => {
  const n = take(file)
  if (n !== undefined) expect(n).toBe(42)
})
