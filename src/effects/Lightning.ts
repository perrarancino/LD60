import { Container, Graphics } from 'pixi.js';
import type { Level } from '../world/Level.ts';
import type { Hittable } from '../entities/Hittable.ts';
import { pal } from '../core/Palette.ts';

/** Точка молнии: w — «толщина» в этой точке (0..1): 1 — жила с каймой, меньше — тоньше, у острия — тонкая жила в один пиксель. */
interface Pt {
  x: number;
  y: number;
  w?: number;
}

const OUTER = pal('gold', 4);
const MID = pal('gold', 6);
const CORE = pal('gold', 7);
const SPARK_COLORS = [pal('gold', 5), pal('gold', 6), pal('gold', 7)];
export const LIGHTNING_SPARKS = SPARK_COLORS;

/**
 * Рисует молнии пикселями арта: жила в 1 пиксель (светлое золото), вокруг жилы редкая кайма в шахматном порядке — молния получается острой и тонкой, а не толстой
 * линией; кайма и свечение только там, где w велико (у острия и на ответвлениях — одна жила). Пиксели дедуплицируются и склеиваются в горизонтальные полоски.
 */
export function drawBolts(g: Graphics, lines: Pt[][]): void {
  const grid = new Map<number, number>();
  const put = (x: number, y: number, level: number) => {
    const k = (x + 8192) * 16384 + (y + 8192);
    if ((grid.get(k) ?? 0) < level) grid.set(k, level);
  };
  for (const pts of lines) {
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
        put(x0, y0, 3);
        if (w > 0.55) {
          // кайма: соседи по сторонам через один (шахматка) — тонкая «колючая» оболочка
          if ((x0 + y0) % 2 === 0) { put(x0 + 1, y0, 2); put(x0 - 1, y0, 2); }
          else { put(x0, y0 + 1, 2); put(x0, y0 - 1, 2); }
          if (w > 0.9 && (x0 * 3 + y0) % 5 === 0) { put(x0 + 1, y0 + 1, 1); put(x0 - 1, y0 - 1, 1); }
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
  }
  const rows: Map<number, number[]>[] = [new Map(), new Map(), new Map(), new Map()];
  grid.forEach((level, k) => {
    const x = Math.floor(k / 16384) - 8192;
    const y = (k % 16384) - 8192;
    const m = rows[level];
    const a = m.get(y);
    if (a) a.push(x); else m.set(y, [x]);
  });
  const colors = [0, OUTER, MID, CORE];
  for (let level = 1; level <= 3; level++) {
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

interface SharpOpts {
  amp?: number; // поперечный размах зигзага, px
  step?: [number, number]; // расстояние между изломами, px
  tipEnd?: boolean; // острие на конце: толщина падает к нулю
  tipStart?: boolean; // острие в начале
}

/**
 * Острая молния от a к b: резкие изломы через 8–16 px, знак поперечного сдвига в основном чередуется (зигзаг), иногда повторяется — «ступенька», у концов размах
 * затихает. Между изломами — прямые отрезки, поэтому углы острые, а не волнистые.
 */
export function sharpPath(a: Pt, b: Pt, o: SharpOpts = {}): Pt[] {
  const amp = o.amp ?? 6;
  const [s0, s1] = o.step ?? [8, 16];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / Math.max(1e-6, len);
  const uy = dy / Math.max(1e-6, len);
  const nx = -uy;
  const ny = ux;
  const taper = (t: number) => Math.min(o.tipStart ? Math.min(1, t * 5) : 1, o.tipEnd ? Math.min(1, (1 - t) * 3.2) : 1);
  const out: Pt[] = [{ x: a.x, y: a.y, w: o.tipStart ? 0.05 : 1 }];
  let pos = 0;
  let sign = Math.random() < 0.5 ? 1 : -1;
  for (;;) {
    pos += s0 + Math.random() * (s1 - s0);
    if (pos >= len - 4) break;
    const t = pos / len;
    if (Math.random() > 0.22) sign = -sign;
    const env = Math.min(1, Math.sin(Math.PI * t) * 1.6) ** 0.7;
    const off = sign * amp * (0.45 + 0.55 * Math.random()) * env;
    out.push({ x: a.x + ux * pos + nx * off, y: a.y + uy * pos + ny * off, w: taper(t) });
  }
  out.push({ x: b.x, y: b.y, w: o.tipEnd ? 0.05 : 1 });
  return out;
}

/** Острое ответвление от точки p в сторону ang: 2–3 излома, тонкое (одна жила). */
function branch(p: Pt, ang: number, len: number): Pt[] {
  const out: Pt[] = [{ x: p.x, y: p.y, w: 0.4 }];
  let x = p.x;
  let y = p.y;
  let a = ang;
  const n = 2 + (Math.random() < 0.4 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    a += (Math.random() - 0.5) * 1.2;
    const l = (len / n) * (0.7 + Math.random() * 0.6);
    x += Math.cos(a) * l;
    y += Math.sin(a) * l;
    out.push({ x, y, w: 0.3 * (1 - i / n) });
  }
  return out;
}

/** Звёздочка из острых лучей (вспышка в точке): n лучей случайной длины, тонкая жила. */
function star(x: number, y: number, n: number, r: number): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const l = r * (0.5 + Math.random() * 0.8);
    out.push([{ x, y, w: 0.8 }, { x: x + Math.cos(a) * l, y: y + Math.sin(a) * l, w: 0.05 }]);
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
function nearestOnSegment(px: number, py: number, a: Pt, b: Pt): { d: number; x: number; y: number } {
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
const JITTER_HZ = 30; // как часто пересчитывается рваная форма луча
const MAX_PATH_SEGMENTS = 5;

/**
 * Луч молнии из руки (ПКМ при броне на руках): идёт от кисти по прицелу, отражается от стен под нужным углом (как лазер: угол падения = углу отражения),
 * бьёт по всем врагам на пути. Форма — острая зигзагообразная молния (sharpPath): изломы пересчитываются ~30 раз в секунду, от жилы отходят острые
 * ответвления, в кисти, точках отражения и попаданий вспыхивают звёздочки, острие на конце тонкое; луч нестабилен — звено иногда гаснет на миг.
 * Тратит энергию (за это отвечает игра).
 */
export class LightningBeam {
  public readonly container = new Container();
  private readonly g = new Graphics();
  private path: Pt[] = [];
  private lines: Pt[][] = [];
  private jitterT = 0;
  private tick = 0;
  private active = false;

  constructor(private readonly onDamage: DamageFn, private readonly burst: BurstFn) {
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
    if (!origin) {
      this.active = false;
      this.tick = 0;
      return;
    }
    this.active = true;

    // путь луча с отражениями
    let x = origin.x;
    let y = origin.y;
    let dx = origin.dirX;
    let dy = origin.dirY;
    let left = p.length;
    const path: Pt[] = [{ x, y }];
    const hits: Pt[] = [];
    for (let b = 0; b <= p.bounces && left > 1 && path.length < MAX_PATH_SEGMENTS + 1; b++) {
      const r = castRay(level, x, y, dx, dy, left);
      path.push({ x: r.x, y: r.y });
      left -= r.dist;
      if (!r.hit || r.axis === null) break;
      hits.push({ x: r.x, y: r.y });
      if (r.axis === 'x') dx = -dx; else dy = -dy;
      x = r.x + dx * 0.05;
      y = r.y + dy * 0.05;
    }
    this.path = path;

    // острая форма: пересчитывается с частотой потрескивания; звено иногда гаснет на миг
    this.jitterT -= dt;
    if (this.jitterT <= 0) {
      this.jitterT = 1 / JITTER_HZ;
      this.lines = [];
      const last = path.length - 2;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const z = path[i + 1];
        const len = Math.hypot(z.x - a.x, z.y - a.y);
        if (len < 2) continue;
        const open = i === last && !hits.some((h) => h.x === z.x && h.y === z.y); // конец луча без стены — острие
        const seg = sharpPath(a, z, { amp: 5 + Math.random() * 3, tipEnd: open || i === last, tipStart: false });
        if (Math.random() < 0.05) continue;
        this.lines.push(seg);
        const ang = Math.atan2(z.y - a.y, z.x - a.x);
        for (let k = 1; k < seg.length - 1; k++) {
          if (Math.random() < 0.2) this.lines.push(branch(seg[k], ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.8), 8 + Math.random() * 10));
        }
      }
      for (const h of hits) this.lines.push(...star(h.x, h.y, 4, 7));
      this.lines.push(...star(origin.x, origin.y, 3, 6));
    }
    if (this.lines.length) drawBolts(this.g, this.lines);

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
          this.lines.push(...star(found.x, found.y, 4, 8)); // вспышка в точке попадания держится до пересчёта формы
          break;
        }
      }
    }
  }

  /** Конечные точки пути (для отладки и звука). */
  public get points(): readonly Pt[] {
    return this.path;
  }

  public clear(): void {
    this.g.clear();
    this.active = false;
  }
}

interface Bolt {
  a: Pt;
  b: Pt;
  lines: Pt[][];
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
 * Вспышки молнии: цепные острые разряды от точки удара к ближайшим врагам (форма переиначивается ~25 раз в секунду) и яркая вспышка-звезда в точке удара.
 * Используется каждым третьим ударом героя с бронёй на руках.
 */
export class LightningFx {
  public readonly container = new Container();
  private readonly g = new Graphics();
  private bolts: Bolt[] = [];
  private flashes: Flash[] = [];

  constructor() {
    this.container.addChild(this.g);
  }

  private shape(a: Pt, b: Pt): Pt[][] {
    const main = sharpPath(a, b, { amp: 8, step: [7, 13], tipEnd: true });
    const out: Pt[][] = [main];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    for (let k = 1; k < main.length - 1; k++) {
      if (Math.random() < 0.25) out.push(branch(main[k], ang + (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.8), 7 + Math.random() * 9));
    }
    return out;
  }

  /** Разряд от a к b. */
  public bolt(a: Pt, b: Pt, life = 0.18): void {
    this.bolts.push({ a, b, lines: this.shape(a, b), life, maxLife: life, t: 0 });
  }

  /** Вспышка в точке: яркое ядро и звезда из острых лучей. */
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
    const lines: Pt[][] = [];
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.t += dt;
      if (b.life <= 0) { this.bolts.splice(i, 1); continue; }
      if (b.t > 0.04) {
        b.t = 0;
        b.lines = this.shape(b.a, b.b);
      }
      lines.push(...b.lines);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) { this.flashes.splice(i, 1); continue; }
      const k = 1 - f.life / f.maxLife;
      g.circle(f.x, f.y, f.r * (0.18 + 0.22 * k)).fill({ color: CORE, alpha: 0.95 * (1 - k) }); // яркое ядро вспышки
    }
    if (lines.length) drawBolts(g, lines);
  }

  public clear(): void {
    this.bolts = [];
    this.flashes = [];
    this.g.clear();
  }
}
