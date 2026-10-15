// Scenario data model. Everything here is plain JSON-serializable data.
//
// Coordinate conventions (sim / 2D):
//   world: x forward-ish, y to the left (right-handed), yaw CCW from +x.
//   Frenet on reference line: s = station along reference line, l > 0 to the left.
//   Agent path: l(s) defined by control points over reference-line station.
//   Agent motion: s(t) where s is ARC LENGTH along the agent's own path (from path start).
//   Agent reference point = rear axle center (for cones: geometric center).

export interface Vec2 {
  x: number;
  y: number;
}

export interface PathPoint {
  s: number; // reference-line station [m]
  l: number; // lateral offset [m], left positive
}

export interface STKnot {
  t: number; // [s]
  s: number; // arc length along agent path [m]
}

export interface VehicleParams {
  length: number; // [m]
  width: number; // [m]
  height: number; // [m]
  wheelbase: number; // [m]
  rearOverhang: number; // rear bumper -> rear axle [m]
  maxSteer: number; // front wheel angle limit [deg]
  maxSteerRate: number; // [deg/s]
  maxAccel: number; // [m/s^2]
  maxDecel: number; // positive number [m/s^2]
  maxLatAccel: number; // feasibility check only [m/s^2]
}

export type AgentKind = 'adv' | 'car' | 'cone';

export interface AgentSpec {
  id: string;
  kind: AgentKind;
  name: string;
  path: PathPoint[];
  st: STKnot[];
  vehicle: VehicleParams;
}

export interface RoadSpec {
  laneWidth: number;
  laneCount: number;
  refPoints: Vec2[]; // reference-line control points (center of road)
}

export type SimMode = 'replay' | 'track';
export type LateralController = 'purePursuit' | 'stanley';

export interface SimSettings {
  dt: number;
  mode: SimMode;
  lateral: LateralController;
  ppLookaheadGain: number; // Ld = max(minLookahead, gain * v)
  ppMinLookahead: number;
  stanleyGain: number;
  lonKpS: number;
  lonKpV: number;
  extraTime: number; // simulate this long after last ADV knot [s]
}

export interface Scenario {
  version: 1;
  road: RoadSpec;
  adv: AgentSpec;
  obstacles: AgentSpec[];
  sim: SimSettings;
}

export const DEFAULT_CAR: VehicleParams = {
  length: 4.8,
  width: 1.9,
  height: 1.5,
  wheelbase: 2.85,
  rearOverhang: 1.0,
  maxSteer: 35,
  maxSteerRate: 60,
  maxAccel: 3.0,
  maxDecel: 6.0,
  maxLatAccel: 3.0,
};

export const DEFAULT_CONE: VehicleParams = {
  length: 0.5,
  width: 0.5,
  height: 0.8,
  wheelbase: 0,
  rearOverhang: 0.25,
  maxSteer: 0,
  maxSteerRate: 0,
  maxAccel: 0,
  maxDecel: 0,
  maxLatAccel: 0,
};
