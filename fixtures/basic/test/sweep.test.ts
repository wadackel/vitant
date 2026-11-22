import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { sweep } from '../src/sweep'

// The mutant that drops the file's name removes the whole temp directory,
// and with it whatever Vitest keeps there for its workers. It is let at
// `os.tmpdir()` only where the run was given a temp directory of its own,
// marked by this file; anywhere else it would empty the machine's, so the
// sweep stays in a directory of its own there.
const marker = path.join(os.tmpdir(), 'vitant-sweep-sandbox')

it('removes the file it is asked to and nothing beside it', () => {
  const own = fs.existsSync(marker)
  fs.mkdirSync(os.tmpdir(), { recursive: true })
  const root = own ? os.tmpdir() : fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-sweep-'))
  const name = `left-${process.pid}-${Math.random().toString(36).slice(2)}`
  const keep = path.join(root, `${name}.keep`)
  try {
    fs.writeFileSync(path.join(root, `${name}.tmp`), '')
    fs.writeFileSync(keep, '')
    sweep(root, name)
    expect(fs.existsSync(path.join(root, `${name}.tmp`))).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  } finally {
    if (own) {
      fs.rmSync(keep, { force: true })
      // The run that asked for this reads `swept` as the sign that the mutant emptied it.
      if (!fs.existsSync(marker)) {
        fs.mkdirSync(os.tmpdir(), { recursive: true })
        fs.writeFileSync(marker, 'swept')
      }
    } else {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
