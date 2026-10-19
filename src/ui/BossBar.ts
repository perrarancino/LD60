import { Container, Graphics } from 'pixi.js';
import { pal } from '../core/Palette.ts';
import type { Ramp } from '../core/Palette.ts';

const WIDTH = 170; // px арта
const HEIGHT = 5;

/**
 * Полоса здоровья босса: тонкая полоска по центру вверху экрана (в пикселях арта, поверх света и цветокоррекции, как цифры урона).
 * Рисуется, пока босс в бою; цвета — рампа палитры босса.
 */
export class BossBar {
  public readonly container = new Container();
  private readonly g = new Graphics();
  private shown = 0; // сглаженная доля (убывает плавно)

  constructor() {
    this.container.addChild(this.g);
    this.container.visible = false;
  }

  /** hp/max — здоровье; null — босса в бою нет. viewW — ширина видимой области (px арта). */
  public update(dt: number, boss: { hp: number; max: number } | null, viewW: number, ramp: Ramp): void {
    if (!boss) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;
    const target = Math.max(0, boss.hp / boss.max);
    this.shown += (target - this.shown) * (1 - Math.exp(-8 * dt));
    if (Math.abs(this.shown - target) < 0.002) this.shown = target;
    const w = Math.min(WIDTH, viewW - 40);
    const x = Math.round((viewW - w) / 2);
    const y = 8;
    const g = this.g;
    g.clear();
    g.rect(x - 1, y - 1, w + 2, HEIGHT + 2).fill(pal(ramp, 0));
    g.rect(x, y, w, HEIGHT).fill(pal(ramp, 1));
    const fill = Math.round(w * target);
    const ghost = Math.round(w * this.shown);
    if (ghost > fill) g.rect(x + fill, y, ghost - fill, HEIGHT).fill(pal(ramp, 3)); // недавно потерянное
    if (fill > 0) {
      g.rect(x, y, fill, HEIGHT).fill(pal(ramp, 4));
      g.rect(x, y, fill, 1).fill(pal(ramp, 6));
    }
  }
}
