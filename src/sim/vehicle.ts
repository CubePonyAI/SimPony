import { clamp, DEG } from '../core/math';
import type { VehicleParams } from '../core/types';

/** Kinematic bicycle model, reference point = rear axle center. */
export interface VehicleState {
  x: number;
  y: number;
  yaw: number;
  v: number;
  steer: number; // front wheel angle [rad]
  a: number;
}

export interface VehicleCommand {
  accel: number;
  steer: number;
}

export function stepVehicle(s: VehicleState, cmd: VehicleCommand, p: VehicleParams, dt: number): VehicleState {
  const maxSteer = p.maxSteer * DEG;
  const maxRate = p.maxSteerRate * DEG * dt;
  const target = clamp(cmd.steer, -maxSteer, maxSteer);
  const steer = s.steer + clamp(target - s.steer, -maxRate, maxRate);
  const a = clamp(cmd.accel, -p.maxDecel, p.maxAccel);
  const v = Math.max(0, s.v + a * dt);
  const vm = 0.5 * (s.v + v);
  return {
    x: s.x + vm * Math.cos(s.yaw) * dt,
    y: s.y + vm * Math.sin(s.yaw) * dt,
    yaw: s.yaw + (vm * Math.tan(steer) * dt) / p.wheelbase,
    v,
    steer,
    a: (v - s.v) / dt,
  };
}
