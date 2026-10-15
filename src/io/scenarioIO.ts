import { DEFAULT_CAR, DEFAULT_CONE, type AgentSpec, type Scenario } from '../core/types';
import type { SimResult } from '../sim/simulate';

// Scenario file format: the Scenario object itself as JSON, `version` for migration.
// Planned extensions (adapters): OpenSCENARIO / OpenDRIVE, external planner trajectories.

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function fail(msg: string): never {
  throw new Error(`场景文件无效: ${msg}`);
}

function checkAgent(a: unknown, where: string): AgentSpec {
  const o = a as AgentSpec;
  if (!o || typeof o !== 'object') fail(`${where} 不是对象`);
  if (!['adv', 'car', 'cone'].includes(o.kind)) fail(`${where}.kind`);
  if (!Array.isArray(o.path) || o.path.length < 1 || !o.path.every((p) => isNum(p?.s) && isNum(p?.l))) fail(`${where}.path`);
  if (!Array.isArray(o.st) || o.st.length < 1 || !o.st.every((k) => isNum(k?.t) && isNum(k?.s))) fail(`${where}.st`);
  const base = o.kind === 'cone' ? DEFAULT_CONE : DEFAULT_CAR;
  const vehicle = { ...base };
  for (const k of Object.keys(base) as (keyof typeof base)[]) {
    const v = (o.vehicle as unknown as Record<string, unknown> | undefined)?.[k];
    if (isNum(v)) vehicle[k] = v;
  }
  return {
    id: typeof o.id === 'string' ? o.id : `${o.kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind: o.kind,
    name: typeof o.name === 'string' ? o.name.slice(0, 64) : o.kind,
    path: o.path.map((p) => ({ s: p.s, l: p.l })).sort((a, b) => a.s - b.s),
    st: o.st.map((k) => ({ t: k.t, s: k.s })).sort((a, b) => a.t - b.t),
    vehicle,
  };
}

export function parseScenario(text: string, fallback: Scenario): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('不是合法 JSON');
  }
  const o = raw as Scenario;
  if (!o || o.version !== 1) fail('version 必须为 1');
  const r = o.road;
  if (!r || !isNum(r.laneWidth) || !isNum(r.laneCount) || !Array.isArray(r.refPoints) || r.refPoints.length < 2)
    fail('road');
  if (!r.refPoints.every((p) => isNum(p?.x) && isNum(p?.y))) fail('road.refPoints');
  if (!Array.isArray(o.obstacles)) fail('obstacles');
  const sim = { ...fallback.sim };
  for (const k of Object.keys(sim) as (keyof typeof sim)[]) {
    const v = (o.sim as unknown as Record<string, unknown> | undefined)?.[k];
    if (typeof v === typeof sim[k]) (sim as Record<string, unknown>)[k] = v;
  }
  return {
    version: 1,
    road: {
      laneWidth: r.laneWidth,
      laneCount: Math.max(1, Math.min(6, Math.round(r.laneCount))),
      refPoints: r.refPoints.map((p) => ({ x: p.x, y: p.y })),
    },
    adv: { ...checkAgent(o.adv, 'adv'), kind: 'adv' },
    obstacles: o.obstacles.map((a, i) => checkAgent(a, `obstacles[${i}]`)),
    sim,
  };
}

function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportScenario(scn: Scenario) {
  download('scenario.json', JSON.stringify(scn, null, 2), 'application/json');
}

export function exportSimLog(r: SimResult) {
  const head = 't,x,y,yaw,v,a,steer,arc,lat_err,lon_err,ref_x,ref_y,ref_yaw,ref_v,ref_a,collision';
  const rows = r.frames.map((f) => {
    const a = f.adv;
    return [f.t, a.x, a.y, a.yaw, a.v, a.a, a.steer, a.arc, a.latErr, a.lonErr, a.ref.x, a.ref.y, a.ref.yaw, a.ref.v, a.ref.a]
      .map((v) => v.toFixed(4))
      .concat(f.collisions.length ? '1' : '0')
      .join(',');
  });
  download('sim_log.csv', [head, ...rows].join('\n'), 'text/csv');
}

export function pickFile(accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('未选择文件'));
      if (f.size > 20 * 1024 * 1024) return reject(new Error('文件过大'));
      f.text().then(resolve, reject);
    };
    input.click();
  });
}
