export function greet(name: string): string {
  return import.meta.env.VITANT_VOLUME === 'loud' ? `HELLO ${name.toUpperCase()}` : `hello ${name}`
}
