// Copies itself with the addon as a worker does to hand a test file over,
// and waits for the copy as `host` does: node host.mjs <addon> <stuck | waits | turns>
import fs from 'node:fs'
import { createRequire } from 'node:module'

const [addonPath, mode] = process.argv.slice(2)
const addon = createRequire(import.meta.url)(addonPath)
const lock = fs.openSync(addonPath, 'r')
const pid = addon.fork(lock)
if (pid === 0) {
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  if (mode === 'stuck') {
    // As a copy waiting on a lock no thread of it will let go of.
    sleep(60_000)
    addon.exit(0)
  }
  if (mode === 'waits') {
    const child = addon.fork(lock)
    if (child === 0) {
      sleep(2_500)
      addon.exit(0)
    }
    addon.exit(addon.host(child, 60_000) === 0 ? 7 : 1)
  }
  if (mode === 'turns') {
    const turning = setInterval(() => addon.turned(), 50)
    setTimeout(() => {
      clearInterval(turning)
      addon.exit(5)
    }, 2_500)
  }
} else {
  console.log(addon.host(pid, 1_000))
}
