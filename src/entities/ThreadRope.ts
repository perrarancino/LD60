import { Container, Sprite, type Texture } from 'pixi.js';

const NODES = 14; // узлов упругой струны (без концов — они закреплены); мало узлов => движение плавное, без дрожи
const STEP = 1 / 120; // шаг физики, с
const WAVE_SPEED = 150; // px/с: скорость волны по нитке (основной тон ~ WAVE_SPEED / 2L: медленное плавное качание)
const DAMPING = 0.9; // 1/с: затухание боковых колебаний
const WIND = 18; // px/с²: сила порывов (очень низкие частоты)
const INERTIA = 0.6; // доля инерции: нитка запаздывает за боковым движением нижнего конца
const END_SMOOTH = 5; // 1/с: сглаживание ускорения конца (убирает шум)
const MAX_END_ACC = 300; // px/с²: потолок ускорения конца, которое учитывает нитка
const OVERLAP = 1.5; // px: соседние звенья слегка нахлёстывают друг на друга — на изгибе нет щелей

interface Piece {
  sprite: Sprite;
  flipX: 1 | -1;
  flipY: 1 | -1;
}

/**
 * Лёгкая нитка: прямая от закреплённого верха к подвижному низу плюс БОКОВОЕ смещение, которое живёт как упругая струна
 * (волновое уравнение с затуханием). В отличие от жёсткой цепочки с ограничениями длины, здесь нет высокочастотных мод — нитка
 * плавно течёт: качается медленными порывами «сквозняка» и запаздывает за боковым движением паучихи. Звенья рисунка ставятся
 * по гладкой кривой (кубическая интерполяция узлов) и случайно отражаются по вертикали и горизонтали — нитка не повторяется.
 */
export class ThreadRope {
  public readonly container = new Container();

  private readonly n: number; // число звеньев рисунка
  private readonly pieceH: number;
  private readonly d = new Float32Array(NODES + 2); // боковое смещение узлов (0 и NODES+1 — закреплённые концы)
  private readonly v = new Float32Array(NODES + 2);
  private readonly pieces: Piece[] = [];
  private readonly phase = Math.random() * Math.PI * 2;
  private time = Math.random() * 50;
  private acc = 0;
  private lastEnd: { x: number; y: number } | null = null;
  private endVel = 0; // боковая скорость нижнего конца
  private endAcc = 0; // и её ускорение (сглаженное)
  private straight = 1;

  /**
   * @param texture звено нитки (тайл)
   * @param centerX центр нитки по x в звене (px) — вокруг него звено отражается
   * @param top закреплённый верх (мир)
   * @param bottom нижний конец в покое (мир)
   */
  constructor(texture: Texture, centerX: number, top: { x: number; y: number }, bottom: { x: number; y: number }) {
    this.pieceH = texture.height;
    this.straight = Math.hypot(bottom.x - top.x, bottom.y - top.y);
    this.n = Math.max(3, Math.round(this.straight / this.pieceH));
    for (let i = 0; i < this.n; i++) {
      const sprite = new Sprite(texture);
      sprite.pivot.set(centerX, this.pieceH / 2);
      this.container.addChild(sprite);
      this.pieces.push({ sprite, flipX: Math.random() < 0.5 ? 1 : -1, flipY: Math.random() < 0.5 ? 1 : -1 });
    }
    this.layout(top, bottom);
  }

  /** Шаг физики: верх закреплён в top, низ ведётся к bottom (мир). */
  public update(dt: number, top: { x: number; y: number }, bottom: { x: number; y: number }): void {
    this.time += dt;
    const dx = bottom.x - top.x;
    const dy = bottom.y - top.y;
    const L = Math.hypot(dx, dy) || 1;
    this.straight = L;
    const nx = -dy / L; // боковая ось
    const ny = dx / L;

    // боковое движение нижнего конца: скорость и сглаженное ускорение (нитка запаздывает за ним инерцией)
    if (this.lastEnd && dt > 0) {
      const vel = ((bottom.x - this.lastEnd.x) * nx + (bottom.y - this.lastEnd.y) * ny) / dt;
      const acc = (vel - this.endVel) / dt;
      const clamped = Math.max(-MAX_END_ACC, Math.min(MAX_END_ACC, acc)); // резкие рывки (отдача) не раскачивают нитку без меры
      this.endAcc += (clamped - this.endAcc) * (1 - Math.exp(-END_SMOOTH * dt));
      this.endVel = vel;
    }
    this.lastEnd = { x: bottom.x, y: bottom.y };

    this.acc += dt;
    const h = L / (NODES + 1); // расстояние между узлами
    const c2 = (WAVE_SPEED * WAVE_SPEED) / (h * h);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (let i = 1; i <= NODES; i++) {
        const s = i / (NODES + 1);
        const w = Math.sin(Math.PI * s);
        // порывы: две медленные волны, бегущие вдоль нитки
        const gust = WIND * w * (Math.sin(this.time * 0.8 - s * 3.1 + this.phase) + 0.5 * Math.sin(this.time * 1.7 + s * 4.3));
        const force = gust - INERTIA * s * this.endAcc;
        this.v[i] += (c2 * (this.d[i - 1] - 2 * this.d[i] + this.d[i + 1]) - DAMPING * this.v[i] + force) * STEP;
      }
      for (let i = 1; i <= NODES; i++) this.d[i] += this.v[i] * STEP;
    }
    this.layout(top, bottom);
  }

  /** Смещение струны в точке s (0..1) — кубическая интерполяция Catmull-Rom между узлами. */
  private offsetAt(s: number): number {
    const f = s * (NODES + 1);
    const i = Math.min(Math.floor(f), NODES);
    const t = f - i;
    const p0 = this.d[Math.max(i - 1, 0)];
    const p1 = this.d[i];
    const p2 = this.d[i + 1];
    const p3 = this.d[Math.min(i + 2, NODES + 1)];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }

  /** Расставляет звенья по гладкой кривой от top к bottom. */
  private layout(top: { x: number; y: number }, bottom: { x: number; y: number }): void {
    const dx = bottom.x - top.x;
    const dy = bottom.y - top.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    const point = (s: number) => {
      const o = this.offsetAt(s);
      return { x: top.x + dx * s + nx * o, y: top.y + dy * s + ny * o };
    };
    let a = point(0);
    for (let i = 0; i < this.n; i++) {
      const b = point((i + 1) / this.n);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
      const p = this.pieces[i];
      p.sprite.position.set((a.x + b.x) / 2, (a.y + b.y) / 2);
      // рисунок нитки вертикальный: «вниз» (+y) поворачиваем вдоль отрезка a -> b
      p.sprite.rotation = Math.atan2(-(b.x - a.x), b.y - a.y);
      p.sprite.scale.set(p.flipX, (p.flipY * (len + OVERLAP)) / this.pieceH);
      a = b;
    }
  }
}
