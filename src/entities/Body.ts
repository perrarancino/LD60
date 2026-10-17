import type { SpriteDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';

/**
 * Физическое тело: AABB-хитбокс, привязанный к точке (x, y) — «ногам» спрайта (низ по центру).
 * Движение раздельно по осям с выталкиванием из твёрдых клеток уровня.
 */
export class Body {
  public x = 0;
  public y = 0;
  public vx = 0;
  public vy = 0;
  public grounded = false;

  private width = 0;
  private height = 0;
  private offsetX = 0; // левый край хитбокса относительно x
  private offsetY = 0; // верхний край хитбокса относительно y (отрицательный)

  /** Задаёт хитбокс по данным спрайта; flip зеркалит его вместе со спрайтом. */
  public setHitbox(def: SpriteDef, flip: boolean): void {
    const hb = def.hitbox;
    if (!hb) throw new Error(`[Body] у спрайта "${def.id}" нет hitbox`);
    const anchorX = def.frame_width * def.origin.x;
    const anchorY = def.frame_height * def.origin.y;
    const centerRel = hb.offset_x + hb.width / 2 - anchorX;
    this.width = hb.width;
    this.height = hb.height;
    this.offsetX = (flip ? -centerRel : centerRel) - hb.width / 2;
    this.offsetY = hb.offset_y - anchorY;
  }

  public move(dt: number, level: Level): void {
    const ts = level.tileSize;

    this.x += this.vx * dt;
    this.resolveX(level, ts);

    this.y += this.vy * dt;
    this.grounded = false;
    this.resolveY(level, ts);
  }

  private resolveX(level: Level, ts: number): void {
    const [c0, c1, r0, r1] = this.cells(ts);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (!level.isSolid(cx, cy)) continue;
        const left = this.x + this.offsetX;
        const center = left + this.width / 2;
        const pushRight = this.vx < 0 || (this.vx === 0 && center > cx * ts + ts / 2);
        this.x = pushRight ? (cx + 1) * ts - this.offsetX : cx * ts - this.width - this.offsetX;
        this.vx = 0;
      }
    }
  }

  private resolveY(level: Level, ts: number): void {
    const [c0, c1, r0, r1] = this.cells(ts);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (!level.isSolid(cx, cy)) continue;
        if (this.vy >= 0) {
          this.y = cy * ts - (this.offsetY + this.height);
          this.grounded = true;
        } else {
          this.y = (cy + 1) * ts - this.offsetY;
        }
        this.vy = 0;
      }
    }
  }

  /** Диапазон клеток [колонка от, до, ряд от, до], которые перекрывает хитбокс. */
  private cells(ts: number): [number, number, number, number] {
    const eps = 0.001;
    const left = this.x + this.offsetX;
    const top = this.y + this.offsetY;
    return [
      Math.floor(left / ts),
      Math.floor((left + this.width - eps) / ts),
      Math.floor(top / ts),
      Math.floor((top + this.height - eps) / ts)
    ];
  }
}
