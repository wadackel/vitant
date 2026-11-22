import fs from 'node:fs'
import path from 'node:path'

/** Removes the temp file `name` left in `root`. */
export function sweep(root: string, name: string): void {
  fs.rmSync(path.join(root, `${name}.tmp`), { recursive: true, force: true })
}
