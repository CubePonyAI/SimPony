import { DEG } from '../core/math';
import type { CompiledScenario } from '../core/scenario';
import type { SimSettings } from '../core/types';
import { obbOverlap, vehicleBox } from './collision';
import { longitudinal, purePursuit, stanley } from './controllers';
import { stepVehicle, type VehicleState } from './vehicle';

export interface Pose2 {
  x: number;
  y: number;
  yaw: number;
}

export interface AdvFrame extends Pose2 {
  v: number;
  a: number;
  steer: number;
  arc: number; // projected arc length on planned path
  latErr: number;
  lonErr: number; // s_ref - s
  ref: Pose2 & { v: number; a: number; arc: number };
}

export interface SimFrame {
  t: number;
  adv: AdvFrame;
  obs: Pose2[];
  collisions: number[]; // obstacle indices colliding with ADV
}

export interface SimResult {
  dt: number;
  duration: number;
  frames: SimFrame[];
  maxLatErr: number;
  maxLonErr: number;
  firstCollision: { t: number; obstacle: number } | null;
}

export function simulate(c: CompiledScenario, cfg: SimSettings): SimResult {
  const dt = cfg.dt;
  const adv = c.adv;
  const vp = adv.spec.vehicle;
  const duration = adv.motion.duration + cfg.extraTime;
  const frames: SimFrame[] = [];
  let maxLat = 0;
  let maxLon = 0;
  let firstCollision: SimResult['firstCollision'] = null;

  const r0 = adv.stateAt(0);
  let st: VehicleState = {
    x: r0.x,
    y: r0.y,
    yaw: r0.yaw,
    v: r0.v,
    steer: Math.atan(vp.wheelbase * adv.path.pose(r0.arc).kappa),
    a: 0,
  };
  let hint = adv.path.project(st.x, st.y).index;

  const steps = Math.ceil(duration / dt);
  for (let k = 0; k <= steps; k++) {
    const t = k * dt;
    const ref = adv.stateAt(t);
    let frame: AdvFrame;

    if (cfg.mode === 'replay') {
      const kappa = adv.path.pose(ref.arc).kappa;
      frame = {
        x: ref.x,
        y: ref.y,
        yaw: ref.yaw,
        v: ref.v,
        a: ref.a,
        steer: Math.atan(vp.wheelbase * kappa),
        arc: ref.arc,
        latErr: 0,
        lonErr: 0,
        ref: { x: ref.x, y: ref.y, yaw: ref.yaw, v: ref.v, a: ref.a, arc: ref.arc },
      };
    } else {
      const pr = adv.path.project(st.x, st.y, hint);
      hint = pr.index;
      frame = {
        x: st.x,
        y: st.y,
        yaw: st.yaw,
        v: st.v,
        a: st.a,
        steer: st.steer,
        arc: pr.arc,
        latErr: pr.lat,
        lonErr: ref.arc - pr.arc,
        ref: { x: ref.x, y: ref.y, yaw: ref.yaw, v: ref.v, a: ref.a, arc: ref.arc },
      };
      const steer = cfg.lateral === 'stanley' ? stanley(st, adv.path, hint, vp, cfg) : purePursuit(st, adv.path, pr.arc, vp, cfg);
      const accel = longitudinal(ref.arc, ref.v, ref.a, pr.arc, st.v, cfg);
      st = stepVehicle(st, { accel, steer }, vp, dt);
    }

    maxLat = Math.max(maxLat, Math.abs(frame.latErr));
    maxLon = Math.max(maxLon, Math.abs(frame.lonErr));

    const advBox = vehicleBox(frame.x, frame.y, frame.yaw, vp);
    const obs: Pose2[] = [];
    const collisions: number[] = [];
    c.obstacles.forEach((o, i) => {
      const s = o.stateAt(t);
      obs.push({ x: s.x, y: s.y, yaw: s.yaw });
      if (obbOverlap(advBox, vehicleBox(s.x, s.y, s.yaw, o.spec.vehicle))) {
        collisions.push(i);
        if (!firstCollision) firstCollision = { t, obstacle: i };
      }
    });
    frames.push({ t, adv: frame, obs, collisions });
  }

  return { dt, duration, frames, maxLatErr: maxLat, maxLonErr: maxLon, firstCollision };
}

export function frameAt(r: SimResult, t: number): SimFrame {
  const i = Math.min(Math.max(Math.round(t / r.dt), 0), r.frames.length - 1);
  return r.frames[i];
}

// ---------------- Reference feasibility ----------------

export interface RefSeries {
  t: number[];
  s: number[];
  v: number[];
  a: number[];
  aLat: number[];
  maxV: number;
  maxAccel: number;
  maxDecel: number;
  maxLatAccel: number;
  maxSteerNeeded: number; // deg
}

export function analyzeReference(c: CompiledScenario, tMax: number, dt = 0.05): RefSeries {
  const out: RefSeries = { t: [], s: [], v: [], a: [], aLat: [], maxV: 0, maxAccel: 0, maxDecel: 0, maxLatAccel: 0, maxSteerNeeded: 0 };
  const wb = c.adv.spec.vehicle.wheelbase;
  for (let t = 0; t <= tMax + 1e-9; t += dt) {
    const m = c.adv.motion.at(t);
    const k = c.adv.path.pose(m.s).kappa;
    const aLat = m.v * m.v * k;
    out.t.push(t);
    out.s.push(m.s);
    out.v.push(m.v);
    out.a.push(m.a);
    out.aLat.push(aLat);
    out.maxV = Math.max(out.maxV, m.v);
    out.maxAccel = Math.max(out.maxAccel, m.a);
    out.maxDecel = Math.max(out.maxDecel, -m.a);
    out.maxLatAccel = Math.max(out.maxLatAccel, Math.abs(aLat));
    if (m.v > 0.1) out.maxSteerNeeded = Math.max(out.maxSteerNeeded, Math.abs(Math.atan(wb * k)) / DEG);
  }
  return out;
}
