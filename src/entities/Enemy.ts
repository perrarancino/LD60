import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, HitboxDef } from '../data/types.ts';
import type { Hittable, HitCircle } from './Hittable.ts';
import { HitReaction } from './HitReaction.ts';

const KNOCKBACK = 140; // px/с: отдача от удара

/** Обычный враг: пока только внешность и расстановка (поведение по behavior_type — следующий шаг). */
export class Enemy implements Hittable {
  public readonly sprite: AnimatedSprite;

  private readonly home: { x: number; y: number };
  private readonly hitbox: HitboxDef;
  private readonly react: HitReaction;

  constructor(public readonly def: EnemyDef, spawn: EnemySpawnDef, tileSize: number, sprites: SpriteLibrary) {
    if (!def.sprite_variants.includes(spawn.sprite_id)) {
      throw new Error(`[Enemy] спрайт "${spawn.sprite_id}" не входит в sprite_variants врага "${def.id}"`);
    }
    this.sprite = sprites.createAnimated(spawn.sprite_id);
    const sd = sprites.def(spawn.sprite_id);
    this.hitbox = sd.hitbox ?? { offset_x: 0, offset_y: 0, width: sd.frame_width, height: sd.frame_height };
    // Ноги — на нижней границе клетки спавна
    this.home = { x: (spawn.x + 0.5) * tileSize, y: (spawn.y + 1) * tileSize };
    this.sprite.position.set(this.home.x, this.home.y);
    this.react = new HitReaction(this.sprite);
  }

  public update(dt: number): void {
    this.react.update(dt);
    this.sprite.position.set(this.home.x + this.react.x, this.home.y + this.react.y);
  }

  /** Хитбокс спрайта, покрытый кругами по вертикали (враги высокие и узкие). */
  public hitCircles(): HitCircle[] {
    const hb = this.hitbox;
    const anchor = this.sprite.anchor;
    const left = this.sprite.x - this.sprite.width * anchor.x + hb.offset_x;
    const top = this.sprite.y - this.sprite.height * anchor.y + hb.offset_y;
    const r = Math.min(hb.width, hb.height) / 2;
    const cx = left + hb.width / 2;
    const circles: HitCircle[] = [];
    const span = Math.max(0, hb.height - 2 * r);
    const n = Math.max(1, Math.ceil(span / r) + 1);
    for (let i = 0; i < n; i++) {
      circles.push({ x: cx, y: top + r + (n === 1 ? span / 2 : (span * i) / (n - 1)), r });
    }
    return circles;
  }

  public onHit(dirX: number, dirY: number): void {
    this.react.trigger(dirX, dirY, KNOCKBACK);
  }
}
