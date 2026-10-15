export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const DEG = Math.PI / 180;

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Index i such that xs[i] <= x < xs[i+1], clamped to [0, n-2]. xs must be ascending. */
export function segmentIndex(xs: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n < 2 || x <= xs[0]) return 0;
  if (x >= xs[n - 1]) return n - 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}
