import { clamp } from '../core/math';
import type { STKnot } from '../core/types';
import type { OccupancyCell } from '../sim/stOccupancy';

export interface Series {
  t: number[];
  s: number[];
  v: number[];
  a: number[];
}

export interface StEditorData {
  title: string;
  knots: STKnot[]; // mutable, sorted by t
  pathLength: number;
  duration: number;
  occupancy: OccupancyCell[];
  obstacleNames: string[];
  ref: Series;
  actual: Series | null;
  maxAccel: number;
  maxDecel: number;
}

export interface StEditorHost {
  changed(live: boolean): void;
  seek(t: number): void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_DT = 0.2;
const OBS_COLORS = ['#e76f51', '#9b5de5', '#f15bb5', '#00bbf9', '#00f5d4', '#fee440'];
const C = {
  bg: '#20232a',
  panel: '#262a33',
  grid: '#343946',
  axis: '#8a92a6',
  text: '#c9cfdc',
  ref: '#ffb703',
  actual: '#4cc9f0',
  knot: '#ffffff',
  knotActive: '#e76f51',
  cursor: '#ff4d6d',
  limit: '#e63946',
};

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

/** Canvas s-t editor (left) with v-t and a-t monitors (right). */
export class StEditor {
  private readonly ctx: CanvasRenderingContext2D;
  private data: StEditorData | null = null;
  private time = 0;
  private dragIndex = -1;
  private hoverIndex = -1;
  private frozen: { tMax: number; sMax: number } | null = null;
  private stRect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private vRect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private aRect: Rect = { x: 0, y: 0, w: 1, h: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: StEditorHost,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('dblclick', this.onDbl);
    canvas.addEventListener('contextmenu', this.onContext);
  }

  setData(d: StEditorData) {
    this.data = d;
  }

  setTime(t: number) {
    this.time = t;
  }

  // ---------------- Ranges / mapping ----------------

  private ranges() {
    if (this.frozen) return this.frozen;
    const d = this.data!;
    const last = d.knots[d.knots.length - 1];
    const tMax = Math.max(d.duration, (last?.t ?? 0) + 2, 8);
    const sMax = Math.max(d.pathLength, ...d.knots.map((k) => k.s), 10) * 1.05;
    return { tMax, sMax };
  }

  private X(r: Rect, t: number, tMax: number) {
    return r.x + (t / tMax) * r.w;
  }

  private invX(r: Rect, px: number, tMax: number) {
    return ((px - r.x) / r.w) * tMax;
  }

  private Y(r: Rect, v: number, lo: number, hi: number) {
    return r.y + r.h - ((v - lo) / (hi - lo)) * r.h;
  }

  private invY(r: Rect, py: number, lo: number, hi: number) {
    return lo + ((r.y + r.h - py) / r.h) * (hi - lo);
  }

  private local(e: MouseEvent) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private inside(r: Rect, p: { x: number; y: number }) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  private hitKnot(p: { x: number; y: number }): number {
    if (!this.data) return -1;
    const { tMax, sMax } = this.ranges();
    let best = -1;
    let bestD = 9 * 9;
    this.data.knots.forEach((k, i) => {
      const dx = this.X(this.stRect, k.t, tMax) - p.x;
      const dy = this.Y(this.stRect, k.s, 0, sMax) - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  // ---------------- Interaction ----------------

  private onDown = (e: PointerEvent) => {
    if (!this.data || e.button !== 0) return;
    const p = this.local(e);
    const i = this.hitKnot(p);
    if (i >= 0) {
      this.dragIndex = i;
      this.frozen = { ...this.ranges() };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const { tMax } = this.ranges();
    for (const r of [this.stRect, this.vRect, this.aRect]) {
      if (this.inside(r, p)) {
        this.host.seek(clamp(this.invX(r, p.x, tMax), 0, tMax));
        return;
      }
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.data) return;
    const p = this.local(e);
    if (this.dragIndex < 0) {
      this.hoverIndex = this.hitKnot(p);
      this.canvas.style.cursor = this.hoverIndex >= 0 ? 'grab' : 'default';
      return;
    }
    const { tMax, sMax } = this.frozen!;
    const ks = this.data.knots;
    const i = this.dragIndex;
    const prev = ks[i - 1];
    const next = ks[i + 1];
    const t = i === 0 ? 0 : clamp(this.invX(this.stRect, p.x, tMax), prev.t + MIN_DT, next ? next.t - MIN_DT : tMax);
    const s = clamp(this.invY(this.stRect, p.y, 0, sMax), prev ? prev.s : 0, next ? next.s : sMax);
    ks[i] = { t, s };
    this.host.changed(true);
  };

  private onUp = (e: PointerEvent) => {
    if (this.dragIndex < 0) return;
    this.canvas.releasePointerCapture(e.pointerId);
    this.dragIndex = -1;
    this.frozen = null;
    this.host.changed(false);
  };

  private onDbl = (e: MouseEvent) => {
    if (!this.data) return;
    const p = this.local(e);
    if (!this.inside(this.stRect, p) || this.hitKnot(p) >= 0) return;
    const { tMax, sMax } = this.ranges();
    const t = this.invX(this.stRect, p.x, tMax);
    const ks = this.data.knots;
    if (t <= MIN_DT || ks.some((k) => Math.abs(k.t - t) < MIN_DT)) return;
    let idx = ks.findIndex((k) => k.t > t);
    if (idx < 0) idx = ks.length;
    const lo = ks[idx - 1]?.s ?? 0;
    const hi = ks[idx]?.s ?? sMax;
    ks.splice(idx, 0, { t, s: clamp(this.invY(this.stRect, p.y, 0, sMax), lo, hi) });
    this.host.changed(false);
  };

  private onContext = (e: MouseEvent) => {
    e.preventDefault();
    if (!this.data) return;
    const i = this.hitKnot(this.local(e));
    if (i > 0) {
      this.data.knots.splice(i, 1);
      this.host.changed(false);
    }
  };

  // ---------------- Drawing ----------------

  draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    if (!this.data || W < 50 || H < 50) return;

    const split = Math.round(W * 0.58);
    this.stRect = { x: 52, y: 24, w: split - 70, h: H - 50 };
    const rh = (H - 24 - 26 * 2) / 2;
    this.vRect = { x: split + 46, y: 24, w: W - split - 60, h: rh };
    this.aRect = { x: split + 46, y: 24 + rh + 26, w: W - split - 60, h: rh };

    const d = this.data;
    const { tMax, sMax } = this.ranges();
    this.drawST(d, tMax, sMax);

    const vMax = Math.max(5, ...d.ref.v, ...(d.actual?.v ?? [])) * 1.15;
    this.drawSeries(this.vRect, 'v-t  [m/s]', tMax, 0, vMax, d.ref.t, d.ref.v, d.actual?.t, d.actual?.v, []);
    const aLo = -Math.max(d.maxDecel + 1, ...d.ref.a.map((x) => -x));
    const aHi = Math.max(d.maxAccel + 1, ...d.ref.a);
    this.drawSeries(this.aRect, 'a-t  [m/s²]', tMax, aLo, aHi, d.ref.t, d.ref.a, d.actual?.t, d.actual?.a, [d.maxAccel, -d.maxDecel]);
  }

  private frame(r: Rect, title: string, tMax: number, lo: number, hi: number) {
    const g = this.ctx;
    g.fillStyle = C.panel;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.fillStyle = C.axis;
    g.font = '11px ui-monospace, monospace';
    const ts = niceStep(tMax, 8);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let t = 0; t <= tMax + 1e-9; t += ts) {
      const x = Math.round(this.X(r, t, tMax)) + 0.5;
      g.beginPath();
      g.moveTo(x, r.y);
      g.lineTo(x, r.y + r.h);
      g.stroke();
      g.fillText(t.toFixed(ts < 1 ? 1 : 0), x, r.y + r.h + 3);
    }
    const vs = niceStep(hi - lo, r.h > 150 ? 6 : 3);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / vs) * vs; v <= hi + 1e-9; v += vs) {
      const y = Math.round(this.Y(r, v, lo, hi)) + 0.5;
      g.beginPath();
      g.moveTo(r.x, y);
      g.lineTo(r.x + r.w, y);
      g.stroke();
      g.fillText(v.toFixed(vs < 1 ? 1 : 0), r.x - 4, y);
    }
    g.fillStyle = C.text;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.font = '12px system-ui, sans-serif';
    g.fillText(title, r.x, r.y - 4);
  }

  private polyline(r: Rect, ts: number[], vs: number[], tMax: number, lo: number, hi: number, color: string, width = 2, dash: number[] = []) {
    const g = this.ctx;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    ts.forEach((t, i) => {
      const x = this.X(r, t, tMax);
      const y = this.Y(r, vs[i], lo, hi);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.restore();
  }

  private cursor(r: Rect, tMax: number) {
    const g = this.ctx;
    const x = this.X(r, Math.min(this.time, tMax), tMax);
    g.strokeStyle = C.cursor;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, r.y);
    g.lineTo(x, r.y + r.h);
    g.stroke();
  }

  private drawST(d: StEditorData, tMax: number, sMax: number) {
    const r = this.stRect;
    const g = this.ctx;
    this.frame(r, `s-t 编辑 · ${d.title}   (拖动节点 / 双击添加 / 右键删除 / 单击跳转)`, tMax, 0, sMax);

    // Obstacle occupancy
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    for (const c of d.occupancy) {
      g.fillStyle = OBS_COLORS[c.obstacle % OBS_COLORS.length] + '99';
      const x0 = this.X(r, c.t0, tMax);
      const x1 = this.X(r, c.t1, tMax);
      const y0 = this.Y(r, c.s1, 0, sMax);
      const y1 = this.Y(r, c.s0, 0, sMax);
      g.fillRect(x0, y0, x1 - x0 + 0.5, y1 - y0);
    }
    // Path end line
    const ye = this.Y(r, d.pathLength, 0, sMax);
    g.strokeStyle = C.axis;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(r.x, ye);
    g.lineTo(r.x + r.w, ye);
    g.stroke();
    g.setLineDash([]);
    g.restore();

    if (d.actual) this.polyline(r, d.actual.t, d.actual.s, tMax, 0, sMax, C.actual, 1.5, [5, 4]);
    this.polyline(r, d.ref.t, d.ref.s, tMax, 0, sMax, C.ref, 2.5);

    d.knots.forEach((k, i) => {
      const x = this.X(r, k.t, tMax);
      const y = this.Y(r, k.s, 0, sMax);
      g.beginPath();
      g.arc(x, y, i === this.dragIndex || i === this.hoverIndex ? 7 : 5, 0, Math.PI * 2);
      g.fillStyle = i === this.dragIndex ? C.knotActive : C.knot;
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.stroke();
    });
    if (this.dragIndex >= 0) {
      const k = d.knots[this.dragIndex];
      g.fillStyle = C.text;
      g.font = '11px ui-monospace, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(`t=${k.t.toFixed(2)}s  s=${k.s.toFixed(1)}m`, this.X(r, k.t, tMax) + 10, this.Y(r, k.s, 0, sMax) - 6);
    }
    this.cursor(r, tMax);

    // Legend
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    let lx = r.x + 8;
    const ly = r.y + 12;
    const item = (color: string, label: string) => {
      g.fillStyle = color;
      g.fillRect(lx, ly - 4, 12, 8);
      g.fillStyle = C.text;
      g.fillText(label, lx + 16, ly);
      lx += 22 + g.measureText(label).width;
    };
    item(C.ref, '参考 s(t)');
    if (d.actual) item(C.actual, '实际 s(t)');
    const seen = new Set(d.occupancy.map((c) => c.obstacle));
    seen.forEach((i) => item(OBS_COLORS[i % OBS_COLORS.length], d.obstacleNames[i] ?? `obs${i}`));
  }

  private drawSeries(
    r: Rect,
    title: string,
    tMax: number,
    lo: number,
    hi: number,
    rt: number[],
    rv: number[],
    at: number[] | undefined,
    av: number[] | undefined,
    limits: number[],
  ) {
    this.frame(r, title, tMax, lo, hi);
    const g = this.ctx;
    for (const l of limits) {
      const y = this.Y(r, l, lo, hi);
      g.strokeStyle = C.limit;
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(r.x, y);
      g.lineTo(r.x + r.w, y);
      g.stroke();
      g.setLineDash([]);
    }
    if (at && av) this.polyline(r, at, av, tMax, lo, hi, C.actual, 1.5);
    this.polyline(r, rt, rv, tMax, lo, hi, C.ref, 2);
    this.cursor(r, tMax);
  }
}
