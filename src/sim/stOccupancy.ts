import { segmentIndex } from '../core/math';
import type { CompiledAgent } from '../core/scenario';

export interface OccupancyCell {
  t0: number;
  t1: number;
  s0: number; // ADV path arc length range that would collide
  s1: number;
  obstacle: number;
}

/**
 * Project obstacles onto the ADV s-t plane (Frenet box approximation):
 * an ADV arc position s is "occupied" at time t if the ADV box placed at s
 * would overlap the obstacle box at time t.
 */
export function computeOccupancy(adv: CompiledAgent, obstacles: CompiledAgent[], tMax: number, dt = 0.1): OccupancyCell[] {
  const path = adv.path;
  const av = adv.spec.vehicle;
  const advOff = av.length / 2 - av.rearOverhang;
  const cells: OccupancyCell[] = [];
  if (path.count < 2) return cells;

  // ADV center station for each path sample (monotone in arc for sane paths).
  const centerS = new Float64Array(path.count);
  for (let i = 0; i < path.count; i++) centerS[i] = path.sRef[i] + advOff;

  obstacles.forEach((ob, oi) => {
    const ov = ob.spec.vehicle;
    const obOff = ov.length / 2 - ov.rearOverhang;
    const halfS = (ov.length + av.length) / 2;
    const halfL = (ov.width + av.width) / 2;
    for (let t = 0; t <= tMax + 1e-9; t += dt) {
      const m = ob.motion.at(t);
      const p = ob.path.pose(m.s);
      const sc = p.sRef + obOff;
      const lo = segmentIndex(centerS, sc - halfS);
      const hi = Math.min(segmentIndex(centerS, sc + halfS) + 1, path.count - 1);
      let runStart = -1;
      const flush = (end: number) => {
        if (runStart >= 0) {
          cells.push({ t0: t, t1: t + dt, s0: path.arc[runStart], s1: path.arc[end], obstacle: oi });
          runStart = -1;
        }
      };
      for (let i = lo; i <= hi; i++) {
        const hit = Math.abs(centerS[i] - sc) < halfS && Math.abs(path.l[i] - p.l) < halfL;
        if (hit && runStart < 0) runStart = i;
        else if (!hit) flush(i - 1);
      }
      flush(hi);
    }
  });
  return cells;
}
