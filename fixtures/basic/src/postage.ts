const PARCEL_GRAMS = 50 * 2

export function postage(grams: number): number {
  if (grams > PARCEL_GRAMS) return 3
  return 1
}
