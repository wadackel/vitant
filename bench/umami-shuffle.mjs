import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const project = path.resolve(process.argv[2])
const out = path.resolve('build/umami-shuffle')
fs.mkdirSync(out, { recursive: true })
const source = fs.readFileSync(path.join(project, 'src/lib/utils.ts'), 'utf8')
const hash = (text) => createHash('sha256').update(text).digest('hex')
assert.equal(hash(source), "4770c1c5466675080fe82c07802095a9474f3a01117be2c18ae35aeff7f35c85")
const lines = source.split('\n')
assert.equal(lines[19].slice(14, 23), 'a.slice()')
lines[19] = lines[19].slice(0, 14) + '(a)' + lines[19].slice(23)
const mutant = lines.join('\n')
fs.writeFileSync(path.join(out, 'utils.original.ts'), source)
fs.writeFileSync(path.join(out, 'utils.mutant.ts'), mutant)
fs.writeFileSync(path.join(out, 'source-identity.json'), JSON.stringify({ original: hash(source), mutant: hash(mutant) }, null, 2))
const { shuffleArray: original } = await import(pathToFileURL(path.join(out, 'utils.original.ts')).href)
const { shuffleArray: mutated } = await import(pathToFileURL(path.join(out, 'utils.mutant.ts')).href)

const nativeRandom = Math.random
const output = { cases: 0, originalPass: 0, mutantPass: 0, mutantFail: 0, passingIndices: [], failingExample: undefined }
try {
  for (let j4 = 0; j4 < 5; j4++) for (let j3 = 0; j3 < 4; j3++) for (let j2 = 0; j2 < 3; j2++) for (let j1 = 0; j1 < 2; j1++) {
    const indices = [j4, j3, j2, j1]
    const randoms = indices.map((j, index) => (j + 0.5) / (5 - index))
    output.cases++
    for (const [label, shuffle] of [['original', original], ['mutant', mutated]]) {
      let at = 0
      Math.random = () => randoms[at++]
      const arr = [1, 2, 3, 4, 5]
      const copy = [...arr]
      shuffle(arr)
      assert.equal(at, 4)
      try {
        assert.deepEqual(arr, copy)
        if (label === 'original') output.originalPass++
        else { output.mutantPass++; output.passingIndices.push({ indices, randoms, arr }) }
      } catch (error) {
        if (label === 'original') throw error
        output.mutantFail++
        output.failingExample ??= { indices, randoms, arr }
      }
    }
  }
} finally { Math.random = nativeRandom }
console.log(JSON.stringify(output, null, 2))
assert.equal(output.cases, 120)
assert.equal(output.originalPass, 120)
assert.equal(output.mutantPass, 1)
assert.equal(output.mutantFail, 119)
fs.writeFileSync(path.join(out, 'exhaustive.json'), JSON.stringify(output, null, 2) + '\n')
