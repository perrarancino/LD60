import { Container, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef } from '../data/types.ts';

/** Нитка паучихи (enemy_spider_thread): из её звеньев собран весь паутинный декор. */
export const THREAD_SPRITE = 'enemy_spider_thread';
const THREAD_CENTER_X = 5; // центр нитки по x в звене (как в риге паучихи)
const OVERLAP = 1.2; // px: звенья слегка нахлёстываются — на изгибе нет щелей

// Нитки между точками на тайлах
const SPAN_MIN = 36; // px: длина пролёта между двумя поверхностями (от, до)
const SPAN_MAX = 118;
const SWAY_SPEED = 0.9; // рад/с

// Лианы
const VINE_SEG = 7; // px: длина звена лианы
const VINE_GRAVITY = 560; // px/с²
const VINE_DAMPING = 2.4; // 1/с: затухание скорости
const VINE_WIND = 55; // px/с²: порывы ветра по уровню (на конце лианы сильнее)
const VINE_ITERATIONS = 3;
const VINE_SUBSTEPS = 2;
const ACTOR_PAD = 2; // px: герой задевает лиану чуть раньше края хитбокса
const VIEW_MARGIN = 40; // px: за краем обзора декор не обновляется

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

/** Звено нитки: спрайт, растянутый вдоль отрезка. */
class Piece {
  public readonly sprite: Sprite;
  // без случайных отражений: звенья одинаково ориентированы, нитка получается ровной «скрученной», а не рваной цепочкой
  private readonly fx = 1;
  private readonly fy = 1;

  constructor(parent: Container, tex: Texture, alpha: number) {
    this.sprite = new Sprite(tex);
    this.sprite.pivot.set(THREAD_CENTER_X, tex.height / 2);
    this.sprite.alpha = alpha;
    parent.addChild(this.sprite);
  }

  /** Растягивает звено от (ax, ay) к (bx, by). */
  public place(ax: number, ay: number, bx: number, by: number): void {
    const len = Math.hypot(bx - ax, by - ay) || 1e-6;
    this.sprite.position.set((ax + bx) / 2, (ay + by) / 2);
    this.sprite.rotation = Math.atan2(-(bx - ax), by - ay); // рисунок нитки вертикальный: «вниз» (+y) поворачиваем вдоль отрезка
    this.sprite.scale.set(this.fx, (this.fy * (len + OVERLAP)) / this.sprite.texture.height);
  }
}

/**
 * Нитка между двумя закреплёнными точками: провисает (sag, вниз) и слегка колышется. Точки кривой считаются аналитически — дёшево.
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
    private readonly sag: number, private readonly sway: number, private readonly phase: number, alpha = 1
  ) {
    this.dx = bx - ax;
    this.dy = by - ay;
    const len = Math.hypot(this.dx, this.dy) || 1;
    let nx = -this.dy / len;
    let ny = this.dx / len;
    if (ny < 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; } // нормаль смотрит вниз: провисание — вниз
    this.nx = nx;
    this.ny = ny;
    this.minX = Math.min(ax, bx) - sag - sway;
    this.maxX = Math.max(ax, bx) + sag + sway;
    const n = Math.max(1, Math.ceil(len / tex.height));
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
 * Лиана: цепочка (verlet) из паутинных звеньев, корень закреплён под тайлом. Физична: тяжесть, затухание, порывы ветра, а герой, проходя
 * сквозь неё, раздвигает звенья и раскачивает её.
 */
class Vine {
  public readonly minX: number;
  public readonly maxX: number;
  private readonly n: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pieces: Piece[] = [];

  constructor(parent: Container, tex: Texture, private readonly rx: number, ry: number, length: number) {
    this.n = Math.max(2, Math.round(length / VINE_SEG));
    const size = this.n + 1;
    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.px = new Float32Array(size);
    this.py = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.x[i] = this.px[i] = rx;
      this.y[i] = this.py[i] = ry + i * VINE_SEG;
    }
    for (let i = 0; i < this.n; i++) this.pieces.push(new Piece(parent, tex, 1));
    const reach = this.n * VINE_SEG;
    this.minX = rx - reach;
    this.maxX = rx + reach;
    this.render();
  }

  public update(dt: number, t: number, actors: readonly Actor[]): void {
    const h = Math.min(dt, 1 / 30) / VINE_SUBSTEPS;
    const damp = Math.exp(-VINE_DAMPING * h);
    const n = this.n;
    for (let step = 0; step < VINE_SUBSTEPS; step++) {
      for (let i = 1; i <= n; i++) {
        const k = i / n; // на конце порывы сильнее
        const wind = VINE_WIND * k * (Math.sin(t * 0.9 + this.rx * 0.015 + i * 0.35) + 0.6 * Math.sin(t * 2.3 + this.rx * 0.04));
        const vx = (this.x[i] - this.px[i]) * damp;
        const vy = (this.y[i] - this.py[i]) * damp;
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        this.x[i] += vx + wind * h * h;
        this.y[i] += vy + VINE_GRAVITY * h * h;
      }
      for (let it = 0; it < VINE_ITERATIONS; it++) {
        for (let i = 0; i < n; i++) {
          const dx = this.x[i + 1] - this.x[i];
          const dy = this.y[i + 1] - this.y[i];
          const dist = Math.hypot(dx, dy) || 1e-6;
          const diff = (dist - VINE_SEG) / dist;
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
    }
    this.render();
  }

  private render(): void {
    for (let i = 0; i < this.n; i++) this.pieces[i].place(this.x[i], this.y[i], this.x[i + 1], this.y[i + 1]);
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

/**
 * Паутинный декор из нитки паучихи по зонам уровня (kind: "webs"):
 *  - углы: «паутина из нитей» между точками на двух поверхностях у угла;
 *  - пролёты: две точки на гранях разных тайлов связаны нитками (провисают, перекрещиваются, перекладины между ними);
 *  - натянутые поверх тайлов нитки вдоль верхних граней — свисают на тайл;
 *  - лианы: физично свисающие нити под тайлами.
 * Нитки и углы лежат в слое поверх тайлов (front), лианы — под тайлами (back, корень спрятан в тайле).
 * Обновляется только то, что в обзоре.
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

  private line(ax: number, ay: number, bx: number, by: number, sag: number, sway: number, rand: () => number, alpha = 1): void {
    this.strands.push(new Strand(this.front, this.tex, ax, ay, bx, by, sag, sway, rand() * Math.PI * 2, alpha));
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
    const ts = this.ts;

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (this.solid(cx, cy)) {
          if (this.free(cx, cy - 1)) faces.push({ x: (cx + 0.5) * ts, y: cy * ts, tx: 1, ty: 0, nx: 0, ny: -1 });
          if (this.free(cx, cy + 1)) {
            faces.push({ x: (cx + 0.5) * ts, y: (cy + 1) * ts, tx: 1, ty: 0, nx: 0, ny: 1 });
            if (rand() < Math.min(1, density * 1.4)) this.addVines(cx, cy, rand);
          }
          if (this.free(cx - 1, cy)) faces.push({ x: cx * ts, y: (cy + 0.5) * ts, tx: 0, ty: 1, nx: -1, ny: 0 });
          if (this.free(cx + 1, cy)) faces.push({ x: (cx + 1) * ts, y: (cy + 0.5) * ts, tx: 0, ty: 1, nx: 1, ny: 0 });
          // нитки, натянутые поверх верхней грани тайла и свисающие на него
          if (this.free(cx, cy - 1) && rand() < density * 0.4) this.addDraped(cx, cy, rand);
        } else if (rand() < density * 0.55) {
          this.addCorner(cx, cy, rand);
        }
      }
    }

    // пролёты между гранями разных тайлов
    const attempts = Math.round(faces.length * density * 3);
    for (let k = 0; k < attempts; k++) {
      const fa = faces[Math.floor(rand() * faces.length)];
      const fb = faces[Math.floor(rand() * faces.length)];
      if (fa && fb && fa !== fb) this.addSpan(fa, fb, rand);
    }
  }

  /** Точка на грани: u — сдвиг от центра вдоль грани, px. */
  private anchor(f: Face, u: number): { x: number; y: number } {
    return { x: f.x + f.tx * u, y: f.y + f.ty * u };
  }

  /** Между точками нет твёрдых клеток? */
  private clear(ax: number, ay: number, bx: number, by: number): boolean {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(len / 4);
    for (let i = 1; i < steps; i++) {
      const s = i / steps;
      if (this.isSolid(Math.floor((ax + (bx - ax) * s) / this.ts), Math.floor((ay + (by - ay) * s) / this.ts))) return false;
    }
    return true;
  }

  /** Пролёт: две точки на гранях двух тайлов связаны ниткой; рядом вторая нитка, между ними крест и перекладины — получается лоскут паутины. */
  private addSpan(fa: Face, fb: Face, rand: () => number): void {
    const half = this.ts / 2 - 4;
    const ua = (rand() * 2 - 1) * half;
    const ub = (rand() * 2 - 1) * half;
    const a = this.anchor(fa, ua);
    const b = this.anchor(fb, ub);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < SPAN_MIN || dist > SPAN_MAX) return;
    // грани смотрят друг на друга и между ними пусто
    if ((b.x - a.x) * fa.nx + (b.y - a.y) * fa.ny < dist * 0.35) return;
    if ((a.x - b.x) * fb.nx + (a.y - b.y) * fb.ny < dist * 0.35) return;
    if (!this.clear(a.x + fa.nx * 2, a.y + fa.ny * 2, b.x + fb.nx * 2, b.y + fb.ny * 2)) return;

    const off = (rand() < 0.5 ? -1 : 1) * (10 + rand() * 8);
    const a2 = this.anchor(fa, Math.max(-half, Math.min(half, ua + off)));
    const b2 = this.anchor(fb, Math.max(-half, Math.min(half, ub + off * (0.7 + rand() * 0.6))));
    const sag = 2 + dist * (0.05 + rand() * 0.05);
    this.line(a.x, a.y, b.x, b.y, sag, 1.2, rand, 1);
    this.line(a2.x, a2.y, b2.x, b2.y, sag * (0.8 + rand() * 0.4), 1.2, rand, 0.9);
    this.line(a.x, a.y, b2.x, b2.y, sag * 0.7, 1.0, rand, 0.6); // крест
    this.line(a2.x, a2.y, b.x, b.y, sag * 0.7, 1.0, rand, 0.6);
    for (const s of [0.34, 0.68]) {
      // перекладины между нитками (точки с учётом провисания)
      const k = 4 * s * (1 - s);
      this.line(
        a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s + sag * k,
        a2.x + (b2.x - a2.x) * s, a2.y + (b2.y - a2.y) * s + sag * k * 0.9, 0.5, 0.8, rand, 0.55
      );
    }
  }

  /** Паутина в углу: нити «струнным» узором между точками на двух поверхностях (пол/потолок и стена). */
  private addCorner(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    const floor = this.solid(cx, cy + 1);
    const ceil = this.solid(cx, cy - 1);
    const wallL = this.solid(cx - 1, cy);
    const wallR = this.solid(cx + 1, cy);
    if (!(floor || ceil) || !(wallL || wallR)) return;
    const sx = wallL ? 1 : -1; // от стены вдоль пола
    const hubX = wallL ? cx * ts : (cx + 1) * ts;
    const hubY = floor ? (cy + 1) * ts : cy * ts;
    const vy = floor ? -1 : 1; // от пола нити идут вверх, от потолка — вниз
    const R = 34 + rand() * 18;
    const N = 5;
    for (let k = 1; k < N; k++) {
      const ux = hubX + sx * (R * k) / N;
      const vyy = hubY + vy * (R * (N - k)) / N;
      this.line(ux, hubY, hubX, vyy, 1.2 + rand() * 1.5, 0.9, rand, k === 1 || k === N - 1 ? 0.7 : 0.95);
    }
    this.line(hubX, hubY, hubX + sx * R * 0.62, hubY + vy * R * 0.62, 1, 0.8, rand, 0.7); // диагональ из угла
  }

  /** Нитки вдоль верхней грани тайла: натянуты поверх тайла и провисают на него. */
  private addDraped(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    const reach = this.solid(cx + 1, cy) && this.free(cx + 1, cy - 1) && rand() < 0.5 ? 2 : 1; // тянется на соседний тайл
    const n = 1 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const ax = cx * ts + 3 + rand() * 6;
      const bx = (cx + reach) * ts - 3 - rand() * 6;
      this.line(ax, cy * ts, bx, cy * ts, 3 + rand() * 5, 0.8, rand, 0.9 - i * 0.2);
    }
  }

  /** Лианы под нижней гранью тайла: 1–2 физичные нити, длина — до следующего тайла. */
  private addVines(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    let room = 0;
    for (let y = cy + 1; y < this.height && !this.solid(cx, y); y++) room += ts;
    if (room < 14) return;
    const count = 2 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const x = cx * ts + 5 + (i + rand()) * ((ts - 10) / count);
      const length = Math.min(room - 4, 16 + rand() * 46);
      this.vines.push(new Vine(this.back, this.tex, x, (cy + 1) * ts - 2, length));
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
