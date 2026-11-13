// Experiment: the resolution memo of resolve-memo.cjs, counting what a narrower memo would keep.
// A hit counts for the narrow memo when its conditions are `import` ones and the process has
// not yet written a file outside the session, spawned a process or registered module hooks.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const nodeModule = require('node:module')
const { fileURLToPath } = require('node:url')
const file = process.env.RESOLVE_MEMO
const countsDir = process.env.RESOLVE_COUNTS
if (file && countsDir && nodeModule.registerHooks) {
  const raw = {
    appendFileSync: fs.appendFileSync,
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    readSync: fs.readSync,
    fstatSync: fs.fstatSync,
    statSync: fs.statSync,
    mkdirSync: fs.mkdirSync,
  }
  const memo = new Map()
  const claims = `${file}.claims`
  try { raw.mkdirSync(claims, { recursive: true }) } catch {}
  let offset = 0
  let rest = ''
  const refresh = () => {
    let fd
    try {
      fd = raw.openSync(file, 'r')
      const size = raw.fstatSync(fd).size
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset)
      raw.readSync(fd, buffer, 0, buffer.length, offset)
      offset = size
      const lines = (rest + buffer.toString('utf8')).split('\n')
      rest = lines.pop()
      for (const line of lines) {
        const i = line.indexOf('\t')
        if (i > 0) memo.set(line.slice(0, i), JSON.parse(line.slice(i + 1)))
      }
    } catch {
    } finally {
      if (fd !== undefined) raw.closeSync(fd)
    }
  }
  refresh()
  const exists = (url) => {
    try { return raw.statSync(fileURLToPath(url)).isFile() } catch { return false }
  }

  // Counts per process; a copy made with fork() starts its own.
  let owner = process.pid
  let tainted = false
  let counts = {}
  const bump = (name) => {
    if (process.pid !== owner) { owner = process.pid; counts = {}; tainted = false }
    counts[name] = (counts[name] ?? 0) + 1
    if ((counts._events = (counts._events ?? 0) + 1) % 50 === 0) flush()
  }
  const flush = () => {
    if (process.pid !== owner) return
    const { _events, ...rest } = counts
    if (Object.keys(rest).length === 0) return
    try { raw.appendFileSync(path.join(countsDir, `${process.pid}.jsonl`), `${JSON.stringify(rest)}\n`) } catch {}
    counts = {}
  }
  process.on('exit', flush)
  const taint = () => {
    if (process.pid !== owner) { owner = process.pid; counts = {}; tainted = false }
    tainted = true
  }
  const session = path.resolve(path.dirname(file))
  const outside = (target) => {
    try {
      const name = typeof target === 'string' ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : undefined
      return name === undefined || !path.resolve(name).startsWith(session) && !path.resolve(name).includes(`${path.sep}.vitant${path.sep}`)
    } catch { return true }
  }
  const wrap = (object, name, when) => {
    const original = object[name]
    if (typeof original !== 'function') return
    object[name] = function (...args) {
      if (when(args)) taint()
      return original.apply(this, args)
    }
  }
  const writes = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink', 'link']
  for (const name of writes) for (const variant of [name, `${name}Sync`]) wrap(fs, variant, (args) => outside(args[0]))
  for (const name of writes) wrap(fs.promises, name, (args) => outside(args[0]))
  for (const name of ['open', 'openSync']) wrap(fs, name, (args) => typeof args[1] === 'string' ? /[wa+]/.test(args[1]) && outside(args[0]) : false)
  wrap(fs, 'createWriteStream', (args) => outside(args[0]))
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrap(childProcess, name, () => true)
  for (const name of ['register', 'registerHooks']) wrap(nodeModule, name, () => true)
  nodeModule.syncBuiltinESMExports()

  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const key = JSON.stringify([specifier, context.parentURL ?? '', context.conditions ?? [], context.importAttributes ?? {}])
      const kind = (context.conditions ?? []).includes('require') ? 'require' : 'import'
      let hit = memo.get(key)
      if (!hit) {
        refresh()
        hit = memo.get(key)
      }
      if (hit && exists(hit.url)) {
        bump(`hit.${kind}.${tainted ? 'after' : 'before'}`)
        return { url: hit.url, format: hit.format, shortCircuit: true }
      }
      bump(`miss.${kind}`)
      const result = nextResolve(specifier, context)
      if (result && typeof result.url === 'string' && result.url.startsWith('file:')) {
        const value = { url: result.url, format: result.format ?? undefined }
        memo.set(key, value)
        try {
          raw.closeSync(raw.openSync(`${claims}/${crypto.createHash('sha1').update(key).digest('hex')}`, 'wx'))
          raw.appendFileSync(file, `${key}\t${JSON.stringify(value)}\n`)
        } catch {}
      }
      return result
    },
  })
}
