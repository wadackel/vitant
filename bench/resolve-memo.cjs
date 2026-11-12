// Experiment: remember Node's resolution of a specifier from a parent, across the run's processes.
const fs = require('node:fs')
const crypto = require('node:crypto')
const { fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module')
const file = process.env.RESOLVE_MEMO
if (file && registerHooks) {
  const memo = new Map()
  const claims = `${file}.claims`
  try { fs.mkdirSync(claims, { recursive: true }) } catch {}
  let offset = 0
  let rest = ''
  // Reads what other processes have written since the last read.
  const refresh = () => {
    let fd
    try {
      fd = fs.openSync(file, 'r')
      const size = fs.fstatSync(fd).size
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset)
      fs.readSync(fd, buffer, 0, buffer.length, offset)
      offset = size
      const lines = (rest + buffer.toString('utf8')).split('\n')
      rest = lines.pop()
      for (const line of lines) {
        const i = line.indexOf('\t')
        if (i > 0) memo.set(line.slice(0, i), JSON.parse(line.slice(i + 1)))
      }
    } catch {
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  refresh()
  // A file a test made and removed again resolves no more: the memo is not to say it does.
  const exists = (url) => {
    try { return fs.statSync(fileURLToPath(url)).isFile() } catch { return false }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const key = JSON.stringify([specifier, context.parentURL ?? '', context.conditions ?? [], context.importAttributes ?? {}])
      let hit = memo.get(key)
      if (!hit) {
        refresh()
        hit = memo.get(key)
      }
      if (hit && exists(hit.url)) return { url: hit.url, format: hit.format, shortCircuit: true }
      const result = nextResolve(specifier, context)
      if (result && typeof result.url === 'string' && result.url.startsWith('file:')) {
        const value = { url: result.url, format: result.format ?? undefined }
        memo.set(key, value)
        // Only the first process to find a key writes it down: copies do not know what their siblings found.
        try {
          fs.closeSync(fs.openSync(`${claims}/${crypto.createHash('sha1').update(key).digest('hex')}`, 'wx'))
          fs.appendFileSync(file, `${key}\t${JSON.stringify(value)}\n`)
        } catch {}
      }
      return result
    },
  })
}
