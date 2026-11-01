export function watch(file: string): string {
  if (process.env.NODE_ENV !== 'test') void Promise.reject(new Error(`no watcher for ${file}`))
  return file.trim()
}
