import { Container } from 'pixi.js';
import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';

/** Id спрайта эффекта удара: лист из 4 кадров, нарисован направленным вправо (кольцо — в точке попадания, лучи — вперёд). */
export const PUNCH_FX_SPRITE = 'fx_punch';

/** Эффект попадания: проигрывается один раз и исчезает; разворачивается по направлению удара. */
export class PunchEffects {
  public readonly container = new Container();
  private readonly playing: AnimatedSprite[] = [];

  constructor(private readonly sprites: SpriteLibrary) {}

  /** angle — направление удара, рад (y вниз): картинка повёрнута так, чтобы лучи шли по удару. */
  public spawn(x: number, y: number, angle: number): void {
    const fx = this.sprites.createAnimated(PUNCH_FX_SPRITE, 'hit');
    fx.position.set(x, y);
    fx.rotation = angle;
    if (Math.cos(angle) < 0) fx.scale.y = -1; // удар влево: отражаем, чтобы эффект не оказался «вверх ногами» (свет сверху)
    this.container.addChild(fx);
    this.playing.push(fx);
  }

  public update(): void {
    for (let i = this.playing.length - 1; i >= 0; i--) {
      if (this.playing[i].playing) continue;
      this.playing[i].destroy();
      this.playing.splice(i, 1);
    }
  }
}
