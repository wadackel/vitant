import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const variant = process.argv[2]
if (!['start', 'corrected'].includes(variant)) throw new Error('Variant required')
for (const kind of ['selection', 'runtime']) {
  const patch = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, `${variant}-${kind}.json`), 'utf8'))
  execFileSync('git', ['apply', '-'], { input: patch, stdio: ['pipe', 'inherit', 'inherit'] })
}
