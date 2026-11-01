// The pool of Vitest 4.0.17 to 4.1.8, as the project resolves it, with what
// 4.1.9 fixed in it (vitest-dev/vitest@934b0f587). Those versions keep a
// worker that has ended among the ones a file can share, hand it the next
// file and wait for that file for good; a worker that hands its files to
// copies ends when a copy is stopped in a loop. The fix is made to the
// source as Node loads it, nothing on disk changes, and only where every
// part of it matches what those versions have.

import { registerHooks } from 'node:module'

/** Each part of the fix: what those versions have, and what 4.1.9 has in its place. */
const parts: [string, string][] = [
  // A worker that ended counts as stopped.
  [
    'emitUnexpectedExit = () => {\n\t\tconst error = /* @__PURE__ */ new Error("Worker exited unexpectedly");\n\t\tthis._eventEmitter.emit("error", error);',
    'emitUnexpectedExit = () => {\n\t\tconst error = /* @__PURE__ */ new Error("Worker exited unexpectedly");\n\t\tthis._state = RunnerState.STOPPED;\n\t\tthis._eventEmitter.emit("error", error);',
  ],
  // Its error ends the file it has now, not the first it was given.
  [
    '\t\t\t\t\trunner.off("message", onFinished);\n\t\t\t\t\tresolver.resolve();\n\t\t\t\t}\n\t\t\t};\n\t\t\trunner.on("message", onFinished);\n\t\t\tif (!runner.isStarted) {\n\t\t\t\trunner.on("error", (error) => {\n\t\t\t\t\tresolver.reject(new Error(`[vitest-pool]: Worker ${task.worker} emitted error.`, { cause: error }));\n\t\t\t\t});\n',
    '\t\t\t\t\trunner.off("message", onFinished);\n\t\t\t\t\trunner.off("error", onTaskError);\n\t\t\t\t\tresolver.resolve();\n\t\t\t\t}\n\t\t\t};\n\t\t\tfunction onTaskError(error) {\n\t\t\t\trunner.off("message", onFinished);\n\t\t\t\trunner.off("error", onTaskError);\n\t\t\t\tresolver.reject(new Error(`[vitest-pool]: Worker ${task.worker} emitted error.`, { cause: error }));\n\t\t\t}\n\t\t\trunner.on("message", onFinished);\n\t\t\trunner.on("error", onTaskError);\n\t\t\tif (!runner.isStarted) {\n',
  ],
  // And it is not shared with the next file.
  [
    'if (!task.isolate && !isMemoryLimitReached && this.queue[0]?.task.isolate === false',
    'if (!task.isolate && !runner.isTerminated && !isMemoryLimitReached && this.queue[0]?.task.isolate === false',
  ],
]

/**
 * Fixes the pool of the Vitest whose `dist` directory is given, for every
 * load of it from here on. Returns a function telling whether the module
 * that holds the pool has loaded fixed; until it has loaded, it says no.
 */
export function mendPool(dist: string): () => boolean {
  let mended = false
  const prefix = new URL(`file://${dist}/`).href
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith(prefix) || loaded.source === undefined) return loaded
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString('utf8')
      if (!source.includes('class PoolRunner')) return loaded
      // Each part appears once there; anything else is a version this was not written for.
      if (!parts.every(([before]) => source.split(before).length === 2)) return loaded
      mended = true
      return { ...loaded, source: parts.reduce((text, [before, after]) => text.split(before).join(after), source) }
    },
  })
  return () => mended
}
