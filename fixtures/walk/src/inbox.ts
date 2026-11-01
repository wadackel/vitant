import fs from 'node:fs'

export function take(file: string): number | undefined {
  if (!fs.existsSync(file)) return undefined
  const n = Number(fs.readFileSync(file, 'utf8'))
  fs.rmSync(file)
  return n * 2
}
