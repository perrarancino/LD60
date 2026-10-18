import { ColorMatrixFilter } from 'pixi.js';
import type { Container } from 'pixi.js';

const FLASH_TIME = 0.09; // с: враг при ударе вспыхивает белым силуэтом
const KNOCK_SPRING = 520; // 1/с²: возврат отдачи в исходное положение
const KNOCK_DAMPING = 22; // 1/с: затухание отдачи

let flashFilter: ColorMatrixFilter | null = null;
/** Общий фильтр «белый силуэт»: цвет заменяется белым, прозрачность рисунка сохраняется. */
function whiteFlash(): ColorMatrixFilter {
  if (!flashFilter) {
    flashFilter = new ColorMatrixFilter();
    flashFilter.matrix = [
      0, 0, 0, 0, 1,
      0, 0, 0, 0, 1,
      0, 0, 0, 0, 1,
      0, 0, 0, 1, 0
    ];
  }
  return flashFilter;
}

/**
 * Реакция на удар: белая вспышка (на короткое время вешается фильтр) и упругая отдача — смещение (x, y), которое
 * владелец прибавляет к своей позиции, если хочет, чтобы цель отлетала от удара.
 */
export class HitReaction {
  /** Смещение отдачи, px (затухает к нулю). */
  public x = 0;
  public y = 0;

  private vx = 0;
  private vy = 0;
  private flash = 0;
  private flashing = false;

  /** targets — что вспыхивает (у червя — отдельные сегменты: на контейнере висит маска, и фильтр залил бы белым всю её область). */
  constructor(private readonly targets: Container | Container[]) {}

  /** knock — скорость отдачи, px/с (0 — только вспышка). */
  public trigger(dirX: number, dirY: number, knock = 0): void {
    this.flash = FLASH_TIME;
    this.vx += dirX * knock;
    this.vy += dirY * knock;
  }

  public update(dt: number): void {
    if (this.flash > 0) this.flash -= dt;
    const on = this.flash > 0;
    if (on !== this.flashing) {
      this.flashing = on;
      for (const t of Array.isArray(this.targets) ? this.targets : [this.targets]) t.filters = on ? [whiteFlash()] : null;
    }
    if (this.vx === 0 && this.vy === 0 && this.x === 0 && this.y === 0) return;
    const h = Math.min(dt, 1 / 30);
    this.vx += (-KNOCK_SPRING * this.x - KNOCK_DAMPING * this.vx) * h;
    this.vy += (-KNOCK_SPRING * this.y - KNOCK_DAMPING * this.vy) * h;
    this.x += this.vx * h;
    this.y += this.vy * h;
    if (Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.vx) + Math.abs(this.vy) < 0.05) this.x = this.y = this.vx = this.vy = 0;
  }
}
