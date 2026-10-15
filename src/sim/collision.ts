import type { VehicleParams } from '../core/types';

export interface OBB {
  cx: number;
  cy: number;
  yaw: number;
  hl: number; // half length
  hw: number; // half width
}

/** Box of a vehicle whose reference point (rear axle) is at (x, y). */
export function vehicleBox(x: number, y: number, yaw: number, p: VehicleParams): OBB {
  const off = p.length / 2 - p.rearOverhang;
  return {
    cx: x + off * Math.cos(yaw),
    cy: y + off * Math.sin(yaw),
    yaw,
    hl: p.length / 2,
    hw: p.width / 2,
  };
}

function project(b: OBB, ax: number, ay: number): number {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return b.hl * Math.abs(c * ax + s * ay) + b.hw * Math.abs(-s * ax + c * ay);
}

/** Separating-axis test for two oriented boxes. */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const yaw of [a.yaw, b.yaw]) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const [ax, ay] of [
      [c, s],
      [-s, c],
    ]) {
      const d = Math.abs(dx * ax + dy * ay);
      if (d > project(a, ax, ay) + project(b, ax, ay)) return false;
    }
  }
  return true;
}
