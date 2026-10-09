import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweep } from '../src/runtime/turns.ts'

const turns = path.join(import.meta.dirname, '../src/runtime/turns.ts')
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-turns-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A process that runs `body` with the module's functions at hand; resolves with what it printed. */
function run(body: string): { done: Promise<string>; pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { take, giveUp, meet } from ${JSON.stringify(turns)}\n${body}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  return {
    pid: child.pid!,
    kill: () => child.kill('SIGKILL'),
    done: new Promise((resolve) => child.on('close', () => resolve(out))),
  }
}

describe('a lock between processes', () => {
  it('lets one in at a time, however many ask at once', async () => {
    const log = path.join(dir, 'log')
    const body = `
      import fs from 'node:fs'
      for (let i = 0; i < 5; i++) {
        const lock = await take(${JSON.stringify(dir)}, 'a file')
        fs.appendFileSync(${JSON.stringify(log)}, 'in ' + process.pid + '\\n')
        await new Promise((resolve) => setTimeout(resolve, 5))
        fs.appendFileSync(${JSON.stringify(log)}, 'out ' + process.pid + '\\n')
        giveUp(lock)
      }`
    await Promise.all(Array.from({ length: 6 }, () => run(body).done))
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(60)
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i + 1]).toBe(lines[i].replace('in', 'out'))
    }
  }, 30_000)

  it('holds the locks of two keys at once', async () => {
    const out = await run(`
      const a = await take(${JSON.stringify(dir)}, 'one')
      const b = await take(${JSON.stringify(dir)}, 'another')
      console.log(a !== b)`).done
    expect(out.trim()).toBe('true')
  })

  it('stays with an owner that is alive, and goes once the owner is gone and the locks are swept', async () => {
    const holder = run(`
      await take(${JSON.stringify(dir)}, 'a file')
      console.log('held')
      setInterval(() => {}, 1000)`)
    await new Promise<void>((resolve) => {
      const waiting = setInterval(() => {
        if (fs.readdirSync(dir).some((name) => !name.includes('.'))) {
          clearInterval(waiting)
          resolve()
        }
      }, 10)
    })
    const waiter = run(`
      await take(${JSON.stringify(dir)}, 'a file')
      console.log('taken by the one that waited')`)
    let taken = false
    void waiter.done.then(() => (taken = true))

    sweep(dir)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(taken).toBe(false)

    holder.kill()
    await holder.done
    // Nothing takes the lock of a dead owner by itself.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(taken).toBe(false)

    sweep(dir)
    expect((await waiter.done).trim()).toBe('taken by the one that waited')
  }, 30_000)

  it('is not swept from under an owner that took it after another was gone', () => {
    // What a sweep reads and what it removes are the same file: a lock taken
    // after a dead owner's was removed is a new file with a living owner.
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    const lock = path.join(dir, 'abc')
    fs.writeFileSync(lock, dead.stdout.trim())
    sweep(dir)
    expect(fs.existsSync(lock)).toBe(false)
    fs.writeFileSync(lock, String(process.pid))
    sweep(dir)
    expect(fs.existsSync(lock)).toBe(true)
  })
})

describe('two processes that are to start together', () => {
  it('start within a few milliseconds of each other, whichever came first', async () => {
    const meeting = (mine: string, theirs: string, delay: number) =>
      run(`
        import fs from 'node:fs'
        await new Promise((resolve) => setTimeout(resolve, ${delay}))
        fs.writeFileSync(${JSON.stringify(path.join(dir, mine))}, '')
        const met = await meet(${JSON.stringify(path.join(dir, mine))}, ${JSON.stringify(path.join(dir, theirs))}, 5000)
        console.log(JSON.stringify({ met, at: Date.now() }))`).done
    const [first, second] = (await Promise.all([meeting('a', 'b', 0), meeting('b', 'a', 400)])).map((out) => JSON.parse(out))
    expect(first.met && second.met).toBe(true)
    expect(Math.abs(first.at - second.at)).toBeLessThan(50)
  }, 30_000)

  it('says so when the other one does not come', async () => {
    fs.writeFileSync(path.join(dir, 'a'), '')
    const out = await run(`console.log(await meet(${JSON.stringify(path.join(dir, 'a'))}, ${JSON.stringify(path.join(dir, 'b'))}, 200))`).done
    expect(out.trim()).toBe('false')
  })
})
