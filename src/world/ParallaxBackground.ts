import { Container, Graphics, TilingSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { BackgroundDef } from '../data/types.ts';

interface Layer {
  sprite: TilingSprite;
  parallaxX: number;
  parallaxY: number;
  height: number; // высота слоя на экране, виртуальные px
}

/**
 * Параллакс-фон из зацикленных по горизонтали слоёв (data/backgrounds/*.json).
 * Каждый слой сдвигается на долю сдвига камеры: дальние почти стоят, ближние идут почти вместе с миром.
 * По вертикали слои прижаты к низу экрана (в нижней точке уровня) и слегка «плывут» при подъёме камеры;
 * то, что слои не закрывают сверху, заливается sky_color.
 */
export class ParallaxBackground {
  public readonly container = new Container();

  private sky = new Graphics();
  private layers: Layer[] = [];
  private viewH = 0;

  /** Спрайты слоёв должны быть уже загружены (SpriteLibrary.load). */
  public static spriteIds(def: BackgroundDef): string[] {
    return def.layers.map((l) => l.sprite_id);
  }

  constructor(private readonly def: BackgroundDef, sprites: SpriteLibrary) {
    this.container.addChild(this.sky);
    for (const l of def.layers) {
      const texture = sprites.texture(l.sprite_id);
      const sprite = new TilingSprite({ texture, width: 1, height: texture.height * def.scale });
      sprite.tileScale.set(def.scale);
      this.container.addChild(sprite);
      this.layers.push({ sprite, parallaxX: l.parallax_x, parallaxY: l.parallax_y, height: texture.height * def.scale });
    }
  }

  /** Размер видимой области (виртуальные px) изменился. */
  public resize(viewW: number, viewH: number): void {
    this.viewH = viewH;
    this.sky.clear().rect(0, 0, viewW, viewH).fill(this.def.sky_color);
    for (const l of this.layers) l.sprite.width = viewW;
  }

  /**
   * @param camX, camY положение камеры в мире (левый верхний угол видимой области)
   * @param maxCamY положение камеры, когда она внизу уровня: там слои стоят у нижнего края экрана
   * @param pixelScale физических пикселей на виртуальный — сдвиги выравниваются по ним, чтобы пиксели не «плыли»
   */
  public update(camX: number, camY: number, maxCamY: number, pixelScale: number): void {
    const snap = (v: number) => Math.round(v * pixelScale) / pixelScale;
    for (const l of this.layers) {
      l.sprite.tilePosition.x = snap(-camX * l.parallaxX);
      l.sprite.y = snap(this.viewH - l.height + (maxCamY - camY) * l.parallaxY);
    }
  }
}
