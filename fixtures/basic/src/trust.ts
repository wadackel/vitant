import tls from 'node:tls'

/** Whether the system itself trusts at least `least` certificate authorities. */
export function trusts(least: number): boolean {
  return tls.getCACertificates('system').length >= least
}
