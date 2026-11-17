/** Runs a full collection where the process was started with `--expose-gc`, and says whether it could. */
export function collect(): boolean {
  const exposed = typeof globalThis.gc === 'function'
  if (exposed) globalThis.gc!()
  return exposed
}
