import { Container, Sprite, Texture } from 'pixi.js';
import type { Level } from '../world/Level.ts';

/**
 * Что отбрасывает тень. drop — падающая тень: ищется поверхность под (x, y), тень лежит на ней и тает с высотой (герой, летящий паучок,
 * паучиха). surface — контактная тень на поверхности, по которой существо ползёт: (x, y) — точка контакта, (nx, ny) — нормаль от поверхности
 * (паук на полу, стене, потолке).
 */
export interface ShadowSpec {
  mode: 'drop' | 'surface';
  x: number;
  y: number;
  w: number; // ширина тени у поверхности, px
  nx?: number;
  ny?: number;
  strength?: number; // 0..1, по умолчанию 1
  maxDist?: number; // drop: на какой высоте тень пропадает, px (по умолчанию 56)
}

const MAX_ALPHA = 0.46; // меньше 0.5: тень не считается «объектом» освещением (там порог по прозрачности)
const OUTER = 0.6; // яркость внешнего кольца тени относительно ядра
const THICK = 0.3; // толщина тени относительно ширины
const MIN_THICK = 3; // px
const DEFAULT_DROP = 56;
const SINK = 1; // px: тень чуть утоплена в поверхность — лежит на верхних пикселях тайла

/**
 * Пиксельные тени под существами: ровные овалы в два тона (ядро и внешнее кольцо), размер кратен пикселю арта, лежат на поверхности под
 * персонажем. Падающая тень сужается и тает с высотой, контактная ложится вдоль стены/потолка. Спрайты берутся из пула; текстуры овалов
 * кэшируются по ширине.
 */
export class Shadows {
  public readonly container = new Container();
  private readonly pool: Sprite[] = [];
  private readonly textures = new Map<number, Texture>();
  private used = 0;

  constructor(private readonly level: Level) {}

  /** Овал нужной (чётной) ширины: ядро 100%, кольцо — OUTER. */
  private ovalTexture(width: number): Texture {
    let tex = this.textures.get(width);
    if (tex) return tex;
    const h = Math.max(MIN_THICK, Math.round(width * THICK));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x + 0.5 - width / 2) / (width / 2);
        const dy = (y + 0.5 - h / 2) / (h / 2);
        const d = dx * dx + dy * dy;
        const o = (y * width + x) * 4;
        const a = d <= 0.5 ? 1 : d <= 1 ? OUTER : 0;
        img.data[o] = 4; img.data[o + 1] = 8; img.data[o + 2] = 16; img.data[o + 3] = Math.round(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
    tex = Texture.from(canvas);
    tex.source.scaleMode = 'nearest';
    this.textures.set(width, tex);
    return tex;
  }

  private next(): Sprite {
    let s = this.pool[this.used];
    if (!s) {
      s = new Sprite();
      s.anchor.set(0.5);
      this.container.addChild(s);
      this.pool.push(s);
    }
    this.used++;
    s.visible = true;
    return s;
  }

  /** Раз в кадр: все тени этого кадра. */
  public update(specs: readonly ShadowSpec[]): void {
    this.used = 0;
    for (const sp of specs) {
      const strength = sp.strength ?? 1;
      let x = sp.x;
      let y = sp.y;
      let w = sp.w;
      let rot = 0;
      let alpha = strength;
      if (sp.mode === 'drop') {
        const ground = this.level.groundBelow(sp.x, sp.y, sp.maxDist ?? DEFAULT_DROP);
        if (ground === null) continue;
        const t = 1 - Math.max(0, ground - sp.y) / (sp.maxDist ?? DEFAULT_DROP);
        if (t <= 0.02) continue;
        alpha *= t;
        w *= 0.5 + 0.5 * t; // чем выше — тем меньше и бледнее
        y = ground + SINK;
      } else {
        const nx = sp.nx ?? 0;
        const ny = sp.ny ?? -1;
        const inset = Math.max(MIN_THICK, Math.round(Math.max(6, Math.round(w / 2) * 2) * THICK)) / 2 - 0.5; // полтолщины тени уходит в поверхность
        x = sp.x - nx * inset;
        y = sp.y - ny * inset;
        rot = Math.atan2(nx, -ny); // овал лежит вдоль поверхности: пол — горизонтально, стена — вертикально
      }
      const width = Math.max(6, Math.round(w / 2) * 2);
      const s = this.next();
      s.texture = this.ovalTexture(width);
      s.alpha = MAX_ALPHA * Math.max(0, Math.min(1, alpha));
      s.rotation = rot;
      // центр овала — на целый пиксель (кратные 90° повороты остаются чёткими)
      const h = s.texture.height;
      s.position.set(Math.round(x), Math.round(y + (sp.mode === 'drop' ? h / 2 - 1 : 0)));
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}
