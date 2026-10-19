import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Level } from './Level.ts';
import type { RoomMap } from './Rooms.ts';

const CELL = 8; // px: клетка тумана (текстура растягивается с билинейным сглаживанием — края мягкие)
const FADE_TIME = 0.7; // с: плавное открытие и закрытие комнаты
const HERO_R = 150; // px: мягкий круг света вокруг героя — в коридорах и у дверей видно, куда идёшь
const BLUR = 2; // проходов размытия 3x3 по клеткам: переход между открытой комнатой и тьмой мягкий, а не по границе тайла
const FOG_COLOR = 0x000000;

/**
 * Туман войны по комнатам: всё чёрное, кроме комнаты, где стоит герой (её тайлы и внутренности), и мягкого круга света вокруг героя (коридоры, проходы). Комната
 * открывается и закрывается плавно (FADE_TIME), а граница света размыта: туман рисуется маленькой текстурой (одна клетка = CELL px) с размытием
 * и билинейным растягиванием. explored — карта увиденных тайлов (комнаты, где герой был, и коридоры рядом с ним): по ней рисуется миникарта.
 */
export class RoomFog {
  public readonly container = new Container();
  public readonly explored: Uint8Array;
  public exploredChanged = false;

  private readonly outside = new Graphics();
  private readonly sprite = new Sprite();
  private readonly vis: Float32Array; // 0..1 по комнатам: насколько комната сейчас открыта
  private ready = false;
  private markedRooms = new Set<number>();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private texture: Texture | null = null;
  private buf: Float32Array = new Float32Array(0);
  private tmp: Float32Array = new Float32Array(0);

  constructor(private readonly level: Level, private readonly rooms: RoomMap) {
    this.vis = new Float32Array(rooms.defs.length);
    this.explored = new Uint8Array(level.widthTiles * level.heightTiles);
    this.container.addChild(this.sprite, this.outside);
  }

  /** Обновляет открытость комнат и перерисовывает туман в области обзора (мир, px). */
  public update(dt: number, camLeft: number, camTop: number, viewW: number, viewH: number, hero: { x: number; y: number }): void {
    const rooms = this.rooms;
    for (let i = 0; i < this.vis.length; i++) {
      const open = rooms.current.has(i);
      if (!this.ready) this.vis[i] = open ? 1 : 0;
      else this.vis[i] = Math.max(0, Math.min(1, this.vis[i] + (open ? dt : -dt) / FADE_TIME));
    }
    this.ready = true;
    this.markExplored(hero);

    const ts = this.level.tileSize;
    const gw = Math.ceil(this.level.pixelWidth / CELL);
    const gh = Math.ceil(this.level.pixelHeight / CELL);
    const c0 = Math.max(0, Math.floor(camLeft / CELL) - 1 - BLUR);
    const r0 = Math.max(0, Math.floor(camTop / CELL) - 1 - BLUR);
    const c1 = Math.min(gw - 1, Math.ceil((camLeft + viewW) / CELL) + 1 + BLUR);
    const r1 = Math.min(gh - 1, Math.ceil((camTop + viewH) / CELL) + 1 + BLUR);
    const w = c1 - c0 + 1;
    const h = r1 - r0 + 1;
    this.drawOutside(camLeft, camTop, viewW, viewH);
    if (w <= 0 || h <= 0) return;
    this.ensure(w, h);

    // непрозрачность тумана по клеткам (до размытия)
    const heroInCorridor = rooms.roomsAt(Math.floor(hero.x / ts), Math.floor(hero.y / ts)).length === 0; // круг света нужен только вне комнат
    const buf = this.buf;
    for (let r = 0; r < h; r++) {
      const cy = (r0 + r + 0.5) * CELL;
      const ty = Math.floor(cy / ts);
      for (let c = 0; c < w; c++) {
        const cx = (c0 + c + 0.5) * CELL;
        const at = rooms.roomsAt(Math.floor(cx / ts), ty);
        // всё чёрное, кроме комнаты героя; в коридорах между комнатами вокруг героя мягкий круг света (видно, куда идёшь)
        let open = 0;
        for (const k of at) if (this.vis[k] > open) open = this.vis[k];
        if (open < 1 && heroInCorridor) {
          const d = Math.hypot(cx - hero.x, cy - hero.y);
          if (d < HERO_R) open = Math.max(open, (1 - d / HERO_R) ** 0.7);
        }
        buf[r * w + c] = 1 - open;
      }
    }
    for (let p = 0; p < BLUR; p++) this.blur(w, h);

    const data = this.image!.data;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = Math.round(Math.min(1, Math.max(0, this.buf[i])) * 255);
    }
    this.ctx!.putImageData(this.image!, 0, 0);
    this.texture!.source.update();
    this.sprite.position.set(c0 * CELL, r0 * CELL);
    this.sprite.width = w * CELL;
    this.sprite.height = h * CELL;
  }

  /** Размытие 3x3 (края окна повторяются). */
  private blur(w: number, h: number): void {
    const src = this.buf;
    const dst = this.tmp;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const rr = Math.min(h - 1, Math.max(0, r + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const cc = Math.min(w - 1, Math.max(0, c + dx));
            sum += src[rr * w + cc];
          }
        }
        dst[r * w + c] = sum / 9;
      }
    }
    this.buf = dst;
    this.tmp = src;
  }

  private ensure(w: number, h: number): void {
    if (this.buf.length !== w * h) {
      this.buf = new Float32Array(w * h);
      this.tmp = new Float32Array(w * h);
    }
    if (this.canvas && this.canvas.width === w && this.canvas.height === h) return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(w, h);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = 'linear';
    this.sprite.texture = this.texture;
  }

  /** Чёрная рамка за пределами сетки уровня, если камера туда заглядывает. */
  private drawOutside(camLeft: number, camTop: number, viewW: number, viewH: number): void {
    const g = this.outside;
    g.clear();
    const L = this.level.pixelWidth;
    const B = this.level.pixelHeight;
    const left = camLeft - 32;
    const top = camTop - 32;
    const right = camLeft + viewW + 32;
    const bottom = camTop + viewH + 32;
    if (left < 0) g.rect(left, top, -left, bottom - top).fill({ color: FOG_COLOR });
    if (right > L) g.rect(L, top, right - L, bottom - top).fill({ color: FOG_COLOR });
    if (top < 0) g.rect(0, top, L, -top).fill({ color: FOG_COLOR });
    if (bottom > B) g.rect(0, B, L, bottom - B).fill({ color: FOG_COLOR });
  }

  /** Запоминает увиденное: тайлы комнат, где герой уже был, и коридоры (вне комнат) вокруг него. */
  private markExplored(hero: { x: number; y: number }): void {
    const ts = this.level.tileSize;
    const w = this.level.widthTiles;
    const h = this.level.heightTiles;
    for (const i of this.rooms.visited) {
      if (this.markedRooms.has(i)) continue;
      this.markedRooms.add(i);
      const def = this.rooms.defs[i];
      for (let y = Math.max(0, def.y); y < Math.min(h, def.y + def.height); y++) {
        for (let x = Math.max(0, def.x); x < Math.min(w, def.x + def.width); x++) {
          if (this.rooms.roomsAt(x, y).includes(i) && !this.explored[y * w + x]) {
            this.explored[y * w + x] = 1;
            this.exploredChanged = true;
          }
        }
      }
    }
    const hx = Math.floor(hero.x / ts);
    const hy = Math.floor(hero.y / ts);
    for (let y = Math.max(0, hy - 5); y <= Math.min(h - 1, hy + 5); y++) {
      for (let x = Math.max(0, hx - 7); x <= Math.min(w - 1, hx + 7); x++) {
        if (this.explored[y * w + x] || this.rooms.roomsAt(x, y).length > 0) continue;
        this.explored[y * w + x] = 1;
        this.exploredChanged = true;
      }
    }
  }
}
