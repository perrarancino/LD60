import { Container, FillGradient, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { BackgroundDef } from '../data/types.ts';

interface Layer {
  sprite: TilingSprite;
  parallaxX: number;
  parallaxY: number;
  height: number; // высота слоя на экране, виртуальные px
}

interface Mote {
  sprite: Sprite;
  armH: Sprite; // «лучики» вокруг частицы (пиксельное свечение-крестик)
  armV: Sprite;
  x: number;
  y: number;
  vy: number; // подъём, px/с
  sway: number; // амплитуда качания, px
  swaySpeed: number;
  phase: number;
}

const rng = (seed: number) => () => {
  // mulberry32: детерминированный генератор, чтобы частицы не «перетасовывались» при изменении окна
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Параллакс-фон из зацикленных по горизонтали слоёв (data/backgrounds/*.json):
 *  - градиент неба сверху, светящиеся частицы над землёй;
 *  - каждый слой сдвигается на долю сдвига камеры по X: дальние почти стоят, ближние идут почти вместе с миром
 *    (слои с parallax_x = 0, например туман/дымка, неподвижны);
 *  - по вертикали слои сдвигаются на parallax_y (0 — жёстко приклеены к экрану, слои не расходятся);
 *  - стыки тайлов скрыты: слои с mirror тайлятся зеркально (края всегда совпадают), у слоёв с crop_left отрезается
 *    «битый» левый столбец;
 *  - под нижним краем фона — заливка ground_color до низа экрана.
 */
export class ParallaxBackground {
  public readonly container = new Container();

  private sky = new Graphics();
  private layerLayer = new Container();
  private groundFill = new Graphics();
  private moteLayer = new Container();

  private layers: Layer[] = [];
  private motes: Mote[] = [];
  private random = rng(1337);

  private viewW = 0;
  private viewH = 0;
  private time = 0;

  /** Спрайты слоёв должны быть уже загружены (SpriteLibrary.load). */
  public static spriteIds(def: BackgroundDef): string[] {
    return def.layers.map((l) => l.sprite_id);
  }

  constructor(private readonly def: BackgroundDef, sprites: SpriteLibrary) {
    this.container.addChild(this.sky, this.layerLayer, this.groundFill, this.moteLayer);
    for (const l of def.layers) {
      const texture = this.layerTexture(sprites, l.sprite_id, l.crop_left ?? 0, l.mirror ?? false);
      const sprite = new TilingSprite({ texture, width: 1, height: texture.height * def.scale });
      sprite.tileScale.set(def.scale);
      this.layerLayer.addChild(sprite);
      this.layers.push({ sprite, parallaxX: l.parallax_x, parallaxY: l.parallax_y, height: texture.height * def.scale });
    }
  }

  /**
   * Текстура слоя для тайлинга: можно отрезать левые столбцы (crop_left) и/или склеить картинку с её зеркальной копией,
   * чтобы правый край каждого тайла совпадал с левым краем следующего.
   */
  private layerTexture(sprites: SpriteLibrary, id: string, cropLeft: number, mirror: boolean): Texture {
    if (cropLeft === 0 && !mirror) return sprites.texture(id);

    const src = sprites.imageData(id);
    const w = src.width - cropLeft;
    const h = src.height;
    const base = document.createElement('canvas');
    base.width = src.width;
    base.height = h;
    base.getContext('2d')!.putImageData(src, 0, 0);

    const canvas = document.createElement('canvas');
    canvas.width = mirror ? w * 2 : w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(base, cropLeft, 0, w, h, 0, 0, w, h);
    if (mirror) {
      ctx.save();
      ctx.translate(w * 2, 0);
      ctx.scale(-1, 1); // зеркальная копия справа от оригинала
      ctx.drawImage(base, cropLeft, 0, w, h, 0, 0, w, h);
      ctx.restore();
    }
    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    return texture;
  }

  /** Размер видимой области (виртуальные px) изменился. */
  public resize(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    for (const l of this.layers) l.sprite.width = viewW;

    // Небо: градиент от верха к sky_color у горизонта (там, где начинаются слои)
    const maxLayerH = Math.max(...this.layers.map((l) => l.height));
    const horizon = Math.max(32, viewH - maxLayerH - (this.def.ground_offset ?? 0));
    const top = this.def.effects?.sky_top_color ?? this.def.sky_color;
    const end = Math.min(1, (horizon + maxLayerH * 0.35) / viewH);
    const gradient = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: top },
        { offset: end, color: this.def.sky_color },
        { offset: 1, color: this.def.sky_color }
      ],
      textureSpace: 'local'
    });
    this.sky.clear().rect(0, 0, viewW, viewH).fill(gradient);

    this.buildMotes();
  }

  private buildMotes(): void {
    this.moteLayer.removeChildren().forEach((c) => c.destroy());
    this.motes = [];
    const fx = this.def.effects?.motes;
    if (!fx) return;
    const rand = rng(21);
    const count = Math.round(this.viewW * this.viewH * fx.density);
    for (let i = 0; i < count; i++) {
      const color = fx.colors[Math.floor(rand() * fx.colors.length)];
      const size = rand() < 0.35 ? 3 : 2;
      const mk = (w: number, h: number) => {
        const sp = new Sprite(Texture.WHITE);
        sp.width = w;
        sp.height = h;
        sp.tint = color;
        sp.blendMode = 'add'; // свечение складывается с фоном
        return sp;
      };
      const sprite = mk(size, size);
      const armH = mk(size + 4, 1);
      const armV = mk(1, size + 4);
      this.moteLayer.addChild(armH, armV, sprite);
      this.motes.push({
        sprite, armH, armV, x: rand() * this.viewW, y: rand() * this.viewH, vy: 4 + rand() * 12,
        sway: 2 + rand() * 6, swaySpeed: 0.4 + rand() * 1.1, phase: rand() * Math.PI * 2
      });
    }
  }

  /**
   * @param camX, camY положение камеры в мире (левый верхний угол видимой области)
   * @param maxCamY положение камеры, когда она внизу уровня
   * @param pixelScale физических пикселей на виртуальный — сдвиги выравниваются по ним, чтобы пиксели не «плыли»
   * @param dt шаг времени, с (0 — только пересчитать положения)
   */
  public update(camX: number, camY: number, maxCamY: number, pixelScale: number, dt = 0): void {
    this.time += dt;
    const snap = (v: number) => Math.round(v * pixelScale) / pixelScale;

    for (const l of this.layers) {
      l.sprite.tilePosition.x = snap(-camX * l.parallaxX);
      l.sprite.y = snap(this.viewH - l.height - (this.def.ground_offset ?? 0) + (maxCamY - camY) * l.parallaxY);
    }

    // Земля: под нижним краем ближнего слоя заливаем до низа экрана, чтобы на верхних платформах под фоном не было пустоты
    const groundColor = this.def.ground_color;
    this.groundFill.clear();
    if (groundColor && this.layers.length > 0) {
      const front = this.layers[this.layers.length - 1];
      const top = Math.floor(front.sprite.y + front.height) - 1;
      if (top < this.viewH) this.groundFill.rect(0, top, this.viewW, this.viewH - top + 4).fill(groundColor);
    }

    this.updateMotes(dt, camX, camY - maxCamY);
  }

  private updateMotes(dt: number, camX: number, camDy: number): void {
    const fx = this.def.effects?.motes;
    if (!fx) return;
    const w = this.viewW;
    const top = this.viewH * 0.45; // частицы живут в нижней части экрана (над землёй), выше — только небо
    for (const m of this.motes) {
      m.y -= m.vy * dt;
      if (m.y < top) { m.y = this.viewH + this.random() * 20; m.x = this.random() * w; }
      const x = (((m.x + Math.sin(this.time * m.swaySpeed + m.phase) * m.sway - camX * fx.parallax) % w) + w) % w;
      const px = Math.floor(x);
      const py = Math.floor(m.y - camDy * 0.1);
      m.sprite.position.set(px, py);
      const sz = m.sprite.width;
      m.armH.position.set(px - 2, py + Math.floor(sz / 2));
      m.armV.position.set(px + Math.floor(sz / 2), py - 2);
      // пульс + плавное появление у нижнего края и затухание у верхнего
      const edge = Math.min(1, (this.viewH - m.y) / 24, (m.y - top) / 40);
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 1.8 + m.phase * 3);
      const a = Math.max(0, edge) * pulse;
      m.sprite.alpha = a;
      m.armH.alpha = m.armV.alpha = a * 0.4;
    }
  }
}
