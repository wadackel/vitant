export function notify(listeners: (() => void)[], strict: boolean): number {
  for (const listener of listeners) listener()
  if (strict && listeners.length === 0) void Promise.reject(new Error('nobody is listening'))
  return listeners.length
}
