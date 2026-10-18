import { Container, Sprite, Texture } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef } from '../data/types.ts';

/** Нитка паучихи (enemy_spider_thread): из её звеньев собран весь паутинный декор. */
export const THREAD_SPRITE = 'enemy_spider_thread';
const THREAD_CENTER_X = 5; // центр нитки по x в звене (как в риге паучихи)
const OVERLAP = 1.2; // px: звенья слегка нахлёстываются — на изгибе нет щелей

const SWAY_SPEED = 0.9; // рад/с
const SPAN_MIN = 36; // px: длина пролёта между двумя поверхностями (от, до)
const SPAN_MAX = 118;

// Лианы: цепочка узлов через VINE_NODE px, по два узла на звено нитки (звено рисуется в натуральную длину — не сжимается)
const VINE_NODE = 7;
const VINE_PIECE = VINE_NODE * 2; // px: шаг звеньев вдоль лианы (высота звена 16 минус нахлёст 2)
const VINE_GRAVITY = 560; // px/с²
const VINE_DAMPING = 2.6; // 1/с: затухание скорости
const VINE_WIND = 55; // px/с²: порывы ветра по уровню (на конце лианы сильнее)
const VINE_RETURN = 16; // 1/с²: пружина возврата к вертикали — лиана не «улетает» и возвращается
const VINE_MAX_SWING = 0.62; // макс. смещение узла от вертикали: доля расстояния от корня до узла (≈ 38°)
const VINE_ITERATIONS = 3;
const VINE_SUBSTEPS = 2;
const ACTOR_PAD = 2; // px: герой задевает лиану чуть раньше края хитбокса
const VIEW_MARGIN = 40; // px: за краем обзора декор не обновляется
const VINE_TINTS = [0xffffff, 0xe3f1ff, 0xcfe6ff];

/** Детерминированный генератор: раскладка паутины одинакова при каждом запуске. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Тот, кто задевает лианы: хитбокс (мир) и скорость. */
export interface Actor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  vx: number;
  vy: number;
}

interface Vec {
  x: number;
  y: number;
}

/** Звено нитки: спрайт, вытянутый вдоль отрезка. */
class Piece {
  public readonly sprite: Sprite;

  constructor(parent: Container, tex: Texture, alpha = 1, tint = 0xffffff) {
    this.sprite = new Sprite(tex);
    this.sprite.pivot.set(THREAD_CENTER_X, tex.height / 2);
    this.sprite.alpha = alpha;
    this.sprite.tint = tint;
    parent.addChild(this.sprite);
  }

  /** Растягивает звено от (ax, ay) к (bx, by); overlap — на сколько оно заходит за концы отрезка. */
  public place(ax: number, ay: number, bx: number, by: number, overlap = OVERLAP): void {
    const len = Math.hypot(bx - ax, by - ay) || 1e-6;
    this.sprite.position.set((ax + bx) / 2, (ay + by) / 2);
    this.sprite.rotation = Math.atan2(-(bx - ax), by - ay); // рисунок нитки вертикальный: «вниз» (+y) поворачиваем вдоль отрезка
    this.sprite.scale.set(1, (len + overlap) / this.sprite.texture.height);
  }
}

/**
 * Нитка между двумя закреплёнными точками: провисает (sag, в сторону hint) и слегка колышется. Точки кривой считаются
 * аналитически — дёшево. Число звеньев подобрано так, чтобы звенья были как можно ближе к нарисованной длине (не сжаты).
 */
class Strand {
  public readonly minX: number;
  public readonly maxX: number;
  private readonly pieces: Piece[] = [];
  private readonly nx: number;
  private readonly ny: number;
  private readonly dx: number;
  private readonly dy: number;

  constructor(
    parent: Container, tex: Texture, private readonly ax: number, private readonly ay: number, bx: number, by: number,
    private readonly sag: number, private readonly sway: number, private readonly phase: number, alpha: number,
    hint: Vec
  ) {
    this.dx = bx - ax;
    this.dy = by - ay;
    const len = Math.hypot(this.dx, this.dy) || 1;
    let nx = -this.dy / len;
    let ny = this.dx / len;
    if (nx * hint.x + ny * hint.y < 0) { nx = -nx; ny = -ny; } // провисание — в сторону hint
    this.nx = nx;
    this.ny = ny;
    this.minX = Math.min(ax, bx) - sag - sway - 2;
    this.maxX = Math.max(ax, bx) + sag + sway + 2;
    const h = tex.height;
    // длина с учётом провисания; число звеньев — floor или ceil, где звено ближе к нарисованной длине
    const arc = len + (8 * sag * sag) / (3 * len);
    const lo = Math.max(1, Math.floor(arc / h));
    const hi = Math.max(1, Math.ceil(arc / h));
    const n = Math.abs(Math.log(arc / lo / h)) <= Math.abs(Math.log(arc / hi / h)) ? lo : hi;
    for (let i = 0; i < n; i++) this.pieces.push(new Piece(parent, tex, alpha));
    this.update(0);
  }

  public update(t: number): void {
    const n = this.pieces.length;
    const wave = this.sway * Math.sin(t * SWAY_SPEED + this.phase);
    let px = this.ax;
    let py = this.ay;
    for (let i = 0; i < n; i++) {
      const s = (i + 1) / n;
      const off = this.sag * 4 * s * (1 - s) + wave * Math.sin(Math.PI * s);
      const qx = this.ax + this.dx * s + this.nx * off;
      const qy = this.ay + this.dy * s + this.ny * off;
      this.pieces[i].place(px, py, qx, qy);
      px = qx;
      py = qy;
    }
  }
}

/**
 * Лиана: цепочка (verlet) из паутинных звеньев, корень закреплён под тайлом. Физична: тяжесть, затухание, порывы ветра, а герой,
 * проходя сквозь неё, раздвигает звенья и раскачивает. Смещение узлов от вертикали ограничено, к тому же есть пружина возврата —
 * лиана не улетает. Звенья нитки рисуются в натуральную длину (длина лианы кратна шагу звена) — рисунок не сжимается.
 */
class Vine {
  public readonly minX: number;
  public readonly maxX: number;
  private readonly n: number; // узлов (без корня)
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pieces: Piece[] = [];
  private readonly bead: Sprite | null;

  /** pieceCount звеньев; корень (rx, ry) закреплён. */
  constructor(parent: Container, tex: Texture, private readonly rx: number, ry: number, pieceCount: number, tint: number, bead: boolean) {
    this.n = pieceCount * 2;
    const size = this.n + 1;
    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.px = new Float32Array(size);
    this.py = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.x[i] = this.px[i] = rx;
      this.y[i] = this.py[i] = ry + i * VINE_NODE;
    }
    for (let i = 0; i < pieceCount; i++) this.pieces.push(new Piece(parent, tex, i === pieceCount - 1 && pieceCount > 1 ? 0.8 : 1, tint));
    if (bead) {
      // капелька на конце
      this.bead = new Sprite(Texture.WHITE);
      this.bead.tint = 0xeaffff;
      this.bead.width = 2;
      this.bead.height = 3;
      parent.addChild(this.bead);
    } else {
      this.bead = null;
    }
    const reach = this.n * VINE_NODE;
    this.minX = rx - reach;
    this.maxX = rx + reach;
    this.render();
  }

  public update(dt: number, t: number, actors: readonly Actor[]): void {
    const h = Math.min(dt, 1 / 30) / VINE_SUBSTEPS;
    const damp = Math.exp(-VINE_DAMPING * h);
    const n = this.n;
    const rx = this.rx;
    for (let step = 0; step < VINE_SUBSTEPS; step++) {
      for (let i = 1; i <= n; i++) {
        const k = i / n; // на конце порывы сильнее
        const wind = VINE_WIND * k * (Math.sin(t * 0.9 + rx * 0.015 + i * 0.35) + 0.6 * Math.sin(t * 2.3 + rx * 0.04));
        const vx = (this.x[i] - this.px[i]) * damp;
        const vy = (this.y[i] - this.py[i]) * damp;
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        // пружина возврата к вертикали под корнем + ветер + тяжесть
        this.x[i] += vx + (wind - VINE_RETURN * (this.x[i] - rx)) * h * h;
        this.y[i] += vy + VINE_GRAVITY * h * h;
      }
      for (let it = 0; it < VINE_ITERATIONS; it++) {
        for (let i = 0; i < n; i++) {
          const dx = this.x[i + 1] - this.x[i];
          const dy = this.y[i + 1] - this.y[i];
          const dist = Math.hypot(dx, dy) || 1e-6;
          const diff = (dist - VINE_NODE) / dist;
          if (i === 0) {
            this.x[1] -= dx * diff; // корень неподвижен
            this.y[1] -= dy * diff;
          } else {
            this.x[i] += dx * diff * 0.5;
            this.y[i] += dy * diff * 0.5;
            this.x[i + 1] -= dx * diff * 0.5;
            this.y[i + 1] -= dy * diff * 0.5;
          }
        }
      }
      for (const a of actors) {
        if (a.right < this.minX || a.left > this.maxX) continue;
        const cx = (a.left + a.right) / 2;
        for (let i = 1; i <= n; i++) {
          const x = this.x[i];
          const y = this.y[i];
          if (x < a.left - ACTOR_PAD || x > a.right + ACTOR_PAD || y < a.top || y > a.bottom) continue;
          // звено внутри героя: выталкиваем в сторону, где оно было ближе (проход сквозь лиану раздвигает её)
          this.x[i] = x < cx ? a.left - ACTOR_PAD : a.right + ACTOR_PAD;
        }
      }
      // предел отклонения от вертикали: узел не может уйти далеко от корня (скорость при этом гасится)
      for (let i = 1; i <= n; i++) {
        const lim = i * VINE_NODE * VINE_MAX_SWING;
        const d = this.x[i] - rx;
        if (d > lim) { this.x[i] = rx + lim; this.px[i] = Math.min(this.px[i], this.x[i]); }
        else if (d < -lim) { this.x[i] = rx - lim; this.px[i] = Math.max(this.px[i], this.x[i]); }
      }
    }
    this.render();
  }

  private render(): void {
    for (let i = 0; i < this.pieces.length; i++) {
      const a = 2 * i;
      this.pieces[i].place(this.x[a], this.y[a], this.x[a + 2], this.y[a + 2], VINE_PIECE - VINE_NODE * 2 + 2);
    }
    if (this.bead) this.bead.position.set(this.x[this.n] - 1, this.y[this.n] + 1);
  }
}

interface Face {
  x: number; // центр грани
  y: number;
  tx: number; // касательная (единичная)
  ty: number;
  nx: number; // наружная нормаль
  ny: number;
}

const DOWN: Vec = { x: 0, y: 1 };

/**
 * Паутинный декор из нитки паучихи по зонам уровня (kind: "webs"). Всё собрано узорами, а не россыпью:
 *  - гирлянды: по ряду граней тайлов нитки идут дугами от стыка к стыку, ниже — второй и третий ярус дуг (кружево);
 *    по верхним и боковым граням они лежат поверх тайлов, по нижним — свисают;
 *  - веера на выпуклых углах тайлов: «струнный» узор из прямых нитей, лежит поверх угла тайла;
 *  - радиальные паутинки в вогнутых углах (пол/потолок и стена): спицы и кольца-хорды;
 *  - пролёты между гранями разных тайлов: несколько параллельных провисающих нитей с перекладинами;
 *  - лианы под нижними гранями: пучки физичных нитей разной длины.
 * Нитки и узоры лежат в слое поверх тайлов (front), лианы — под тайлами (back, корень спрятан в тайле). Обновляется только то, что в обзоре.
 */
export class Webs {
  public readonly front = new Container();
  public readonly back = new Container();

  private readonly strands: Strand[] = [];
  private readonly vines: Vine[] = [];
  private readonly tex: Texture;
  private time = 0;

  constructor(
    sprites: SpriteLibrary, private readonly ts: number, private readonly width: number, private readonly height: number,
    private readonly isSolid: (cx: number, cy: number) => boolean
  ) {
    this.tex = sprites.texture(THREAD_SPRITE);
  }

  private solid(cx: number, cy: number): boolean {
    return cx >= 0 && cx < this.width && cy >= 0 && cy < this.height && this.isSolid(cx, cy);
  }

  private free(cx: number, cy: number): boolean {
    return cx >= 0 && cx < this.width && cy >= 0 && cy < this.height && !this.isSolid(cx, cy);
  }

  private line(a: Vec, b: Vec, sag: number, sway: number, hint: Vec, alpha = 1, phase = 0): void {
    this.strands.push(new Strand(this.front, this.tex, a.x, a.y, b.x, b.y, sag, sway, phase, alpha, hint));
  }

  /** Раскладывает паутину зоны; index — номер зоны (для детерминированного генератора). */
  public addZone(zone: DecorZoneDef, index: number): void {
    const rand = mulberry32(index * 7919 + 4421);
    const density = zone.density ?? 0.5;
    const x0 = Math.max(0, zone.x0);
    const x1 = Math.min(this.width - 1, zone.x1);
    const y0 = Math.max(0, zone.y0);
    const y1 = Math.min(this.height - 1, zone.y1);
    const faces: Face[] = [];

    // ---- ряды граней: горизонтальные (верх/низ) и вертикальные (лево/право)
    for (let cy = y0; cy <= y1; cy++) {
      for (const side of [-1, 1] as const) { // -1: верхние грани, 1: нижние
        let cx = x0;
        while (cx <= x1) {
          const exposed = (x: number) => this.solid(x, cy) && this.free(x, cy + side);
          if (!exposed(cx)) { cx++; continue; }
          let end = cx;
          while (end + 1 <= x1 && exposed(end + 1)) end++;
          this.addHorizontalRun(cx, end, cy, side, rand, density, faces);
          cx = end + 1;
        }
      }
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (const side of [-1, 1] as const) { // -1: левые грани, 1: правые
        let cy = y0;
        while (cy <= y1) {
          const exposed = (y: number) => this.solid(cx, y) && this.free(cx + side, y);
          if (!exposed(cy)) { cy++; continue; }
          let end = cy;
          while (end + 1 <= y1 && exposed(end + 1)) end++;
          this.addVerticalRun(cx, cy, end, side, rand, density, faces);
          cy = end + 1;
        }
      }
    }

    // ---- углы
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (this.solid(cx, cy)) {
          for (const sy of [-1, 1] as const) {
            for (const sx of [-1, 1] as const) {
              if (this.free(cx, cy + sy) && this.free(cx + sx, cy) && rand() < density * 0.85) this.addConvexFan(cx, cy, sx, sy, rand);
            }
          }
        } else if (rand() < density * 0.9) {
          this.addCornerWeb(cx, cy, rand);
        }
      }
    }

    // ---- пролёты между гранями разных тайлов
    const attempts = Math.round(faces.length * density * 3);
    for (let k = 0; k < attempts; k++) {
      const fa = faces[Math.floor(rand() * faces.length)];
      const fb = faces[Math.floor(rand() * faces.length)];
      if (fa && fb && fa !== fb) this.addSpan(fa, fb, rand);
    }
  }

  /** Гирлянда: дуги от стыка к стыку вдоль (ux, uy), ниже ещё ярусы. hint — куда провисает. */
  private festoon(start: Vec, ux: number, uy: number, count: number, step: number, sag: number, hint: Vec, alpha = 1, tiers = 3): void {
    const pts: Vec[] = [];
    for (let j = 0; j <= count; j++) pts.push({ x: start.x + ux * step * j, y: start.y + uy * step * j });
    const phase = (start.x + start.y) * 0.03;
    for (let j = 0; j < count; j++) this.line(pts[j], pts[j + 1], sag, 0.9, hint, alpha, phase + j * 0.4);
    // второй ярус: между «брюшками» дуг
    const belly = (a: Vec, b: Vec, s: number): Vec => {
      let nx = -(b.y - a.y);
      let ny = b.x - a.x;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      if (nx * hint.x + ny * hint.y < 0) { nx = -nx; ny = -ny; }
      return { x: (a.x + b.x) / 2 + nx * s, y: (a.y + b.y) / 2 + ny * s };
    };
    if (count < 2 || tiers < 2) return;
    const tier2: Vec[] = [];
    for (let j = 0; j < count; j++) tier2.push(belly(pts[j], pts[j + 1], sag));
    for (let j = 0; j < count - 1; j++) this.line(tier2[j], tier2[j + 1], sag * 0.6, 0.9, hint, alpha * 0.85, phase + j * 0.4);
    if (count < 4 || tiers < 3) return;
    const tier3: Vec[] = [];
    for (let j = 0; j < count - 1; j++) tier3.push(belly(tier2[j], tier2[j + 1], sag * 0.6));
    for (let j = 0; j < count - 2; j++) this.line(tier3[j], tier3[j + 1], sag * 0.35, 0.8, hint, alpha * 0.7, phase + j * 0.4);
  }

  private addHorizontalRun(cx0: number, cx1: number, cy: number, side: -1 | 1, rand: () => number, density: number, faces: Face[]): void {
    const ts = this.ts;
    const count = cx1 - cx0 + 1;
    const y = (side === 1 ? cy + 1 : cy) * ts;
    for (let cx = cx0; cx <= cx1; cx++) faces.push({ x: (cx + 0.5) * ts, y, tx: 1, ty: 0, nx: 0, ny: side });
    const start = { x: cx0 * ts + 1, y };
    const step = (count * ts - 2) / count;
    if (side === 1) {
      // нижняя грань: либо гирлянда, либо пучки лиан (одно из двух — чтобы узор читался)
      if (rand() < 0.5) {
        if (rand() < density) this.festoon(start, 1, 0, count, step, 5 + rand() * 3, DOWN, 1);
      } else {
        for (let cx = cx0; cx <= cx1; cx++) if (rand() < Math.min(1, density * 1.3)) this.addVines(cx, cy, rand);
      }
    } else if (rand() < density) {
      // верхняя грань: гирлянда ложится на тайл (провисает вниз)
      this.festoon(start, 1, 0, count, step, 4 + rand() * 3, DOWN, 0.95);
    }
  }

  private addVerticalRun(cx: number, cy0: number, cy1: number, side: -1 | 1, rand: () => number, density: number, faces: Face[]): void {
    const ts = this.ts;
    const count = cy1 - cy0 + 1;
    const x = (side === 1 ? cx + 1 : cx) * ts;
    for (let cy = cy0; cy <= cy1; cy++) faces.push({ x, y: (cy + 0.5) * ts, tx: 0, ty: 1, nx: side, ny: 0 });
    if (rand() >= density * 0.8) return;
    // боковая грань: дуги ложатся на тайл (провисают внутрь тайла)
    this.festoon({ x, y: cy0 * ts + 1 }, 0, 1, count, (count * ts - 2) / count, 4 + rand() * 3, { x: -side, y: 0 }, 0.95, 2);
  }

  /** Веер на выпуклом углу тайла: «струнный» узор из прямых нитей, лежит поверх угла. sx, sy — куда смотрят открытые грани. */
  private addConvexFan(cx: number, cy: number, sx: -1 | 1, sy: -1 | 1, rand: () => number): void {
    const ts = this.ts;
    const corner = { x: (sx === 1 ? cx + 1 : cx) * ts, y: (sy === 1 ? cy + 1 : cy) * ts };
    const d = ts * (0.78 + rand() * 0.12);
    const N = 6;
    for (let k = 1; k < N; k++) {
      // точка на горизонтальной грани и точка на вертикальной (внутрь тайла от угла)
      const a = { x: corner.x - sx * (d * k) / N, y: corner.y };
      const b = { x: corner.x, y: corner.y - sy * (d * (N - k)) / N };
      this.line(a, b, 0, 0.5, DOWN, k === 1 || k === N - 1 ? 0.75 : 0.95, k * 0.3);
    }
  }

  /** Радиальная паутинка в вогнутом углу (пол/потолок + стена): спицы и три кольца-хорды. */
  private addCornerWeb(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    const floor = this.solid(cx, cy + 1);
    const ceil = this.solid(cx, cy - 1);
    const wallL = this.solid(cx - 1, cy);
    const wallR = this.solid(cx + 1, cy);
    if (!(floor || ceil) || !(wallL || wallR)) return;
    const sx = wallL ? 1 : -1; // от стены вдоль пола
    const sy = floor ? -1 : 1; // от пола вверх (или от потолка вниз)
    const hub = { x: wallL ? cx * ts : (cx + 1) * ts, y: floor ? (cy + 1) * ts : cy * ts };
    let R = 36 + rand() * 14;
    const spokes = 5;
    const dirs: Vec[] = [];
    for (let i = 0; i < spokes; i++) {
      const th = (Math.PI / 2) * (i / (spokes - 1));
      dirs.push({ x: sx * Math.cos(th), y: sy * Math.sin(th) });
    }
    // паутинка не должна уходить в тайлы: укорачиваем, пока спицы не станут свободны
    const inside = { x: hub.x + sx * 1.5, y: hub.y + sy * 1.5 };
    const open = (r: number) => dirs.every((d) => this.clear(inside.x, inside.y, hub.x + d.x * r, hub.y + d.y * r));
    while (R > 16 && !open(R)) R -= 6;
    if (R <= 16) return;
    for (const d of dirs) this.line(hub, { x: hub.x + d.x * R, y: hub.y + d.y * R }, 0, 0.5, DOWN, 0.95, d.x);
    for (const k of [0.36, 0.64, 0.92]) {
      for (let i = 0; i < spokes - 1; i++) {
        const a = { x: hub.x + dirs[i].x * R * k, y: hub.y + dirs[i].y * R * k };
        const b = { x: hub.x + dirs[i + 1].x * R * k, y: hub.y + dirs[i + 1].y * R * k };
        this.line(a, b, 1.2, 0.5, { x: -sx, y: -sy }, 0.85, i * 0.5 + k);
      }
    }
  }

  /** Точка на грани: u — сдвиг от центра вдоль грани, px. */
  private anchor(f: Face, u: number): Vec {
    return { x: f.x + f.tx * u, y: f.y + f.ty * u };
  }

  /** Между точками нет твёрдых клеток? */
  private clear(ax: number, ay: number, bx: number, by: number): boolean {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(len / 4);
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      if (this.isSolid(Math.floor((ax + (bx - ax) * s) / this.ts), Math.floor((ay + (by - ay) * s) / this.ts))) return false;
    }
    return true;
  }

  /** Пролёт: две точки на гранях двух тайлов связаны несколькими параллельными нитями; между ними перекладины. */
  private addSpan(fa: Face, fb: Face, rand: () => number): void {
    const half = this.ts / 2 - 4;
    const gap = 7; // расстояние между параллельными нитями
    const k = 3 + (rand() < 0.5 ? 1 : 0);
    const ua = -half + rand() * (half * 2 - gap * (k - 1));
    const ub = -half + rand() * (half * 2 - gap * (k - 1));
    const a = this.anchor(fa, ua);
    const b = this.anchor(fb, ub);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < SPAN_MIN || dist > SPAN_MAX) return;
    // грани смотрят друг на друга и между ними пусто
    if ((b.x - a.x) * fa.nx + (b.y - a.y) * fa.ny < dist * 0.35) return;
    if ((a.x - b.x) * fb.nx + (a.y - b.y) * fb.ny < dist * 0.35) return;
    if (!this.clear(a.x + fa.nx * 2, a.y + fa.ny * 2, b.x + fb.nx * 2, b.y + fb.ny * 2)) return;

    const sag = 2 + dist * (0.05 + rand() * 0.04);
    const A: Vec[] = [];
    const B: Vec[] = [];
    for (let i = 0; i < k; i++) {
      A.push(this.anchor(fa, ua + gap * i));
      B.push(this.anchor(fb, ub + gap * i));
      this.line(A[i], B[i], sag, 1.1, DOWN, 1, i * 0.35);
    }
    // перекладины поперёк всех нитей (в точках с учётом провисания)
    for (const s of [0.3, 0.66]) {
      const f = 4 * s * (1 - s) * sag;
      this.line(
        { x: A[0].x + (B[0].x - A[0].x) * s, y: A[0].y + (B[0].y - A[0].y) * s + f },
        { x: A[k - 1].x + (B[k - 1].x - A[k - 1].x) * s, y: A[k - 1].y + (B[k - 1].y - A[k - 1].y) * s + f }, 0.4, 0.6, DOWN, 0.6, s
      );
    }
  }

  /** Пучок лиан под нижней гранью тайла: 2–3 нити разной длины (кратной звену), длина — до следующего тайла. */
  private addVines(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    let room = 0;
    for (let y = cy + 1; y < this.height && !this.solid(cx, y); y++) room += ts;
    const maxPieces = Math.min(4, Math.floor((room - 6) / VINE_PIECE));
    if (maxPieces < 1) return;
    const count = 2 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const x = cx * ts + 4 + ((i + 0.3 + rand() * 0.4) * (ts - 8)) / count;
      const pieces = 1 + Math.floor(rand() * maxPieces);
      const tint = VINE_TINTS[Math.floor(rand() * VINE_TINTS.length)];
      this.vines.push(new Vine(this.back, this.tex, x, (cy + 1) * ts - 2, pieces, tint, rand() < 0.45));
    }
  }

  /** camLeft..camRight — видимый диапазон по x (мир). */
  public update(dt: number, camLeft: number, camRight: number, actors: readonly Actor[]): void {
    this.time += dt;
    const left = camLeft - VIEW_MARGIN;
    const right = camRight + VIEW_MARGIN;
    for (const s of this.strands) if (s.maxX >= left && s.minX <= right) s.update(this.time);
    for (const v of this.vines) if (v.maxX >= left && v.minX <= right) v.update(dt, this.time, actors);
  }
}
