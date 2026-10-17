import { Container, Graphics, Texture, TilingSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { BackgroundDef } from '../data/types.ts';

interface Layer {
  sprite: TilingSprite;
  parallaxX: number;
  height: number; // высота слоя на экране, виртуальные px
}

/**
 * Параллакс-фон из зацикленных по горизонтали слоёв (data/backgrounds/*.json). Только рисунок художника, без эффектов.
 *  - по X каждый слой сдвигается на долю сдвига камеры (parallax_x): дальние почти стоят, ближние идут почти вместе с миром;
 *    слои с parallax_x = 0 (небо, туман) неподвижны;
 *  - по Y фон жёстко приклеен к экрану: при прыжках и подъёме камеры он не двигается и слои не расходятся;
 *  - стыки тайлов скрыты: mirror — зеркальный тайлинг (края совпадают), crop_left — отрезать «битый» левый столбец;
 *  - выше слоёв — заливка sky_color, ниже нижнего края — заливка ground_color до низа экрана.
 */
export class ParallaxBackground {
  public readonly container = new Container();

  private sky = new Graphics();
  private layerLayer = new Container();
  private groundFill = new Graphics();

  private layers: Layer[] = [];

  /** Спрайты слоёв должны быть уже загружены (SpriteLibrary.load). */
  public static spriteIds(def: BackgroundDef): string[] {
    return def.layers.map((l) => l.sprite_id);
  }

  constructor(private readonly def: BackgroundDef, sprites: SpriteLibrary) {
    this.container.addChild(this.sky, this.layerLayer, this.groundFill);
    for (const l of def.layers) {
      const texture = this.layerTexture(sprites, l.sprite_id, l.crop_left ?? 0, l.mirror ?? false);
      const sprite = new TilingSprite({ texture, width: 1, height: texture.height * def.scale });
      sprite.tileScale.set(def.scale);
      this.layerLayer.addChild(sprite);
      this.layers.push({ sprite, parallaxX: l.parallax_x, height: texture.height * def.scale });
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
    this.sky.clear().rect(0, 0, viewW, viewH).fill(this.def.sky_color);

    // Слои стоят у нижнего края экрана (приподняты на ground_offset) и больше не двигаются по вертикали
    const baseY = Math.round(viewH - (this.def.ground_offset ?? 0));
    for (const l of this.layers) {
      l.sprite.width = viewW;
      l.sprite.y = baseY - l.height;
    }
    const front = this.layers[this.layers.length - 1];
    this.groundFill.clear();
    if (this.def.ground_color && front) {
      const top = front.sprite.y + front.height - 1;
      if (top < viewH) this.groundFill.rect(0, top, viewW, viewH - top + 4).fill(this.def.ground_color);
    }
  }

  /**
   * @param camX положение камеры по X
   * @param pixelScale физических пикселей на виртуальный — сдвиги выравниваются по ним, чтобы пиксели не «плыли»
   */
  public update(camX: number, pixelScale: number): void {
    const snap = (v: number) => Math.round(v * pixelScale) / pixelScale;
    for (const l of this.layers) l.sprite.tilePosition.x = snap(-camX * l.parallaxX);
  }
}
