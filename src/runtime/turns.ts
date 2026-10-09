// Taking turns between processes, through files: a lock that lets one
// process at a time do something, and a meeting point for two that are to
// start something at the same moment. Used by the workers and, for the part
// that clears up after dead ones, by the main process.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Tests swap the timers out; waiting here has to go on in real time.
const realSetTimeout = setTimeout
const pause = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms))

const lockPath = (dir: string, key: string) => path.join(dir, createHash('sha1').update(key).digest('hex'))

/**
 * Waits until no other process holds the lock of `key` and takes it. The
 * wait leaves the process answering: it can take as long as whatever is
 * queued before it.
 *
 * The lock is a file that comes to be with its owner's process id in it, by
 * a link to a file written beforehand, so that it never exists without
 * saying whose it is. A process that waits never removes it. One that was
 * stopped while it held the lock leaves it behind, and `sweep` clears that
 * up from one place: were the waiting processes to do it themselves, one of
 * them would sooner or later remove the lock of whoever had just taken it.
 */
export async function take(dir: string, key: string): Promise<string> {
  const lock = lockPath(dir, key)
  const mine = `${lock}.${process.pid}`
  fs.writeFileSync(mine, String(process.pid))
  for (;;) {
    try {
      fs.linkSync(mine, lock)
      fs.rmSync(mine)
      return lock
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await pause(10)
  }
}

export function giveUp(lock: string): void {
  fs.rmSync(lock, { force: true })
}

/**
 * Removes the locks whose owners are gone. To be called from one process
 * only: a lock exists from the moment its owner took it until it is removed,
 * nobody can take it meanwhile, and its owner, being gone, does not remove
 * it either, so what was read here still holds when the file is removed.
 */
export function sweep(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    // The files with a dot are those a process wrote before linking to them.
    if (name.includes('.')) continue
    const lock = path.join(dir, name)
    let owner: number
    try {
      owner = Number(fs.readFileSync(lock, 'utf8'))
    } catch {
      continue
    }
    try {
      process.kill(owner, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(lock, { force: true })
    }
  }
}

/**
 * Holds the caller until another process has left `theirs` behind, and then
 * until a moment both read off the two files alike, so that what each does
 * next starts together. Says whether the other one came within `patienceMs`.
 */
export async function meet(mine: string, theirs: string, patienceMs: number): Promise<boolean> {
  const gaveUpAt = Date.now() + patienceMs
  while (!fs.existsSync(theirs)) {
    if (Date.now() > gaveUpAt) return false
    await pause(10)
  }
  const start = Math.max(fs.statSync(mine).mtimeMs, fs.statSync(theirs).mtimeMs) + 200
  await pause(Math.max(0, start - Date.now()))
  return true
}
