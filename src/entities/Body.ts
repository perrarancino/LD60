import type { SpriteDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { SolidBox } from './Hittable.ts';

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
  /** Куда упёрлись по X при последнем move(): -1 влево, 1 вправо, 0 — нет. */
  public blockedX: -1 | 0 | 1 = 0;

  /** Твёрдые прямоугольники врагов на этот кадр (на них можно встать; задаёт владелец тела перед move). */
  public solids: readonly SolidBox[] = [];
  /** Кто несёт тело (враг под ногами) и где он был в прошлый раз: тело едет вместе с ним. */
  private ride: { key: object; x: number; y: number } | null = null;

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

  // Границы хитбокса в мировых координатах
  public get left(): number { return this.x + this.offsetX; }
  public get right(): number { return this.x + this.offsetX + this.width; }
  public get top(): number { return this.y + this.offsetY; }
  public get bottom(): number { return this.y + this.offsetY + this.height; }
  public get hitWidth(): number { return this.width; }

  /**
   * Касается ли хитбокс боковой стены (в воздухе). -1 слева, 1 справа, 0 — нет.
   * Если стены с обеих сторон (узкая шахта), выбирается сторона prefer (куда жмёт игрок).
   */
  public wallContact(level: Level, prefer = 0): -1 | 0 | 1 {
    const ts = level.tileSize;
    // Границы уровня считаются стеной только в пределах его высоты (иначе по ним можно лезть бесконечно вверх)
    const r0 = Math.max(0, Math.floor((this.top + 3) / ts));
    const r1 = Math.min(level.heightTiles - 1, Math.floor((this.bottom - 3) / ts));
    const probe = (x: number): boolean => {
      const cx = Math.floor(x / ts);
      for (let cy = r0; cy <= r1; cy++) if (level.isSolid(cx, cy)) return true;
      return false;
    };
    const probeBox = (x: number): boolean => {
      const y0 = this.top + 3;
      const y1 = this.bottom - 3;
      return this.solids.some((s) => x >= s.x && x <= s.x + s.w && y1 > s.y && y0 < s.y + s.h);
    };
    const right = probe(this.right + 0.6) || probeBox(this.right + 0.6);
    const left = probe(this.left - 0.6) || probeBox(this.left - 0.6);
    if (right && left) return prefer < 0 ? -1 : 1;
    return right ? 1 : left ? -1 : 0;
  }

  /** Значение y тела, при котором низ хитбокса стоит на feetY. */
  public yForFeet(feetY: number): number { return feetY - (this.offsetY + this.height); }
  /** Значение x тела, при котором центр хитбокса стоит в centerX. */
  public xForCenter(centerX: number): number { return centerX - this.offsetX - this.width / 2; }

  /** Пересекал бы хитбокс твёрдые клетки, если бы тело стояло в (x, y)? */
  public overlapsSolidAt(level: Level, x: number, y: number): boolean {
    const ts = level.tileSize;
    const eps = 0.001;
    const left = x + this.offsetX;
    const top = y + this.offsetY;
    for (let cy = Math.floor(top / ts); cy <= Math.floor((top + this.height - eps) / ts); cy++) {
      for (let cx = Math.floor(left / ts); cx <= Math.floor((left + this.width - eps) / ts); cx++) {
        if (level.isSolid(cx, cy)) return true;
      }
    }
    return false;
  }

  public move(dt: number, level: Level): void {
    const ts = level.tileSize;
    this.blockedX = 0;

    if (this.ride) {
      const under = this.solids.find((s) => s.key === this.ride!.key);
      if (under) {
        this.x += under.x - this.ride.x;
        this.y += under.y - this.ride.y;
      }
      this.ride = null;
    }

    this.x += this.vx * dt;
    this.resolveX(level, ts);

    this.y += this.vy * dt;
    this.grounded = false;
    this.resolveY(level, ts);
    this.resolveSolids();
  }

  /**
   * Враги — твёрдые коробки: сверху на них встают (и едут вместе с ними), сбоку не проходят, снизу упираются головой.
   * Выбирается ось с наименьшим проникновением; верх в приоритете — чуть зашёл на врага сбоку, значит встал на него.
   */
  private resolveSolids(): void {
    for (const s of this.solids) {
      const penTop = this.bottom - s.y;
      const penBottom = s.y + s.h - this.top;
      const penLeft = this.right - s.x;
      const penRight = s.x + s.w - this.left;
      if (penTop <= 0 || penBottom <= 0 || penLeft <= 0 || penRight <= 0) continue;
      const topBias = penTop * 0.6;
      const best = Math.min(this.vy >= 0 ? topBias : Infinity, penBottom, penLeft, penRight);
      if (best === topBias && this.vy >= 0) {
        this.y -= penTop;
        this.vy = 0;
        this.grounded = true;
        this.ride = { key: s.key, x: s.x, y: s.y };
      } else if (best === penBottom) {
        this.y += penBottom;
        if (this.vy < 0) this.vy = 0;
      } else if (best === penLeft) {
        this.x -= penLeft;
        this.blockedX = 1;
      } else {
        this.x += penRight;
        this.blockedX = -1;
      }
    }
  }

  private resolveX(level: Level, ts: number): void {
    const [c0, c1, r0, r1] = this.cells(ts);
    const vx = this.vx; // направление запоминаем: vx обнуляется после первого столкновения
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (!level.isSolid(cx, cy)) continue;
        const center = this.x + this.offsetX + this.width / 2;
        const pushRight = vx < 0 || (vx === 0 && center > cx * ts + ts / 2);
        if (vx !== 0) this.blockedX = vx > 0 ? 1 : -1;
        this.x = pushRight ? (cx + 1) * ts - this.offsetX : cx * ts - this.width - this.offsetX;
        this.vx = 0;
      }
    }
  }

  private resolveY(level: Level, ts: number): void {
    const [c0, c1, r0, r1] = this.cells(ts);
    const falling = this.vy >= 0; // иначе, ударившись головой о несколько клеток подряд, герой «приземлялся» на платформу
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (!level.isSolid(cx, cy)) continue;
        if (falling) {
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
