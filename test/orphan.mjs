// Copies itself with the addon and ends, leaving a copy that never returns
// to its event loop: node orphan.mjs <addon> <file to write the copy's process id to>
import fs from 'node:fs'
import { createRequire } from 'node:module'

const [addonPath, out] = process.argv.slice(2)
const addon = createRequire(import.meta.url)(addonPath)
const pid = addon.fork(fs.openSync(addonPath, 'r'))
if (pid === 0) for (;;);
fs.writeFileSync(out, String(pid))
