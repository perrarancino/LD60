import { Container, Sprite, Texture } from 'pixi.js';
import type { Level } from './Level.ts';

const CELL = 4; // px: клетка тумана (текстура растягивается с билинейным сглаживанием — края мягкие)
const INNER_R = 150; // px: ближе этого видно всё, что не закрыто стеной
const OUTER_R = 280; // px: дальше — темнота
const FORWARD_BONUS = 90; // px: в сторону взгляда героя видно дальше («то, что перед тобой»)
const RAYS = 720; // лучей обзора по кругу
const STEP = 8; // px: шаг луча
const WALL_DEPTH = 10; // px: на столько стену видно вглубь от луча (чтобы виднелась её поверхность)
const MEMORY = 0.78; // непрозрачность тумана над уже виденным, но сейчас невидимым (карта «помнится», но тёмная); над нетронутым — 1
const FADE = 9; // 1/с: насколько быстро клетка темнеет и светлеет (без мерцания на углах)

interface Vec {
  x: number;
  y: number;
}

/**
 * Туман войны. Герой видит то, что в прямой видимости и недалеко (вперёд по взгляду — дальше): лучи от глаз идут до первого твёрдого тайла, всё,
 * что ближе конца луча, видно. Увиденное запоминается и остаётся тёмным (MEMORY), нетронутое — чёрное. Клетки темнеют и светлеют плавно, а картинка
 * тумана — маленькая текстура, растянутая с интерполяцией, поэтому края света мягкие, без блоков.
 * Комнаты в тумане не участвуют. explored — карта увиденных тайлов (по ней рисуется миникарта).
 */
export class SightFog {
  public readonly container = new Container();
  /** Тайлы, которые герой уже видел (1 — видел): ширина × высота уровня. */
  public readonly explored: Uint8Array;
  public exploredChanged = false;

  private readonly gw: number;
  private readonly gh: number;
  private readonly w: number;
  private readonly ts: number;
  private readonly alpha: Float32Array; // туман в клетках мира
  private readonly seen: Uint8Array; // клетки, которые герой видел
  private readonly dists = new Float32Array(RAYS); // длина каждого луча до стены
  private readonly sprite = new Sprite();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private texture: Texture | null = null;

  constructor(private readonly level: Level) {
    this.w = level.widthTiles;
    this.ts = level.tileSize;
    this.gw = Math.ceil(level.pixelWidth / CELL);
    this.gh = Math.ceil(level.pixelHeight / CELL);
    this.explored = new Uint8Array(this.w * level.heightTiles);
    this.alpha = new Float32Array(this.gw * this.gh).fill(1);
    this.seen = new Uint8Array(this.gw * this.gh);
    this.container.addChild(this.sprite);
  }

  /** Лучи от глаз: длина каждого — до первого твёрдого тайла или до предела обзора. */
  private castRays(eye: Vec, facing: number): void {
    const ts = this.ts;
    const reach = OUTER_R + FORWARD_BONUS;
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const fwd = Math.max(0, dx * facing);
      const limit = OUTER_R + FORWARD_BONUS * fwd;
      let d = 0;
      for (; d < limit; d += STEP) {
        const cx = Math.floor((eye.x + dx * d) / ts);
        const cy = Math.floor((eye.y + dy * d) / ts);
        if (this.level.isSolid(cx, cy)) break;
      }
      this.dists[i] = Math.min(d, reach);
    }
  }

  /** Расстояние, до которого видно в направлении угла a (интерполяция между соседними лучами). */
  private rayAt(a: number): number {
    let t = (a / (Math.PI * 2)) * RAYS;
    t = ((t % RAYS) + RAYS) % RAYS;
    const i = Math.floor(t);
    const f = t - i;
    return this.dists[i] * (1 - f) + this.dists[(i + 1) % RAYS] * f;
  }

  /** Обновляет и рисует туман в области обзора (мир, px). eye — глаза героя; facing — куда он смотрит (1/−1). */
  public update(dt: number, camLeft: number, camTop: number, viewW: number, viewH: number, eye: Vec, facing: number): void {
    this.castRays(eye, facing);
    const c0 = Math.max(0, Math.floor(camLeft / CELL) - 1);
    const r0 = Math.max(0, Math.floor(camTop / CELL) - 1);
    const c1 = Math.min(this.gw - 1, Math.ceil((camLeft + viewW) / CELL) + 1);
    const r1 = Math.min(this.gh - 1, Math.ceil((camTop + viewH) / CELL) + 1);
    const w = c1 - c0 + 1;
    const h = r1 - r0 + 1;
    if (w <= 0 || h <= 0) return;
    this.ensureCanvas(w, h);
    const data = this.image!.data;
    const k = 1 - Math.exp(-FADE * dt);
    for (let r = r0; r <= r1; r++) {
      const cy = (r + 0.5) * CELL;
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * CELL;
        const dx = cx - eye.x;
        const dy = cy - eye.y;
        const dist = Math.hypot(dx, dy);
        const idx = r * this.gw + c;
        let target = this.seen[idx] ? MEMORY : 1;
        if (dist < OUTER_R + FORWARD_BONUS) {
          const ray = this.rayAt(Math.atan2(dy, dx));
          if (dist <= ray + WALL_DEPTH) {
            const fwd = dist > 0 ? Math.max(0, (dx / dist) * facing) : 0;
            const outer = OUTER_R + FORWARD_BONUS * fwd;
            const inner = INNER_R + FORWARD_BONUS * 0.5 * fwd;
            let a = dist <= inner ? 0 : Math.min(1, (dist - inner) / (outer - inner));
            a = a * a * (3 - 2 * a);
            if (a < 0.7) {
              if (!this.seen[idx]) {
                this.seen[idx] = 1;
                const tx = Math.floor(cx / this.ts);
                const ty = Math.floor(cy / this.ts);
                if (tx >= 0 && ty >= 0 && tx < this.w && ty * this.w + tx < this.explored.length && !this.explored[ty * this.w + tx]) {
                  this.explored[ty * this.w + tx] = 1;
                  this.exploredChanged = true;
                }
              }
            }
            target = Math.min(target, a);
          }
        }
        this.alpha[idx] += (target - this.alpha[idx]) * k;
        const o = ((r - r0) * w + (c - c0)) * 4;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = Math.round(this.alpha[idx] * 255);
      }
    }
    this.ctx!.putImageData(this.image!, 0, 0);
    this.texture!.source.update();
    this.sprite.position.set(c0 * CELL, r0 * CELL);
    this.sprite.width = w * CELL;
    this.sprite.height = h * CELL;
  }

  private ensureCanvas(w: number, h: number): void {
    if (this.canvas && this.canvas.width === w && this.canvas.height === h) return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(w, h);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = 'linear'; // растягивается плавно: мягкие края света
    this.sprite.texture = this.texture;
  }
}
