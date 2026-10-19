import { Container, Graphics } from 'pixi.js';
import type { Level } from '../world/Level.ts';
import type { Hittable } from '../entities/Hittable.ts';
import { pal } from '../core/Palette.ts';

/** Точка молнии: w — «толщина» в этой точке (0..1): 1 — жила с каймой, меньше — тоньше, у острия и на веточках — одна тонкая жила. */
export interface BoltPt {
  x: number;
  y: number;
  w?: number;
}

/** Источник света, который молния отдаёт освещению мира (Lighting.dynamicLights): положение в мире, радиус, сила и цвет (rgb 0..1). */
export interface DynLight {
  x: number;
  y: number;
  r: number;
  i: number;
  c: [number, number, number];
}

/**
 * Единый стиль молнии (цвета палитры проекта): жила, кайма, свечение, затухающий след прошлого кадра, искры и цвет света. Все молнии игры рисуются одним кодом
 * (drawBolts + fractalBolt) и светят одним способом (DynLight): луч и вспышка героя — GOLD, хвост электрокрысы — BLUE.
 */
export interface LightningStyle {
  core: number;
  mid: number;
  outer: number;
  ghost: number;
  sparks: number[];
  light: [number, number, number];
}

const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

export const GOLD: LightningStyle = {
  core: pal('gold', 7), mid: pal('gold', 6), outer: pal('gold', 4), ghost: pal('gold', 3),
  sparks: [pal('gold', 5), pal('gold', 6), pal('gold', 7)], light: rgb(pal('gold', 6))
};
export const BLUE: LightningStyle = {
  core: pal('cobalt', 7), mid: pal('cobalt', 5), outer: pal('cobalt', 3), ghost: pal('cobalt', 2),
  sparks: [pal('cobalt', 6), pal('cobalt', 7), pal('electric', 7)], light: rgb(pal('electric', 6))
};
export const LIGHTNING_SPARKS = GOLD.sparks;

/**
 * Рисует молнии пикселями арта: жила в 1 пиксель, вокруг — кайма «шахматкой» (там, где w велико), на самой толстой части — редкое внешнее свечение.
 * ghost — линии прошлого кадра: рисуются тёмным золотом под новыми, как остаточное свечение (молния «горит» в глазах). Пиксели дедуплицируются
 * (приоритет: жила > кайма > свечение > след) и склеиваются в горизонтальные полоски — мало прямоугольников на кадр.
 */
export function drawBolts(g: Graphics, lines: BoltPt[][], style: LightningStyle = GOLD, ghost: BoltPt[][] = []): void {
  const grid = new Map<number, number>();
  const put = (x: number, y: number, level: number) => {
    const k = (x + 8192) * 16384 + (y + 8192);
    if ((grid.get(k) ?? 0) < level) grid.set(k, level);
  };
  const raster = (set: BoltPt[][], coreLevel: number, halo: boolean) => {
    for (const pts of set) {
      for (let i = 0; i < pts.length - 1; i++) {
        let x0 = Math.round(pts[i].x);
        let y0 = Math.round(pts[i].y);
        const x1 = Math.round(pts[i + 1].x);
        const y1 = Math.round(pts[i + 1].y);
        const w0 = pts[i].w ?? 1;
        const w1 = pts[i + 1].w ?? 1;
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        const steps = Math.max(dx, -dy) + 1;
        let err = dx + dy;
        for (let s = 0; ; s++) {
          const w = w0 + (w1 - w0) * (s / Math.max(1, steps - 1));
          put(x0, y0, coreLevel);
          if (halo && w > 0.55) {
            if ((x0 + y0) % 2 === 0) { put(x0 + 1, y0, 3); put(x0 - 1, y0, 3); } else { put(x0, y0 + 1, 3); put(x0, y0 - 1, 3); }
            if (w > 0.9 && (x0 * 3 + y0) % 5 === 0) { put(x0 + 1, y0 + 1, 2); put(x0 - 1, y0 - 1, 2); }
          }
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      }
    }
  };
  raster(ghost, 1, false); // уровень 1: след
  raster(lines, 4, true); // уровни: 2 свечение, 3 кайма, 4 жила
  const rows: Map<number, number[]>[] = [new Map(), new Map(), new Map(), new Map(), new Map()];
  grid.forEach((level, k) => {
    const x = Math.floor(k / 16384) - 8192;
    const y = (k % 16384) - 8192;
    const m = rows[level];
    const a = m.get(y);
    if (a) a.push(x); else m.set(y, [x]);
  });
  const colors = [0, style.ghost, style.outer, style.mid, style.core];
  for (let level = 1; level <= 4; level++) {
    let any = false;
    rows[level].forEach((xs, y) => {
      xs.sort((a, b) => a - b);
      let start = xs[0];
      let prev = xs[0];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] === prev + 1) { prev = xs[i]; continue; }
        g.rect(start, y, prev - start + 1, 1);
        any = true;
        if (i < xs.length) { start = prev = xs[i]; }
      }
    });
    if (any) g.fill(colors[level]);
  }
}

interface BoltOpts {
  rough?: number; // доля длины, на которую первый излом отклоняется (0.06–0.14)
  maxOff?: number; // потолок первого отклонения, px (длинный луч не должен «ходить» на десятки пикселей)
  depth?: number; // сколько раз делится пополам (5 — звенья ~8 px на 300 px)
  decay?: number; // как падает размах на каждом делении (0.5–0.6)
  tipEnd?: boolean; // острие на конце: толщина падает к нулю
  branches?: number; // вероятность ветки на узел основной жилы
  branchLen?: [number, number];
  wander?: number; // медленный изгиб всей жилы дугой, px (дыхание молнии)
  phase?: number; // фаза этого изгиба
}

/**
 * Единый генератор молнии: настоящая фрактальная жила (смещение середины, размах убывает вдвое-втрое на каждом делении — крупные дуги и мелкая «шерсть»),
 * сверху — плавный изгиб дугой, потому что молния никогда не идёт по линейке. От жилы отходят ветки (вперёд под 25–55°), у веток свои веточки;
 * толщина по длине меняется, на конце — острие. Возвращает ломаные: первая — жила, остальные — ветки.
 */
export function fractalBolt(a: BoltPt, b: BoltPt, o: BoltOpts = {}): BoltPt[][] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 3) return [[{ x: a.x, y: a.y, w: 1 }, { x: b.x, y: b.y, w: 0.3 }]];
  const nx = -dy / len;
  const ny = dx / len;
  const depth = o.depth ?? 5;
  const decay = o.decay ?? 0.55;
  let amp = Math.min(len * (o.rough ?? 0.09), o.maxOff ?? 16);
  let pts: { x: number; y: number }[] = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  for (let d = 0; d < depth; d++) {
    const next: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const off = (Math.random() * 2 - 1) * amp;
      next.push(p, { x: (p.x + q.x) / 2 + nx * off, y: (p.y + q.y) / 2 + ny * off });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    amp *= decay;
  }
  // плавный изгиб дугой: нулевой на концах (концы — точки отражений и попаданий)
  const wander = o.wander ?? 0;
  const ph = o.phase ?? 0;
  const trunk: BoltPt[] = pts.map((p, i) => {
    const t = i / (pts.length - 1);
    const bow = wander * Math.sin(Math.PI * t) * Math.sin(ph + t * 3.1);
    const wMid = 0.78 + 0.22 * Math.random();
    const taper = o.tipEnd ? Math.min(1, (1 - t) * 3.4) : 1;
    return { x: p.x + nx * bow, y: p.y + ny * bow, w: Math.max(0.05, Math.min(1, wMid * taper)) };
  });
  const out: BoltPt[][] = [trunk];
  const pBranch = o.branches ?? 0.14;
  const [bl0, bl1] = o.branchLen ?? [10, 28];
  const ang = Math.atan2(dy, dx);
  const grow = (from: BoltPt, dir: number, length: number, depthLeft: number, w: number) => {
    const end = { x: from.x + Math.cos(dir) * length, y: from.y + Math.sin(dir) * length };
    const br = fractalBolt({ x: from.x, y: from.y }, end, { rough: 0.16, maxOff: 6, depth: 3, decay: 0.55, tipEnd: true, branches: 0 })[0];
    br.forEach((p, i) => { p.w = Math.min(w, (p.w ?? 1)) * (1 - 0.5 * (i / br.length)); });
    out.push(br);
    if (depthLeft > 0) {
      for (let k = 1; k < br.length - 1; k++) {
        if (Math.random() < 0.12) grow(br[k], dir + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7), length * (0.4 + Math.random() * 0.3), depthLeft - 1, w * 0.7);
      }
    }
  };
  for (let k = 2; k < trunk.length - 3; k++) {
    if (Math.random() < pBranch) {
      grow(trunk[k], ang + (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.55), bl0 + Math.random() * (bl1 - bl0), 1, 0.5);
    }
  }
  return out;
}

/** Звёздочка из острых лучей (вспышка в точке): n лучей случайной длины, тонкая жила. */
function star(x: number, y: number, n: number, r: number): BoltPt[][] {
  const out: BoltPt[][] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const l = r * (0.5 + Math.random() * 0.8);
    out.push(fractalBolt({ x, y, w: 0.8 }, { x: x + Math.cos(a) * l, y: y + Math.sin(a) * l }, { rough: 0.2, maxOff: 4, depth: 2, tipEnd: true, branches: 0 })[0]);
  }
  return out;
}

export interface RayResult {
  x: number;
  y: number;
  dist: number;
  hit: boolean;
  /** Ось, по которой луч вошёл в тайл: 'x' — вертикальная стена (разворачиваем dx), 'y' — горизонтальная (dy). */
  axis: 'x' | 'y' | null;
}

/** Луч по сетке тайлов (Amanatides–Woo): первая твёрдая клетка на пути до maxLen. */
export function castRay(level: Level, x: number, y: number, dx: number, dy: number, maxLen: number): RayResult {
  const ts = level.tileSize;
  let cx = Math.floor(x / ts);
  let cy = Math.floor(y / ts);
  if (level.isSolid(cx, cy)) return { x, y, dist: 0, hit: true, axis: null };
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(ts / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(ts / dy);
  let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? (cx + 1) * ts - x : x - cx * ts)) / Math.abs(dx);
  let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? (cy + 1) * ts - y : y - cy * ts)) / Math.abs(dy);
  for (let guard = 0; guard < 400; guard++) {
    let axis: 'x' | 'y';
    let t: number;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; axis = 'x'; } else { t = tMaxY; tMaxY += tDeltaY; cy += stepY; axis = 'y'; }
    if (t > maxLen) break;
    if (level.isSolid(cx, cy)) return { x: x + dx * t, y: y + dy * t, dist: t, hit: true, axis };
  }
  return { x: x + dx * maxLen, y: y + dy * maxLen, dist: maxLen, hit: false, axis: null };
}

/** Расстояние от точки до отрезка и положение ближайшей точки. */
function nearestOnSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): { d: number; x: number; y: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / l2)) : 0;
  const x = a.x + abx * t;
  const y = a.y + aby * t;
  return { d: Math.hypot(px - x, py - y), x, y };
}

export interface BeamParams {
  dps: number; // урон в секунду
  length: number; // полная длина луча (сумма отрезков), px
  bounces: number; // сколько раз луч отражается от стен
}

type DamageFn = (target: Hittable, x: number, y: number, dirX: number, part?: number, customDmg?: number) => void;
type BurstFn = (x: number, y: number, count: number) => void;

const TICK = 0.22; // с: как часто луч наносит урон
const JITTER_HZ = 26; // как часто молния «перерисовывается»
const MAX_PATH_SEGMENTS = 5;
const LIGHT_STEP = 44; // px: свет от луча — по точке на каждые столько пикселей пути

/**
 * Луч молнии из руки (ПКМ при броне на руках): идёт от кисти по прицелу, отражается от стен под нужным углом (угол падения = углу отражения), бьёт всех на пути.
 * Рисуется единой молнией игры (fractalBolt + drawBolts, стиль GOLD): живая фрактальная жила с плавным изгибом, ветки и веточки, острие на конце, звёздочки в кисти и
 * на отражениях, остаточный след прошлого кадра, мерцание яркости. Луч светит: вдоль пути стоят источники света (lights) — освещают тайлы, героя и воздух жёлтым.
 */
export class LightningBeam {
  public readonly container = new Container();
  private readonly g = new Graphics();
  private path: { x: number; y: number }[] = [];
  private lines: BoltPt[][] = [];
  private ghost: BoltPt[][] = [];
  private jitterT = 0;
  private tick = 0;
  private active = false;
  private flicker = 1;
  private time = 0;
  /** Источники света луча (мир) — отдаются освещению: Lighting.dynamicLights. */
  public lights: DynLight[] = [];

  constructor(private readonly onDamage: DamageFn, private readonly burst: BurstFn, private readonly style: LightningStyle = GOLD) {
    this.container.addChild(this.g);
  }

  /** Луч сейчас идёт. */
  public get on(): boolean {
    return this.active;
  }

  /** Раз в кадр: origin — кисть (null — луча нет), dir — единичное направление к курсору. */
  public update(
    dt: number, origin: { x: number; y: number; dirX: number; dirY: number } | null, level: Level, hittables: Iterable<Hittable>, p: BeamParams
  ): void {
    this.g.clear();
    this.lights = [];
    this.time += dt;
    if (!origin) {
      this.active = false;
      this.tick = 0;
      this.lines = [];
      this.ghost = [];
      return;
    }
    this.active = true;

    // путь луча с отражениями
    let x = origin.x;
    let y = origin.y;
    let dx = origin.dirX;
    let dy = origin.dirY;
    let left = p.length;
    const path: { x: number; y: number }[] = [{ x, y }];
    const hits: { x: number; y: number }[] = [];
    let openEnd = true;
    for (let b = 0; b <= p.bounces && left > 1 && path.length < MAX_PATH_SEGMENTS + 1; b++) {
      const r = castRay(level, x, y, dx, dy, left);
      path.push({ x: r.x, y: r.y });
      left -= r.dist;
      if (!r.hit || r.axis === null) break;
      hits.push({ x: r.x, y: r.y });
      openEnd = false;
      if (r.axis === 'x') dx = -dx; else dy = -dy;
      x = r.x + dx * 0.05;
      y = r.y + dy * 0.05;
    }
    if (left > 1 && hits.length > p.bounces) openEnd = true;
    this.path = path;

    // перерисовка молнии: новая форма, прошлая остаётся тусклым следом; яркость мерцает
    this.jitterT -= dt;
    if (this.jitterT <= 0) {
      this.jitterT = (1 / JITTER_HZ) * (0.7 + Math.random() * 0.6);
      this.ghost = this.lines;
      this.lines = [];
      this.flicker = Math.random() < 0.85 ? 1 : 0.55;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const z = path[i + 1];
        if (Math.hypot(z.x - a.x, z.y - a.y) < 2) continue;
        const lastSeg = i === path.length - 2;
        const segs = fractalBolt(
          { x: a.x, y: a.y, w: 1 }, { x: z.x, y: z.y },
          { rough: 0.085, maxOff: 15, depth: 5, tipEnd: lastSeg && openEnd, wander: 7 * Math.sin(this.time * 2.3 + i * 1.7), phase: this.time * 3 + i, branches: 0.15 }
        );
        if (this.flicker < 1) for (const s of segs) for (const q of s) q.w = (q.w ?? 1) * this.flicker;
        this.lines.push(...segs);
      }
      for (const h of hits) this.lines.push(...star(h.x, h.y, 5, 9));
      this.lines.push(...star(origin.x, origin.y, 4, 8));
    }
    if (this.lines.length) drawBolts(this.g, this.lines, this.style, this.ghost);

    // свет: по источнику на каждые LIGHT_STEP px пути, сильнее у кисти и на отражениях; мерцает вместе с молнией
    const fl = 0.8 + 0.4 * Math.random();
    for (let i = 0; i < path.length - 1 && this.lights.length < 7; i++) {
      const a = path[i];
      const z = path[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(z.x - a.x, z.y - a.y) / LIGHT_STEP));
      for (let k = 0; k < n && this.lights.length < 7; k++) {
        const t = (k + 0.5) / n;
        this.lights.push({ x: a.x + (z.x - a.x) * t, y: a.y + (z.y - a.y) * t, r: 92, i: 1.15 * fl * this.flicker, c: this.style.light });
      }
    }
    for (const h of hits) if (this.lights.length < 8) this.lights.push({ x: h.x, y: h.y, r: 110, i: 1.9 * fl, c: this.style.light });

    // искры в точках отражения и у кисти
    for (const h of hits) if (Math.random() < 0.5) this.burst(h.x, h.y, 2);
    if (Math.random() < 0.35) this.burst(origin.x, origin.y, 1);

    // урон: по тикам, один раз на цель за тик
    this.tick -= dt;
    if (this.tick <= 0) {
      this.tick = TICK;
      const dmg = Math.max(1, Math.round(p.dps * TICK));
      const done = new Set<Hittable>();
      for (const h of [...hittables]) {
        if (done.has(h)) continue;
        for (const c of h.hitCircles()) {
          let found: { x: number; y: number; ix: number } | null = null;
          for (let i = 0; i < path.length - 1; i++) {
            const n = nearestOnSegment(c.x, c.y, path[i], path[i + 1]);
            if (n.d <= c.r + 3) { found = { x: n.x, y: n.y, ix: i }; break; }
          }
          if (!found) continue;
          done.add(h);
          const sx = path[found.ix + 1].x - path[found.ix].x;
          const sy = path[found.ix + 1].y - path[found.ix].y;
          const sl = Math.max(1, Math.hypot(sx, sy));
          h.onHit(sx / sl, sy / sl, c.part);
          this.onDamage(h, found.x, found.y, Math.sign(sx) || 1, c.part, dmg);
          this.burst(found.x, found.y, 3);
          this.lines.push(...star(found.x, found.y, 4, 9)); // вспышка в точке попадания держится до перерисовки
          break;
        }
      }
    }
  }

  /** Конечные точки пути (для отладки и звука). */
  public get points(): readonly { x: number; y: number }[] {
    return this.path;
  }

  public clear(): void {
    this.g.clear();
    this.active = false;
    this.lights = [];
  }
}

interface Bolt {
  a: BoltPt;
  b: BoltPt;
  lines: BoltPt[][];
  ghost: BoltPt[][];
  life: number;
  maxLife: number;
  t: number;
}

interface Flash {
  x: number;
  y: number;
  r: number;
  life: number;
  maxLife: number;
}

/**
 * Вспышки молнии: цепные разряды от точки удара к ближайшим врагам (форма переиначивается ~25 раз в секунду, прошлая остаётся следом) и яркая вспышка-звезда
 * в точке удара. Тот же единый вид молнии и свет: на время вспышки источник света в точке удара (lights). Используется каждым третьим ударом героя с бронёй на руках.
 */
export class LightningFx {
  public readonly container = new Container();
  private readonly g = new Graphics();
  private bolts: Bolt[] = [];
  private flashes: Flash[] = [];
  public lights: DynLight[] = [];

  constructor(private readonly style: LightningStyle = GOLD) {
    this.container.addChild(this.g);
  }

  private shape(a: BoltPt, b: BoltPt): BoltPt[][] {
    return fractalBolt(a, b, { rough: 0.12, maxOff: 14, depth: 4, branches: 0.2, branchLen: [8, 18], tipEnd: true });
  }

  /** Разряд от a к b. */
  public bolt(a: BoltPt, b: BoltPt, life = 0.18): void {
    this.bolts.push({ a, b, lines: this.shape(a, b), ghost: [], life, maxLife: life, t: 0 });
  }

  /** Вспышка в точке: яркое ядро, звезда из разрядов и свет. */
  public flash(x: number, y: number, r = 26, life = 0.2): void {
    this.flashes.push({ x, y, r, life, maxLife: life });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.6;
      const l = r * (0.8 + Math.random() * 0.9);
      this.bolt({ x, y }, { x: x + Math.cos(a) * l, y: y + Math.sin(a) * l }, life);
    }
  }

  public update(dt: number): void {
    const g = this.g;
    g.clear();
    this.lights = [];
    const lines: BoltPt[][] = [];
    const ghost: BoltPt[][] = [];
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.t += dt;
      if (b.life <= 0) { this.bolts.splice(i, 1); continue; }
      if (b.t > 0.04) {
        b.t = 0;
        b.ghost = b.lines;
        b.lines = this.shape(b.a, b.b);
      }
      lines.push(...b.lines);
      ghost.push(...b.ghost);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) { this.flashes.splice(i, 1); continue; }
      const k = 1 - f.life / f.maxLife;
      g.circle(f.x, f.y, f.r * (0.18 + 0.22 * k)).fill({ color: this.style.core, alpha: 0.95 * (1 - k) }); // яркое ядро вспышки
      if (this.lights.length < 3) this.lights.push({ x: f.x, y: f.y, r: f.r * 4.2, i: 2.1 * (1 - k * 0.7), c: this.style.light });
    }
    if (lines.length) drawBolts(g, lines, this.style, ghost);
  }

  public clear(): void {
    this.bolts = [];
    this.flashes = [];
    this.lights = [];
    this.g.clear();
  }
}
