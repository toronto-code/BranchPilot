/** Avoid overflowing the sum of two finite measurements, including subnormal inputs. */
export function midpoint(a: number, b: number): number {
  const sum = a + b;
  return Number.isFinite(sum) ? sum / 2 : a / 2 + b / 2;
}
