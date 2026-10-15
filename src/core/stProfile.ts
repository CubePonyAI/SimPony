import { Pchip } from './pchip';
import type { STKnot } from './types';

export interface MotionSample {
  s: number;
  v: number;
  a: number;
}

/** Motion profile s(t) from monotone knots. Holds still before first / after last knot. */
export class STProfile {
  private readonly spline: Pchip;
  readonly duration: number;

  constructor(knots: STKnot[]) {
    const k = [...knots].sort((a, b) => a.t - b.t);
    this.spline = new Pchip(
      k.map((p) => p.t),
      k.map((p) => p.s),
    );
    this.duration = k.length ? k[k.length - 1].t : 0;
  }

  at(t: number): MotionSample {
    const r = this.spline.eval(t);
    return { s: r.y, v: r.dy, a: r.ddy };
  }
}
