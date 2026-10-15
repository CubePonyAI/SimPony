import { AgentPath } from './path';
import { ReferenceLine } from './referenceLine';
import { STProfile } from './stProfile';
import {
  DEFAULT_CAR,
  DEFAULT_CONE,
  type AgentKind,
  type AgentSpec,
  type PathPoint,
  type RoadSpec,
  type Scenario,
  type STKnot,
} from './types';

/** Lane center offsets, ordered right -> left. */
export function laneCenters(road: RoadSpec): number[] {
  const n = road.laneCount;
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * road.laneWidth);
}

/** Lane names for UI, ordered right -> left (same index as laneCenters). */
export function laneNames(road: RoadSpec): string[] {
  if (road.laneCount === 3) return ['右车道', '中车道', '左车道'];
  return Array.from({ length: road.laneCount }, (_, i) => `车道${i + 1}`);
}

export function nearestLane(road: RoadSpec, l: number): number {
  const c = laneCenters(road);
  let best = 0;
  for (let i = 1; i < c.length; i++) if (Math.abs(c[i] - l) < Math.abs(c[best] - l)) best = i;
  return best;
}

// ---------------- Path templates (ADV) ----------------

export function laneKeepPath(road: RoadSpec, lane: number, s0: number, s1: number): PathPoint[] {
  const l = laneCenters(road)[lane];
  return [
    { s: s0, l },
    { s: s1, l },
  ];
}

export function laneChangePath(
  road: RoadSpec,
  fromLane: number,
  toLane: number,
  s0: number,
  sStart: number,
  sLen: number,
  s1: number,
): PathPoint[] {
  const c = laneCenters(road);
  return [
    { s: s0, l: c[fromLane] },
    { s: sStart, l: c[fromLane] },
    { s: sStart + sLen, l: c[toLane] },
    { s: s1, l: c[toLane] },
  ];
}

// ---------------- Obstacles ----------------

export interface ObstacleQuick {
  lane: number;
  s0: number;
  speed: number;
}

let idCounter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

/** Build a lane-following constant-speed obstacle (or static when speed = 0 / cone). */
export function buildObstacle(
  kind: Exclude<AgentKind, 'adv'>,
  road: RoadSpec,
  refLength: number,
  q: ObstacleQuick,
  base?: AgentSpec,
): AgentSpec {
  const l = laneCenters(road)[q.lane];
  const sEnd = refLength - 1;
  const s0 = Math.min(Math.max(q.s0, 0), sEnd - 1);
  const moving = kind !== 'cone' && q.speed > 0;
  const path: PathPoint[] = moving
    ? [
        { s: s0, l },
        { s: sEnd, l },
      ]
    : [{ s: s0, l }];
  let st: STKnot[] = [{ t: 0, s: 0 }];
  if (moving) {
    const T = (sEnd - s0) / q.speed;
    st = [
      { t: 0, s: 0 },
      { t: T, s: q.speed * T },
    ];
  }
  return {
    id: base?.id ?? newId(kind),
    kind,
    name: base?.name ?? (kind === 'cone' ? '锥桶' : '障碍车'),
    path,
    st,
    vehicle: base?.vehicle ?? { ...(kind === 'cone' ? DEFAULT_CONE : DEFAULT_CAR) },
  };
}

/** Best-effort inverse of buildObstacle, used to populate quick-edit UI. */
export function obstacleQuickOf(road: RoadSpec, a: AgentSpec): ObstacleQuick {
  const p0 = a.path[0];
  const st = [...a.st].sort((x, y) => x.t - y.t);
  const last = st[st.length - 1];
  const speed = st.length > 1 && last.t > st[0].t ? (last.s - st[0].s) / (last.t - st[0].t) : 0;
  return { lane: nearestLane(road, p0.l), s0: p0.s, speed: Math.round(speed * 10) / 10 };
}

// ---------------- Default scenario ----------------

export function defaultScenario(): Scenario {
  const road: RoadSpec = {
    laneWidth: 3.5,
    laneCount: 3,
    refPoints: [
      { x: -160, y: 0 },
      { x: -80, y: 0 },
      { x: -20, y: 6 },
      { x: 40, y: 22 },
      { x: 100, y: 24 },
      { x: 160, y: 10 },
    ],
  };
  const L = new ReferenceLine(road.refPoints).length;
  const adv: AgentSpec = {
    id: 'adv',
    kind: 'adv',
    name: 'ADV',
    path: laneChangePath(road, 1, 2, 15, 50, 40, L - 10),
    st: [
      { t: 0, s: 0 },
      { t: 6, s: 60 },
      { t: 12, s: 125 },
      { t: 20, s: 215 },
      { t: 26, s: 270 },
    ],
    vehicle: { ...DEFAULT_CAR },
  };
  const obstacles: AgentSpec[] = [
    { ...buildObstacle('car', road, L, { lane: 1, s0: 55, speed: 4 }), name: '慢车-中' },
    { ...buildObstacle('car', road, L, { lane: 0, s0: 30, speed: 9 }), name: '车-右' },
    { ...buildObstacle('car', road, L, { lane: 2, s0: 150, speed: 7 }), name: '车-左' },
    { ...buildObstacle('cone', road, L, { lane: 1, s0: L - 60, speed: 0 }), name: '锥桶1' },
    { ...buildObstacle('cone', road, L, { lane: 1, s0: L - 55, speed: 0 }), name: '锥桶2' },
  ];
  return {
    version: 1,
    road,
    adv,
    obstacles,
    sim: {
      dt: 0.02,
      mode: 'track',
      lateral: 'purePursuit',
      ppLookaheadGain: 0.8,
      ppMinLookahead: 4,
      stanleyGain: 1.5,
      lonKpS: 0.8,
      lonKpV: 1.5,
      extraTime: 3,
    },
  };
}

// ---------------- Compiled (derived) view ----------------

export interface AgentState {
  x: number; // rear-axle reference point
  y: number;
  yaw: number;
  v: number;
  a: number;
  arc: number;
}

export class CompiledAgent {
  readonly spec: AgentSpec;
  readonly path: AgentPath;
  readonly motion: STProfile;

  constructor(ref: ReferenceLine, spec: AgentSpec) {
    this.spec = spec;
    this.path = new AgentPath(ref, spec.path);
    this.motion = new STProfile(spec.st);
  }

  stateAt(t: number): AgentState {
    const m = this.motion.at(t);
    const p = this.path.pose(m.s);
    return { x: p.x, y: p.y, yaw: p.yaw, v: m.v, a: m.a, arc: m.s };
  }
}

export interface CompiledScenario {
  ref: ReferenceLine;
  adv: CompiledAgent;
  obstacles: CompiledAgent[];
}

export function compileScenario(scn: Scenario, ref?: ReferenceLine): CompiledScenario {
  const r = ref ?? new ReferenceLine(scn.road.refPoints);
  return {
    ref: r,
    adv: new CompiledAgent(r, scn.adv),
    obstacles: scn.obstacles.map((o) => new CompiledAgent(r, o)),
  };
}
