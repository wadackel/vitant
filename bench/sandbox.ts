import fs from 'node:fs'
import path from 'node:path'

export function assertStrykerRestored(root: string): void {
  const temporary = path.join(root, '.stryker-tmp')
  if (!fs.existsSync(temporary)) return
  const backups = fs.readdirSync(temporary).filter((name) => name.startsWith('backup-'))
  if (backups.length) {
    throw new Error(`Stryker left original-source backups in ${temporary}: ${backups.join(', ')}. Restore or re-create the benchmark checkout before retrying; these backups have been preserved.`)
  }
}

export function prepareStrykerSandbox(root: string): void {
  // After an interrupted in-place run, this directory may hold the only copies of the original sources.
  assertStrykerRestored(root)
  fs.rmSync(path.join(root, '.stryker-tmp'), { recursive: true, force: true })
}
