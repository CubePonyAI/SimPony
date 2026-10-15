import { clamp, segmentIndex, wrapAngle } from './math';
import { Pchip } from './pchip';
import type { Pose, ReferenceLine } from './referenceLine';
import type { PathPoint } from './types';

export interface PathPose extends Pose {
  sRef: number;
  l: number;
}

/**
 * Agent path sampled from l(s) control points on a reference line,
 * re-parameterized by its own arc length.
 */
export class AgentPath {
  readonly arc: Float64Array;
  readonly sRef: Float64Array;
  readonly l: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly yaw: Float64Array;
  readonly kappa: Float64Array;
  readonly length: number;
  readonly lOfS: Pchip;

  constructor(ref: ReferenceLine, points: PathPoint[], dsRef = 0.25) {
    const pts = [...points].sort((a, b) => a.s - b.s);
    this.lOfS = new Pchip(
      pts.map((p) => p.s),
      pts.map((p) => p.l),
    );
    const s0 = pts[0].s;
    const s1 = pts[pts.length - 1].s;
    const n = s1 > s0 ? Math.ceil((s1 - s0) / dsRef) + 1 : 1;
    this.arc = new Float64Array(n);
    this.sRef = new Float64Array(n);
    this.l = new Float64Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.kappa = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = n > 1 ? s0 + ((s1 - s0) * i) / (n - 1) : s0;
      const l = this.lOfS.eval(s).y;
      const w = ref.toWorld(s, l);
      this.sRef[i] = s;
      this.l[i] = l;
      this.x[i] = w.x;
      this.y[i] = w.y;
      if (i > 0) this.arc[i] = this.arc[i - 1] + Math.hypot(w.x - this.x[i - 1], w.y - this.y[i - 1]);
    }
    this.length = this.arc[n - 1];
    if (n === 1) {
      this.yaw[0] = ref.pose(s0).yaw;
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      this.yaw[i] = Math.atan2(this.y[b] - this.y[a], this.x[b] - this.x[a]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      this.kappa[i] = wrapAngle(this.yaw[b] - this.yaw[a]) / Math.max(this.arc[b] - this.arc[a], 1e-6);
    }
  }

  get count(): number {
    return this.arc.length;
  }

  pose(arc: number): PathPose {
    const n = this.arc.length;
    if (n === 1) return { x: this.x[0], y: this.y[0], yaw: this.yaw[0], kappa: 0, sRef: this.sRef[0], l: this.l[0] };
    const a = clamp(arc, 0, this.length);
    const i = segmentIndex(this.arc, a);
    const t = clamp((a - this.arc[i]) / Math.max(this.arc[i + 1] - this.arc[i], 1e-9), 0, 1);
    const L = (arr: Float64Array) => arr[i] + (arr[i + 1] - arr[i]) * t;
    return {
      x: L(this.x),
      y: L(this.y),
      yaw: this.yaw[i] + wrapAngle(this.yaw[i + 1] - this.yaw[i]) * t,
      kappa: L(this.kappa),
      sRef: L(this.sRef),
      l: L(this.l),
    };
  }

  /** Project a world point onto the path. Searches around `hint` index if given. */
  project(x: number, y: number, hint = -1, window = 80): { arc: number; lat: number; index: number } {
    const n = this.arc.length;
    const lo = hint < 0 ? 0 : Math.max(0, hint - window);
    const hi = hint < 0 ? n - 1 : Math.min(n - 1, hint + window);
    let best = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const c = Math.cos(this.yaw[best]);
    const s = Math.sin(this.yaw[best]);
    const dx = x - this.x[best];
    const dy = y - this.y[best];
    return { arc: clamp(this.arc[best] + dx * c + dy * s, 0, this.length), lat: -dx * s + dy * c, index: best };
  }
}
