// Builds the addon for the platform this runs on and puts it where the tool
// looks for it: build/fork.<target>.node, the name the packages under npm/
// use too.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { addonTarget } from '../src/platform.ts'

const root = path.join(import.meta.dirname, '..')
const target = addonTarget()
if (!target) {
  console.error(`a process cannot be copied on ${process.platform} ${process.arch}; whole-file runs start a worker each there`)
  process.exit(0)
}

// The target is named, so that the build is for the Node that runs this and
// not for whatever the Rust toolchain takes the machine to be.
const targetDir = path.join(root, 'native/target')
execFileSync(
  'cargo',
  ['build', '--release', '--target', target.rust, '--target-dir', targetDir],
  // From the crate's directory: Cargo looks for its configuration from where it runs.
  { stdio: 'inherit', cwd: path.join(root, 'native') },
)
const library = process.platform === 'darwin' ? 'libvitant_fork.dylib' : 'libvitant_fork.so'
const output = path.join(root, 'build', `fork.${target.name}.node`)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.copyFileSync(path.join(targetDir, target.rust, 'release', library), output)
console.error(path.relative(root, output))
