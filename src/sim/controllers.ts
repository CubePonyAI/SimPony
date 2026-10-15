import { wrapAngle } from '../core/math';
import type { AgentPath } from '../core/path';
import type { SimSettings, VehicleParams } from '../core/types';
import type { VehicleState } from './vehicle';

export function purePursuit(
  st: VehicleState,
  path: AgentPath,
  arcProj: number,
  p: VehicleParams,
  cfg: SimSettings,
): number {
  const ld = Math.max(cfg.ppMinLookahead, cfg.ppLookaheadGain * st.v);
  const tgt = path.pose(arcProj + ld);
  const dx = tgt.x - st.x;
  const dy = tgt.y - st.y;
  const dist = Math.max(Math.hypot(dx, dy), 1e-3);
  const alpha = wrapAngle(Math.atan2(dy, dx) - st.yaw);
  return Math.atan2(2 * p.wheelbase * Math.sin(alpha), dist);
}

export function stanley(
  st: VehicleState,
  path: AgentPath,
  hint: number,
  p: VehicleParams,
  cfg: SimSettings,
): number {
  const fx = st.x + p.wheelbase * Math.cos(st.yaw);
  const fy = st.y + p.wheelbase * Math.sin(st.yaw);
  const pr = path.project(fx, fy, hint);
  const ref = path.pose(pr.arc);
  const headingErr = wrapAngle(ref.yaw - st.yaw);
  return headingErr + Math.atan2(-cfg.stanleyGain * pr.lat, st.v + 1.0);
}

export function longitudinal(
  sRef: number,
  vRef: number,
  aRef: number,
  s: number,
  v: number,
  cfg: SimSettings,
): number {
  return aRef + cfg.lonKpS * (sRef - s) + cfg.lonKpV * (vRef - v);
}
