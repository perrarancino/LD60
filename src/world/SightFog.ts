import { Graphics } from 'pixi.js';
import type { Level } from './Level.ts';

const CELL = 8; // px: размер клетки тумана (меньше тайла — края света мягче)
const INNER_R = 140; // px: ближе этого видно всё, что не закрыто стеной
const OUTER_R = 260; // px: дальше — темнота
const FORWARD_BONUS = 90; // px: в сторону взгляда героя видно дальше («то, что перед тобой»)
const STEP = 6; // px: шаг луча
const LEVELS = 16; // ступеней прозрачности (чтобы склеивать клетки в ряды)
const FOG_COLOR = 0x000000;

interface Vec {
  x: number;
  y: number;
}

/**
 * Туман по линии видимости: герой видит только то, что перед ним в прямой видимости и недалеко — стены закрывают обзор (луч от героя до клетки
 * не должен пройти сквозь твёрдый тайл), дальше радиуса темно, вперёд по взгляду — видно дальше. Всё остальное закрыто чёрным (поверх мира и света).
 * Комнаты в обзоре не участвуют. Клетки, в которые герой хоть раз смотрел, запоминаются (explored) — по ним рисуется миникарта.
 */
export class SightFog {
  public readonly container = new Graphics();
  /** Тайлы, которые герой уже видел (1 — видел): ширина × высота уровня. */
  public readonly explored: Uint8Array;

  private readonly w: number;
  private readonly h: number;
  private readonly ts: number;
  public exploredChanged = false;

  constructor(private readonly level: Level) {
    this.w = level.widthTiles;
    this.h = level.heightTiles;
    this.ts = level.tileSize;
    this.explored = new Uint8Array(this.w * this.h);
  }

  /** Видна ли точка (x, y) из точки eye: луч не проходит сквозь твёрдые тайлы (сам тайл цели может быть твёрдым — стену видно). */
  private los(eye: Vec, x: number, y: number): boolean {
    const ts = this.ts;
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dist = Math.hypot(dx, dy);
    const tcx = Math.floor(x / ts);
    const tcy = Math.floor(y / ts);
    const n = Math.floor(dist / STEP);
    for (let i = 1; i <= n; i++) {
      const px = eye.x + (dx * i) / n;
      const py = eye.y + (dy * i) / n;
      const cx = Math.floor(px / ts);
      const cy = Math.floor(py / ts);
      if (cx === tcx && cy === tcy) return true; // дошли до тайла цели
      if (this.level.isSolid(cx, cy)) return false;
    }
    return true;
  }

  /** Перерисовывает туман в области обзора (мир, px). eye — глаза героя; facing — куда он смотрит (1/−1). */
  public update(camLeft: number, camTop: number, viewW: number, viewH: number, eye: Vec, facing: number): void {
    const g = this.container;
    g.clear();
    const c0 = Math.floor(camLeft / CELL) - 1;
    const c1 = Math.ceil((camLeft + viewW) / CELL) + 1;
    const r0 = Math.floor(camTop / CELL) - 1;
    const r1 = Math.ceil((camTop + viewH) / CELL) + 1;
    const reach = OUTER_R + FORWARD_BONUS;
    for (let r = r0; r <= r1; r++) {
      const cy = (r + 0.5) * CELL;
      let runStart = c0;
      let runA = -1;
      for (let c = c0; c <= c1 + 1; c++) {
        let a = -2;
        if (c <= c1) {
          const cx = (c + 0.5) * CELL;
          const dx = cx - eye.x;
          const dy = cy - eye.y;
          const dist = Math.hypot(dx, dy);
          a = 1;
          if (dist < reach) {
            // радиус обзора: вперёд — дальше
            const fwd = dist > 0 ? Math.max(0, (dx / dist) * facing) : 0;
            const outer = OUTER_R + FORWARD_BONUS * fwd;
            const inner = INNER_R + FORWARD_BONUS * 0.5 * fwd;
            if (dist < outer && this.los(eye, cx, cy)) {
              a = dist <= inner ? 0 : (dist - inner) / (outer - inner);
              a = a * a * (3 - 2 * a);
              // запоминаем увиденное
              if (a < 0.6) {
                const tx = Math.floor(cx / this.ts);
                const ty = Math.floor(cy / this.ts);
                if (tx >= 0 && ty >= 0 && tx < this.w && ty < this.h && !this.explored[ty * this.w + tx]) {
                  this.explored[ty * this.w + tx] = 1;
                  this.exploredChanged = true;
                }
              }
            }
          }
          a = Math.round(a * LEVELS) / LEVELS;
        }
        if (a === runA) continue;
        if (runA > 0) g.rect(runStart * CELL, r * CELL, (c - runStart) * CELL, CELL).fill({ color: FOG_COLOR, alpha: runA });
        runStart = c;
        runA = a;
      }
    }
  }
}
