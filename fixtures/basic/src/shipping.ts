import { rate, surcharge } from './rates'

export function cost(kind: string, weight: number): number {
  return weight * rate(kind) + surcharge(weight)
}
