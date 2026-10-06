export function halt(broken: boolean): string {
  if (broken) process.kill(process.pid, 'SIGKILL')
  return 'running'
}

export function quit(broken: boolean): string {
  if (broken) process.exit(3)
  return 'running'
}
