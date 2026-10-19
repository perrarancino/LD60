import { Container, Graphics } from 'pixi.js';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';

const PITCH = 3; // px арта на один тайл карты (куб 2x2 и зазор 1 px)
const COLS = 40; // сколько тайлов видно по ширине (окно вокруг героя)
const ROWS = 22;
const MARGIN = 6; // отступ от края экрана
const PAD = 3;

/**
 * Миникарта слева сверху: прозрачная панель, на ней зелёными кубиками — стены тех клеток, которые герой уже видел (рампа pcb палитры),
 * бледными точками — увиденный воздух, мигающая точка — герой. Показывается окно COLS x ROWS тайлов вокруг героя. Если explored не задан
 * (отладка, уровень без тумана) — рисуется всё.
 */
export class Minimap {
  public readonly container = new Container();
  private readonly map = new Graphics();
  private readonly marker = new Graphics();
  private lastKey = '';
  private time = 0;

  constructor() {
    this.container.addChild(this.map, this.marker);
    this.container.position.set(MARGIN, MARGIN);
    this.container.visible = false;
  }

  public update(dt: number, level: Level, explored: Uint8Array | null, changed: boolean, hero: { x: number; y: number }): void {
    this.time += dt;
    const ts = level.tileSize;
    const hx = Math.floor(hero.x / ts);
    const hy = Math.floor(hero.y / ts);
    // окно: герой в центре, у краёв карты прижимается к границе
    const x0 = Math.max(0, Math.min(level.widthTiles - COLS, hx - Math.floor(COLS / 2)));
    const y0 = Math.max(0, Math.min(level.heightTiles - ROWS, hy - Math.floor(ROWS / 2)));
    const key = `${x0},${y0}`;
    if (key !== this.lastKey || changed) {
      this.lastKey = key;
      this.redraw(level, explored, x0, y0);
    }
    // герой: мигающий кубик
    const g = this.marker;
    g.clear();
    const mx = PAD + (hx - x0) * PITCH;
    const my = PAD + (hy - y0) * PITCH;
    const on = Math.floor(this.time * 3) % 2 === 0;
    g.rect(mx - 1, my - 1, 4, 4).fill({ color: pal('void', 0), alpha: 0.7 });
    g.rect(mx, my, 2, 2).fill(on ? pal('gold', 7) : pal('gold', 5));
  }

  private redraw(level: Level, explored: Uint8Array | null, x0: number, y0: number): void {
    const g = this.map;
    g.clear();
    const w = Math.min(COLS, level.widthTiles);
    const h = Math.min(ROWS, level.heightTiles);
    const pw = w * PITCH + PAD * 2;
    const ph = h * PITCH + PAD * 2;
    // панель: почти прозрачная, с тонкой зелёной рамкой
    g.rect(0, 0, pw, ph).fill({ color: pal('pcb', 0), alpha: 0.38 });
    g.rect(0, 0, pw, 1).fill({ color: pal('pcb', 4), alpha: 0.55 });
    g.rect(0, ph - 1, pw, 1).fill({ color: pal('pcb', 4), alpha: 0.55 });
    g.rect(0, 0, 1, ph).fill({ color: pal('pcb', 4), alpha: 0.55 });
    g.rect(pw - 1, 0, 1, ph).fill({ color: pal('pcb', 4), alpha: 0.55 });
    const body: number[] = [];
    const light: number[] = [];
    const air: number[] = [];
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const cx = x0 + tx;
        const cy = y0 + ty;
        if (explored && !explored[cy * level.widthTiles + cx]) continue;
        const px = PAD + tx * PITCH;
        const py = PAD + ty * PITCH;
        if (level.isSolid(cx, cy)) {
          body.push(px, py);
          light.push(px, py);
        } else {
          air.push(px, py);
        }
      }
    }
    for (let i = 0; i < air.length; i += 2) g.rect(air[i] + 1, air[i + 1] + 1, 1, 1);
    g.fill({ color: pal('pcb', 4), alpha: 0.22 });
    for (let i = 0; i < body.length; i += 2) g.rect(body[i], body[i + 1], 2, 2);
    g.fill({ color: pal('pcb', 5), alpha: 0.78 });
    for (let i = 0; i < light.length; i += 2) g.rect(light[i], light[i + 1], 1, 1);
    g.fill({ color: pal('pcb', 7), alpha: 0.85 }); // блик куба — верхний левый пиксель
  }
}
