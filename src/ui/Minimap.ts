import { Container, Graphics } from 'pixi.js';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';

const PITCH = 2; // px арта на тайл карты: стены сливаются в сплошной пиксельный рисунок
const COLS = 48; // сколько тайлов видно по ширине (окно вокруг героя)
const ROWS = 28;
const MARGIN = 6; // отступ от края экрана

/**
 * Миникарта слева сверху: пиксельная, без подложки и затемнений — только тонкая рамка, внутри зелёные пиксели стен (рампа pcb палитры) тех клеток,
 * которые герой уже видел; верхняя кромка стен ярче. Мигающий пиксель — герой. Окно COLS x ROWS тайлов плавно едет за героем (по пикселю, а не по тайлу).
 * Если explored не задан (отладка) — рисуется вся карта.
 */
export class Minimap {
  public readonly container = new Container();
  private readonly map = new Graphics();
  private readonly mask = new Graphics();
  private readonly frame = new Graphics();
  private readonly marker = new Graphics();
  private lastKey = '';
  private time = 0;

  constructor() {
    const w = COLS * PITCH;
    const h = ROWS * PITCH;
    this.mask.rect(0, 0, w, h).fill(0xffffff);
    this.map.mask = this.mask;
    this.frame.rect(-1, -1, w + 2, h + 2).stroke({ width: 1, color: pal('pcb', 5), alpha: 0.95, alignment: 1 });
    this.container.addChild(this.mask, this.map, this.frame, this.marker);
    this.container.position.set(MARGIN, MARGIN);
    this.container.visible = false;
  }

  public update(dt: number, level: Level, explored: Uint8Array | null, changed: boolean, hero: { x: number; y: number }): void {
    this.time += dt;
    const ts = level.tileSize;
    // начало окна в тайлах (дробное): герой в центре, у краёв карты окно прижимается
    const fx = Math.max(0, Math.min(level.widthTiles - COLS, hero.x / ts - COLS / 2));
    const fy = Math.max(0, Math.min(level.heightTiles - ROWS, hero.y / ts - ROWS / 2));
    const px = Math.round(fx * PITCH);
    const py = Math.round(fy * PITCH);
    const key = `${px},${py}`;
    if (key !== this.lastKey || changed) {
      this.lastKey = key;
      this.redraw(level, explored, px, py);
    }
    // герой: мигающий пиксель-куб
    const g = this.marker;
    g.clear();
    const mx = Math.round((hero.x / ts) * PITCH) - px;
    const my = Math.round((hero.y / ts) * PITCH) - py;
    const on = Math.floor(this.time * 3) % 2 === 0;
    g.rect(mx - 1, my - 1, 3, 3).fill(on ? 0xffffff : pal('gold', 6));
  }

  /** Рисует стены окна; (px, py) — смещение окна в пикселях карты. */
  private redraw(level: Level, explored: Uint8Array | null, px: number, py: number): void {
    const g = this.map;
    g.clear();
    const tx0 = Math.max(0, Math.floor(px / PITCH));
    const ty0 = Math.max(0, Math.floor(py / PITCH));
    const tx1 = Math.min(level.widthTiles - 1, tx0 + COLS + 1);
    const ty1 = Math.min(level.heightTiles - 1, ty0 + ROWS + 1);
    const seen = (x: number, y: number) => !explored || explored[y * level.widthTiles + x] === 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!seen(tx, ty) || !level.isSolid(tx, ty)) continue;
        g.rect(tx * PITCH - px, ty * PITCH - py, PITCH, PITCH);
      }
    }
    g.fill({ color: pal('pcb', 4) });
    // верхняя кромка стен ярче — рельеф читается без рамок и подложки
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!seen(tx, ty) || !level.isSolid(tx, ty) || level.isSolid(tx, ty - 1)) continue;
        g.rect(tx * PITCH - px, ty * PITCH - py, PITCH, 1);
      }
    }
    g.fill({ color: pal('pcb', 6) });
  }
}
