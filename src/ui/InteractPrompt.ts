import { Graphics } from 'pixi.js';
import { pal } from '../core/Palette.ts';

/** Буква E в клавише: пиксельный узор 3x5 (1 — закрашено). */
const KEY_E = ['111', '100', '111', '100', '111'];

/** Подсказка «нажми E» над объектом: клавиша с золотой кромкой и стрелкой вниз; качается, пока видна. */
export class InteractPrompt {
  public readonly graphics = new Graphics();
  private time = Math.random() * 5;

  constructor(private readonly baseY: number) {
    const g = this.graphics;
    g.rect(-6, -6, 12, 12).fill(pal('steel', 0));
    g.rect(-5, -5, 10, 10).fill(pal('gold', 5));
    g.rect(-4, -4, 8, 8).fill(pal('steel', 1));
    KEY_E.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) if (row[rx] === '1') g.rect(-3 + rx * 2, -5 + ry * 2 + 1, 2, 2).fill(pal('gold', 7));
    });
    g.rect(-2, 6, 4, 1).fill(pal('gold', 5));
    g.rect(-1, 7, 2, 1).fill(pal('gold', 5));
    g.position.set(0, baseY);
    g.visible = false;
  }

  public update(dt: number, visible: boolean): void {
    this.time += dt;
    this.graphics.visible = visible;
    if (visible) this.graphics.y = this.baseY + Math.round(Math.sin(this.time * 4) * 1.5);
  }
}
