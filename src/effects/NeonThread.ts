import { Graphics } from 'pixi.js';
import { pal } from '../core/Palette.ts';

interface Vec {
  x: number;
  y: number;
}

// рампа virus — те же фиолетово-розовые цвета, что у краба
const EDGE = pal('virus', 3); // контур-свечение
const BODY = pal('virus', 4); // тело нити
const GLOW = pal('virus', 5);
const HOT = pal('virus', 6); // бегущий импульс
const WHITE = pal('virus', 7);

const SEGMENTS = 26;

/**
 * Неоновая нить (клешни краба): светящаяся линия пикселями арта от плеча к клешне, провисает дугой, пока слабо натянута, и трепещет.
 * Рисуется одним Graphics (перерисовывается каждый кадр): контур 3 px, тело 2 px, по нити бегут яркие импульсы. Координаты — локальные
 * в контейнере владельца.
 */
export class NeonThread {
  public readonly graphics = new Graphics();
  /** Точки нити после последнего draw() (для света вдоль неё). */
  public readonly points: Vec[] = Array.from({ length: SEGMENTS + 1 }, () => ({ x: 0, y: 0 }));

  private readonly grid = new Map<number, number>();
  private time = Math.random() * 10;
  private readonly seed = Math.random() * 6;

  /**
   * a — крепление к телу, b — клешня; maxLen — длина нити (чем ближе концы к maxLen, тем она туже); energy 0..1 — насколько нить возбуждена
   * (в ударе трепещет сильнее и ярче).
   */
  public draw(dt: number, a: Vec, b: Vec, maxLen: number, energy: number): void {
    this.time += dt;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const slack = Math.max(0, 1 - dist / maxLen); // 0 — струной, 1 — вся провисла
    const sag = slack * maxLen * 0.55 + 2;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2 + sag;
    const nx = dist > 0.001 ? -dy / dist : 0;
    const ny = dist > 0.001 ? dx / dist : 1;

    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const k = 1 - u;
      // квадратичная кривая Безье + бегущая волна поперёк нити (затихает у концов)
      let x = k * k * a.x + 2 * k * u * cx + u * u * b.x;
      let y = k * k * a.y + 2 * k * u * cy + u * u * b.y;
      const env = Math.sin(Math.PI * u) * (0.7 + 2.6 * energy);
      const w = Math.sin(this.time * 9 + u * 13 + this.seed) * env;
      x += nx * w;
      y += ny * w;
      this.points[i].x = x;
      this.points[i].y = y;
    }
    this.render(energy);
  }

  private render(energy: number): void {
    const g = this.graphics;
    g.clear();
    const grid = this.grid;
    grid.clear();
    const put = (x: number, y: number, layer: number) => {
      const k = (x + 1024) * 2048 + (y + 1024);
      if ((grid.get(k) ?? 0) < layer) grid.set(k, layer);
    };
    const stamp = (cx: number, cy: number, size: number, layer: number) => {
      const lo = -Math.floor((size - 1) / 2);
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) put(cx + lo + dx, cy + lo + dy, layer);
    };
    let path = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      let x0 = Math.round(this.points[i].x);
      let y0 = Math.round(this.points[i].y);
      const x1 = Math.round(this.points[i + 1].x);
      const y1 = Math.round(this.points[i + 1].y);
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      const steps = Math.max(dx, -dy) + 1;
      for (let s = 0; s < steps; s++) {
        stamp(x0, y0, 3, 1);
        stamp(x0, y0, 2, 2);
        // импульсы: яркие участки бегут от плеча к клешне
        const phase = (path * 0.045 - this.time * (1.1 + energy)) % 1;
        const pulse = ((phase + 1) % 1) < 0.16;
        if (pulse) stamp(x0, y0, 1, 4);
        else if (path % 3 === 0) stamp(x0, y0, 1, 3);
        path++;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    const alphaEdge = 0.55 + 0.25 * energy;
    for (const layer of [1, 2, 3, 4]) {
      const color = layer === 1 ? EDGE : layer === 2 ? BODY : layer === 3 ? GLOW : (energy > 0.5 ? WHITE : HOT);
      for (const [k, l] of grid) {
        if (l !== layer) continue;
        const px = Math.floor(k / 2048) - 1024;
        const py = (k % 2048) - 1024;
        g.rect(px, py, 1, 1);
      }
      g.fill({ color, alpha: layer === 1 ? alphaEdge : 1 });
    }
  }
}
