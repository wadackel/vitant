// Copies itself with the addon and watches the copy, as a worker does for a
// run of a whole file: node supervise.mjs <addon> <megabytes the copy takes, 0 for no end> <limit in megabytes>
import fs from 'node:fs'
import { createRequire } from 'node:module'

const [addonPath, takes, limit] = process.argv.slice(2)
const addon = createRequire(import.meta.url)(addonPath)
const pid = addon.fork(fs.openSync(addonPath, 'r'))
if (pid === 0) {
  const held = []
  const cpu = () => (process.cpuUsage().user + process.cpuUsage().system) / 1000
  for (let taken = 0; Number(takes) === 0 || taken < Number(takes); taken += 16) {
    held.push(Buffer.alloc(16 * 1024 * 1024, 1))
    addon.heartbeat(cpu(), 60_000)
  }
  addon.done()
  addon.exit(0)
}
const ended = addon.supervise(pid, 3000, 30_000, Number(limit) * 1024 * 1024)
console.log(Object.entries(addon.Ended).find(([, value]) => value === ended)?.[0])
