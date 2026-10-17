import type { AnimatedSprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef } from '../data/types.ts';

/** Обычный враг: пока только внешность и расстановка (поведение по behavior_type — следующий шаг). */
export class Enemy {
  public readonly sprite: AnimatedSprite;

  constructor(public readonly def: EnemyDef, spawn: EnemySpawnDef, tileSize: number, sprites: SpriteLibrary) {
    if (!def.sprite_variants.includes(spawn.sprite_id)) {
      throw new Error(`[Enemy] спрайт "${spawn.sprite_id}" не входит в sprite_variants врага "${def.id}"`);
    }
    this.sprite = sprites.createAnimated(spawn.sprite_id);
    // Ноги — на нижней границе клетки спавна
    this.sprite.position.set((spawn.x + 0.5) * tileSize, (spawn.y + 1) * tileSize);
  }
}
