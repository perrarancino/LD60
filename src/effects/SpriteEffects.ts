import { Container } from 'pixi.js';
import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';

/** Эффект удара по врагу (fx_punch): лист из 4 кадров, нарисован направленным вправо — кольцо в точке попадания, лучи вперёд. */
export const PUNCH_FX = { sprite: 'fx_punch', animation: 'hit' } as const;
/** Клуб дыма (fx_smoke): 6 кадров, по центру — при отскоке от стены. */
export const SMOKE_FX = { sprite: 'fx_smoke', animation: 'puff' } as const;

/** Покадровые эффекты из реестра спрайтов: проигрываются один раз и исчезают; можно повернуть (например, по направлению удара). */
export class SpriteEffects {
  public readonly container = new Container();
  private readonly playing: AnimatedSprite[] = [];

  constructor(private readonly sprites: SpriteLibrary) {}

  /** angle — поворот, рад (y вниз); для картинки, нарисованной вправо, это направление, куда «смотрят» лучи. */
  public spawn(fx: { sprite: string; animation: string }, x: number, y: number, angle = 0): void {
    const sprite = this.sprites.createAnimated(fx.sprite, fx.animation);
    sprite.position.set(x, y);
    sprite.rotation = angle;
    if (Math.cos(angle) < 0) sprite.scale.y = -1; // повёрнутый влево эффект отражаем, чтобы он не оказался «вверх ногами» (свет сверху)
    this.container.addChild(sprite);
    this.playing.push(sprite);
  }

  public update(): void {
    for (let i = this.playing.length - 1; i >= 0; i--) {
      if (this.playing[i].playing) continue;
      this.playing[i].destroy();
      this.playing.splice(i, 1);
    }
  }
}
