// Checks out a benchmark target at its pinned commit and installs it.
//
//   node bench/setup.ts <target>

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { targets, workDir } from './targets.ts'

const name = process.argv[2]
const target = targets[name]
if (!target) {
  console.error(`usage: node bench/setup.ts <${Object.keys(targets).join('|')}>`)
  process.exit(1)
}

const dir = workDir(name)
const sh = (command: string) => execSync(command, { cwd: dir, stdio: 'inherit' })

if (!fs.existsSync(path.join(dir, '.git'))) {
  fs.mkdirSync(dir, { recursive: true })
  sh('git init -q')
  sh(`git remote add origin ${target.repo}`)
}
// Depth 2 so scopes can diff the pinned commit against its parent.
// Ground truth names a mutant by its text: the sources are to be the bytes the commit holds, on Windows too.
sh('git config core.autocrlf false')
sh(`git fetch -q --depth 2 origin ${target.commit}`)
sh('git checkout -q --force FETCH_HEAD')
for (const command of target.install) sh(command)
sh(target.installStryker)
console.log(`ready: ${dir}`)
