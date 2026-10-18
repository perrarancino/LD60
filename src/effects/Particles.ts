import { Container, Sprite, Texture } from 'pixi.js';

const MAX_PARTICLES = 500;

interface Particle {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gx: number; // ускорение по x (притяжение / ветер)
  gy: number; // ускорение по y (гравитация)
  drag: number; // 1/с: затухание скорости
  life: number;
  maxLife: number;
  size: number;
  grow: number; // множитель размера к концу жизни (<1 — тают в точку)
  alive: boolean;
}

export interface BurstOptions {
  count: number;
  colors: number[];
  speed: [number, number]; // px/с
  angle?: number; // направление конуса, рад (y вниз); без него — во все стороны
  spread?: number; // половина раствора конуса, рад
  life: [number, number]; // с
  size: [number, number]; // px
  gravity?: number; // px/с²
  drag?: number; // 1/с
  grow?: number; // размер к концу жизни относительно начального
}

const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

/**
 * Лёгкие пиксельные частицы (квадратики 1–3 px) для «сочных» эффектов: брызги, пыль, всасывание, след. Спрайты берутся из пула;
 * положения округляются до целых пикселей — частицы остаются чёткими и не мерцают.
 */
export class Particles {
  public readonly container = new Container();
  private readonly pool: Particle[] = [];

  private spawn(): Particle | null {
    let p = this.pool.find((q) => !q.alive);
    if (!p) {
      if (this.pool.length >= MAX_PARTICLES) return null;
      const sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0.5);
      this.container.addChild(sprite);
      p = { sprite, x: 0, y: 0, vx: 0, vy: 0, gx: 0, gy: 0, drag: 0, life: 0, maxLife: 1, size: 1, grow: 1, alive: false };
      this.pool.push(p);
    }
    return p;
  }

  /** Одна частица со всеми параметрами. */
  public emit(
    x: number, y: number, vx: number, vy: number, color: number, life: number, size: number,
    opts: { gx?: number; gy?: number; drag?: number; grow?: number } = {}
  ): void {
    const p = this.spawn();
    if (!p) return;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.gx = opts.gx ?? 0;
    p.gy = opts.gy ?? 0;
    p.drag = opts.drag ?? 0;
    p.life = p.maxLife = life;
    p.size = size;
    p.grow = opts.grow ?? 1;
    p.alive = true;
    p.sprite.tint = color;
    p.sprite.visible = true;
    p.sprite.alpha = 1;
  }

  /** Брызги из точки: конус (angle ± spread) или во все стороны. */
  public burst(x: number, y: number, o: BurstOptions): void {
    for (let i = 0; i < o.count; i++) {
      const a = o.angle === undefined ? Math.random() * Math.PI * 2 : o.angle + (Math.random() * 2 - 1) * (o.spread ?? 0.5);
      const sp = rand(o.speed);
      this.emit(
        x, y, Math.cos(a) * sp, Math.sin(a) * sp, o.colors[Math.floor(Math.random() * o.colors.length)],
        rand(o.life), rand(o.size), { gy: o.gravity ?? 0, drag: o.drag ?? 0, grow: o.grow ?? 1 }
      );
    }
  }

  public update(dt: number): void {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        p.sprite.visible = false;
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx = (p.vx + p.gx * dt) * k;
      p.vy = (p.vy + p.gy * dt) * k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = 1 - p.life / p.maxLife; // 0..1 — возраст
      const size = Math.max(1, Math.round(p.size * (1 + (p.grow - 1) * t)));
      p.sprite.width = p.sprite.height = size;
      p.sprite.position.set(Math.round(p.x), Math.round(p.y));
      p.sprite.alpha = t > 0.7 ? (1 - t) / 0.3 : 1; // гаснут в конце жизни
    }
  }
}
