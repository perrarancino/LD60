import type { Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { InputState } from '../core/InputManager.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';

/** Робот-герой: спрайт + физика платформера (бег, прыжок с coyote-time и jump-buffer). */
export class Player {
  public readonly sprite: Sprite;
  public readonly body = new Body();

  private readonly spriteDef;
  private facing: 1 | -1 = 1;
  private coyote = 0;
  private jumpBuffer = 0;

  constructor(spriteId: string, sprites: SpriteLibrary) {
    this.spriteDef = sprites.def(spriteId);
    this.sprite = sprites.createAnimated(spriteId);
    this.body.setHitbox(this.spriteDef, false);
  }

  /** Ставит героя ногами на нижнюю границу клетки (cellX, cellY). */
  public spawnAt(cellX: number, cellY: number, tileSize: number): void {
    this.body.x = (cellX + 0.5) * tileSize;
    this.body.y = (cellY + 1) * tileSize;
    this.body.vx = this.body.vy = 0;
  }

  public update(dt: number, input: InputState, level: Level): void {
    const b = this.body;

    if (input.horizontal !== 0 && input.horizontal !== this.facing) {
      this.facing = input.horizontal > 0 ? 1 : -1;
      this.sprite.scale.x = this.facing;
      b.setHitbox(this.spriteDef, this.facing < 0);
    }
    b.vx = input.horizontal * GAME_CONFIG.PLAYER_SPEED;

    this.coyote = b.grounded ? GAME_CONFIG.COYOTE_TIME_SEC : this.coyote - dt;
    this.jumpBuffer = input.jumpPressed ? GAME_CONFIG.JUMP_BUFFER_SEC : this.jumpBuffer - dt;

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      b.vy = GAME_CONFIG.JUMP_FORCE;
      this.jumpBuffer = this.coyote = 0;
    }
    // Короткий прыжок: отпустили кнопку на подъёме — гасим скорость
    if (!input.jumpHeld && b.vy < GAME_CONFIG.JUMP_FORCE * 0.4) {
      b.vy = GAME_CONFIG.JUMP_FORCE * 0.4;
    }

    b.vy += GAME_CONFIG.GRAVITY * dt;
    b.move(dt, level);

    this.sprite.position.set(Math.round(b.x), Math.round(b.y));
  }
}
