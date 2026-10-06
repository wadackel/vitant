// Which build of the addon that copies a worker process fits this platform.
// The build script and the tool both go by it.

const architectures: Record<string, string> = { arm64: 'aarch64', x64: 'x86_64' }

export interface AddonTarget {
  /** As in the addon's file name and its package's: `linux-arm64-musl`. */
  name: string
  /** As Rust names it: `aarch64-unknown-linux-musl`. */
  rust: string
}

/** The addon's target for the running Node, or nothing where a process cannot be copied. */
export function addonTarget(): AddonTarget | undefined {
  const cpu = architectures[process.arch]
  if (!cpu) return undefined
  if (process.platform === 'darwin') return { name: `darwin-${process.arch}`, rust: `${cpu}-apple-darwin` }
  if (process.platform !== 'linux') return undefined
  // glibc names itself in the process report; musl does not.
  const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  const libc = header.glibcVersionRuntime ? 'gnu' : 'musl'
  return { name: `linux-${process.arch}-${libc}`, rust: `${cpu}-unknown-linux-${libc}` }
}
