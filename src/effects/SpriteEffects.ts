import { Container } from 'pixi.js';
import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';

/** Эффект удара по врагу (fx_punch): лист из 4 кадров, нарисован направленным вправо — кольцо в точке попадания, лучи вперёд. */
export const PUNCH_FX = { sprite: 'fx_punch', animation: 'hit' } as const;
/** Клуб дыма (fx_smoke): 6 кадров, по центру — при отскоке от стены. */
export const SMOKE_FX = { sprite: 'fx_smoke', animation: 'puff' } as const;

export interface SpawnOptions {
  angle?: number; // поворот, рад (y вниз); для картинки, нарисованной вправо, это направление, куда «смотрят» лучи
  scale?: number; // размер относительно нарисованного
  vx?: number; // разлёт: скорость, px/с (затухает)
  vy?: number;
  speed?: number; // скорость проигрывания (1 — как нарисовано)
}

interface Playing {
  sprite: AnimatedSprite;
  vx: number;
  vy: number;
}

const DRIFT_DRAG = 2.5; // 1/с: разлёт постепенно гаснет

/** Покадровые эффекты из реестра спрайтов: проигрываются один раз и исчезают; можно повернуть, уменьшить и развести в стороны. */
export class SpriteEffects {
  public readonly container = new Container();
  private readonly playing: Playing[] = [];

  constructor(private readonly sprites: SpriteLibrary) {}

  public spawn(fx: { sprite: string; animation: string }, x: number, y: number, o: SpawnOptions = {}): void {
    const angle = o.angle ?? 0;
    const sprite = this.sprites.createAnimated(fx.sprite, fx.animation);
    const scale = o.scale ?? 1;
    sprite.position.set(x, y);
    sprite.rotation = angle;
    sprite.scale.set(scale, Math.cos(angle) < 0 ? -scale : scale); // повёрнутый влево эффект отражаем, чтобы он не оказался «вверх ногами» (свет сверху)
    if (o.speed) sprite.animationSpeed = o.speed;
    this.container.addChild(sprite);
    this.playing.push({ sprite, vx: o.vx ?? 0, vy: o.vy ?? 0 });
  }

  public update(dt: number): void {
    const k = Math.exp(-DRIFT_DRAG * dt);
    for (let i = this.playing.length - 1; i >= 0; i--) {
      const p = this.playing[i];
      if (!p.sprite.playing) {
        p.sprite.destroy();
        this.playing.splice(i, 1);
        continue;
      }
      p.vx *= k;
      p.vy *= k;
      p.sprite.x += p.vx * dt;
      p.sprite.y += p.vy * dt;
    }
  }
}
