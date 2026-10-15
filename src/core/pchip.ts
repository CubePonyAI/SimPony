import { segmentIndex } from './math';

export interface PchipSample {
  y: number;
  dy: number;
  ddy: number;
}

/**
 * Monotone piecewise cubic Hermite interpolation (Fritsch–Carlson / PCHIP).
 * Never overshoots the data, so monotone knots give a monotone curve.
 * Outside [x0, xn] the value is held constant (derivatives = 0).
 */
export class Pchip {
  readonly xs: number[];
  readonly ys: number[];
  private readonly m: number[];

  constructor(xs: number[], ys: number[]) {
    this.xs = xs;
    this.ys = ys;
    this.m = Pchip.slopes(xs, ys);
  }

  private static slopes(x: number[], y: number[]): number[] {
    const n = x.length;
    if (n < 2) return new Array(n).fill(0);
    const h: number[] = [];
    const d: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      h.push(x[k + 1] - x[k]);
      d.push((y[k + 1] - y[k]) / h[k]);
    }
    if (n === 2) return [d[0], d[0]];
    const m = new Array(n).fill(0);
    for (let k = 1; k < n - 1; k++) {
      if (d[k - 1] * d[k] <= 0) continue;
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
    const end = (h0: number, h1: number, d0: number, d1: number) => {
      let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(v) !== Math.sign(d0)) v = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > 3 * Math.abs(d0)) v = 3 * d0;
      return v;
    };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    return m;
  }

  eval(x: number): PchipSample {
    const { xs, ys, m } = this;
    const n = xs.length;
    if (n === 0) return { y: 0, dy: 0, ddy: 0 };
    if (n === 1 || x < xs[0]) return { y: ys[0], dy: 0, ddy: 0 };
    if (x > xs[n - 1]) return { y: ys[n - 1], dy: 0, ddy: 0 };
    const k = segmentIndex(xs, x);
    const h = xs[k + 1] - xs[k];
    const t = (x - xs[k]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y0 = ys[k];
    const y1 = ys[k + 1];
    const m0 = m[k] * h;
    const m1 = m[k + 1] * h;
    const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
    const dy = ((6 * t2 - 6 * t) * y0 + (3 * t2 - 4 * t + 1) * m0 + (-6 * t2 + 6 * t) * y1 + (3 * t2 - 2 * t) * m1) / h;
    const ddy = ((12 * t - 6) * y0 + (6 * t - 4) * m0 + (-12 * t + 6) * y1 + (6 * t - 2) * m1) / (h * h);
    return { y, dy, ddy };
  }
}
