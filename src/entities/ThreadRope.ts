import { Container, Sprite, type Texture } from 'pixi.js';

const SUBSTEPS = 2;
const ITERATIONS = 10; // итераций ограничений длины на подшаг
const GRAVITY = 320; // px/с²: нитка лёгкая — тянется вниз слабо
const DAMPING = 0.55; // 1/с: затухание скорости (воздух)
const WIND = 36; // px/с²: боковые порывы — бегут вдоль нитки
const OVERLAP = 1.5; // px: соседние кусочки нахлёстывают друг на друга — на изгибе нет щелей

interface Piece {
  sprite: Sprite;
  flipX: 1 | -1;
  flipY: 1 | -1;
}

/**
 * Лёгкая нитка: цепочка точек (verlet) от закреплённого верха к подвижному низу. Длина чуть больше расстояния между концами, поэтому
 * нитка не вытянута шестом: слегка провисает, качается порывами «сквозняка» и запаздывает за движением паучихи. Каждый кусочек
 * рисунка (текстура-звено) ставится на отрезок между точками и случайно отражается по вертикали и горизонтали — нитка не повторяется.
 */
export class ThreadRope {
  public readonly container = new Container();

  private readonly n: number; // число звеньев
  private readonly rest: number; // длина звена в покое
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pieces: Piece[] = [];
  private readonly pieceH: number;
  private time = Math.random() * 50;
  private readonly phase = Math.random() * Math.PI * 2;

  /**
   * @param texture звено нитки (тайл)
   * @param centerX центр нитки по x в звене (px) — вокруг него звено отражается
   * @param top закреплённый верх (мир)
   * @param bottom нижний конец в покое (мир)
   * @param slack запас длины: во сколько раз нитка длиннее прямой между концами минус 1 (0.006 = +0.6%)
   */
  constructor(texture: Texture, centerX: number, top: { x: number; y: number }, bottom: { x: number; y: number }, slack = 0.006) {
    this.pieceH = texture.height;
    const straight = Math.hypot(bottom.x - top.x, bottom.y - top.y);
    this.n = Math.max(3, Math.round(straight / this.pieceH));
    this.rest = (straight * (1 + slack)) / this.n;

    const count = this.n + 1;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const f = i / this.n;
      this.x[i] = this.px[i] = top.x + (bottom.x - top.x) * f;
      this.y[i] = this.py[i] = top.y + (bottom.y - top.y) * f;
    }

    for (let i = 0; i < this.n; i++) {
      const sprite = new Sprite(texture);
      sprite.pivot.set(centerX, this.pieceH / 2);
      this.container.addChild(sprite);
      this.pieces.push({ sprite, flipX: Math.random() < 0.5 ? 1 : -1, flipY: Math.random() < 0.5 ? 1 : -1 });
    }
    this.layout();
  }

  /** Шаг физики: верх закреплён в top, низ ведётся к bottom (мир). */
  public update(dt: number, top: { x: number; y: number }, bottom: { x: number; y: number }): void {
    this.time += dt;
    const h = dt / SUBSTEPS;
    const last = this.n;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 1; i < last; i++) {
        const vx = (this.x[i] - this.px[i]) * Math.exp(-DAMPING * h);
        const vy = (this.y[i] - this.py[i]) * Math.exp(-DAMPING * h);
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        // порыв бежит по нитке и сильнее всего в середине; плюс слабая гравитация
        const w = Math.sin((Math.PI * i) / last);
        const gust = WIND * w * (Math.sin(this.time * 1.1 + i * 0.42 + this.phase) + 0.6 * Math.sin(this.time * 2.3 - i * 0.77));
        this.x[i] += vx + gust * h * h;
        this.y[i] += vy + GRAVITY * h * h;
      }
      this.x[0] = this.px[0] = top.x;
      this.y[0] = this.py[0] = top.y;
      this.x[last] = this.px[last] = bottom.x;
      this.y[last] = this.py[last] = bottom.y;

      for (let it = 0; it < ITERATIONS; it++) {
        for (let i = 0; i < last; i++) {
          const dx = this.x[i + 1] - this.x[i];
          const dy = this.y[i + 1] - this.y[i];
          const d = Math.hypot(dx, dy) || 1e-6;
          const diff = (d - this.rest) / d;
          // нитка не сжимается и почти не растягивается; закреплённые концы не двигаем
          const wa = i === 0 ? 0 : 1;
          const wb = i + 1 === last ? 0 : 1;
          const tw = wa + wb;
          if (tw === 0) continue;
          this.x[i] += (dx * diff * wa) / tw;
          this.y[i] += (dy * diff * wa) / tw;
          this.x[i + 1] -= (dx * diff * wb) / tw;
          this.y[i + 1] -= (dy * diff * wb) / tw;
        }
      }
    }
    this.layout();
  }

  /** Расставляет кусочки по отрезкам цепочки. */
  private layout(): void {
    for (let i = 0; i < this.n; i++) {
      const ax = this.x[i];
      const ay = this.y[i];
      const bx = this.x[i + 1];
      const by = this.y[i + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1e-6;
      const p = this.pieces[i];
      p.sprite.position.set((ax + bx) / 2, (ay + by) / 2);
      // рисунок нитки вертикальный: «вниз» (+y) поворачиваем вдоль отрезка a -> b
      p.sprite.rotation = Math.atan2(-(bx - ax), by - ay);
      p.sprite.scale.set(p.flipX, (p.flipY * (len + OVERLAP)) / this.pieceH);
    }
  }
}
