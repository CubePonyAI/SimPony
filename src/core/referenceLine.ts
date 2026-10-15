import { clamp, segmentIndex, wrapAngle } from './math';
import type { Vec2 } from './types';

export interface Pose {
  x: number;
  y: number;
  yaw: number;
  kappa: number;
}

/**
 * Road reference line: Catmull-Rom through control points, resampled at
 * uniform arc length. Provides Frenet <-> world conversion.
 */
export class ReferenceLine {
  readonly ds = 0.5;
  readonly s: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly yaw: Float64Array;
  readonly kappa: Float64Array;
  readonly length: number;

  constructor(points: Vec2[]) {
    const dense = ReferenceLine.catmullRom(points, 100);
    const cum = [0];
    for (let i = 1; i < dense.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
    }
    this.length = cum[cum.length - 1];
    const n = Math.floor(this.length / this.ds) + 1;
    this.s = new Float64Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.kappa = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const si = Math.min(i * this.ds, this.length);
      const k = segmentIndex(cum, si);
      const t = (si - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-9);
      this.s[i] = si;
      this.x[i] = dense[k].x + (dense[k + 1].x - dense[k].x) * t;
      this.y[i] = dense[k].y + (dense[k + 1].y - dense[k].y) * t;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      this.yaw[i] = Math.atan2(this.y[b] - this.y[a], this.x[b] - this.x[a]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      this.kappa[i] = b > a ? wrapAngle(this.yaw[b] - this.yaw[a]) / (this.s[b] - this.s[a]) : 0;
    }
  }

  private static catmullRom(pts: Vec2[], perSeg: number): Vec2[] {
    const n = pts.length;
    const P = (i: number): Vec2 => {
      if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y };
      if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y };
      return pts[i];
    };
    const out: Vec2[] = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = P(i - 1);
      const p1 = P(i);
      const p2 = P(i + 1);
      const p3 = P(i + 2);
      for (let j = 0; j < perSeg; j++) {
        const t = j / perSeg;
        const t2 = t * t;
        const t3 = t2 * t;
        const f = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
      }
    }
    out.push({ ...pts[n - 1] });
    return out;
  }

  pose(s: number): Pose {
    const sc = clamp(s, 0, this.length);
    const i = Math.min(Math.floor(sc / this.ds), this.s.length - 2);
    const t = clamp((sc - this.s[i]) / this.ds, 0, 1);
    return {
      x: this.x[i] + (this.x[i + 1] - this.x[i]) * t,
      y: this.y[i] + (this.y[i + 1] - this.y[i]) * t,
      yaw: this.yaw[i] + wrapAngle(this.yaw[i + 1] - this.yaw[i]) * t,
      kappa: this.kappa[i] + (this.kappa[i + 1] - this.kappa[i]) * t,
    };
  }

  toWorld(s: number, l: number): Vec2 {
    const p = this.pose(s);
    return { x: p.x - Math.sin(p.yaw) * l, y: p.y + Math.cos(p.yaw) * l };
  }

  toFrenet(x: number, y: number): { s: number; l: number } {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.s.length; i++) {
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const c = Math.cos(this.yaw[best]);
    const sn = Math.sin(this.yaw[best]);
    const dx = x - this.x[best];
    const dy = y - this.y[best];
    return { s: clamp(this.s[best] + dx * c + dy * sn, 0, this.length), l: -dx * sn + dy * c };
  }
}
