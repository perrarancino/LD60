import type { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { InputState } from '../core/InputManager.ts';
import type { RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import { PlayerRig } from './PlayerRig.ts';

const MAX_CLIMB_HEIGHT = 66; // на какую высоту герой может залезть (≈ 2 тайла), px
const CLIMB_COOLDOWN = 0.15;

interface Climb {
  t: number;
  duration: number;
  x0: number;
  y0: number;
  y1: number;
  x2: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Робот-герой: физика платформера (бег, прыжок с coyote-time и jump-buffer, залезание на преграды)
 * + процедурно анимированное тело (PlayerRig).
 */
export class Player {
  public readonly sprite: Container;
  public readonly body = new Body();

  private readonly rig: PlayerRig;
  private readonly spriteDef;
  private facing: 1 | -1 = 1;
  private coyote = 0;
  private jumpBuffer = 0;
  private climb: Climb | null = null;
  private climbCooldown = 0;

  constructor(spriteId: string, rigDef: RigDef, sprites: SpriteLibrary) {
    this.spriteDef = sprites.def(spriteId); // источник хитбокса
    this.rig = new PlayerRig(rigDef, sprites);
    this.sprite = this.rig.container;
    this.body.setHitbox(this.spriteDef, false);
  }

  /** Ставит героя ногами на нижнюю границу клетки (cellX, cellY). */
  public spawnAt(cellX: number, cellY: number, tileSize: number): void {
    this.body.x = (cellX + 0.5) * tileSize;
    this.body.y = (cellY + 1) * tileSize;
    this.body.vx = this.body.vy = 0;
  }

  /** aim — положение курсора в мире (null, пока мышь не двигали). */
  public update(dt: number, input: InputState, level: Level, aim: { x: number; y: number } | null): void {
    const b = this.body;
    this.climbCooldown -= dt;

    if (this.climb) {
      this.updateClimb(dt);
    } else {
      this.updateMovement(dt, input, level);
      if (this.climbCooldown <= 0 && input.horizontal !== 0) this.tryStartClimb(input.horizontal, level);
    }

    const headY = b.y - 40;
    this.rig.update(dt, {
      bodyX: b.x,
      bodyY: b.y,
      vx: b.vx,
      vy: b.vy,
      facing: this.facing,
      grounded: b.grounded,
      aimX: aim ? aim.x : b.x + this.facing * 100,
      aimY: aim ? aim.y : headY,
      climb: this.climb ? this.climb.t / this.climb.duration : null
    });
    this.sprite.position.set(b.x, b.y);
  }

  private face(dir: 1 | -1): void {
    if (dir === this.facing) return;
    this.facing = dir;
    this.body.setHitbox(this.spriteDef, dir < 0);
  }

  private updateMovement(dt: number, input: InputState, level: Level): void {
    const b = this.body;
    if (input.horizontal !== 0) this.face(input.horizontal > 0 ? 1 : -1);
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
  }

  /**
   * Герой упёрся в стену и жмёт в её сторону: если препятствие не выше MAX_CLIMB_HEIGHT и над ним есть место —
   * запускаем залезание (вверх вдоль стены, затем вперёд на верх препятствия).
   */
  private tryStartClimb(dir: number, level: Level): void {
    const b = this.body;
    if (b.blockedX !== dir) return;
    const ts = level.tileSize;

    const wallCol = Math.floor(((dir > 0 ? b.right : b.left) + dir * 0.5) / ts);
    let row = Math.floor((b.bottom - 1) / ts);
    if (!level.isSolid(wallCol, row)) return; // стена не на уровне ног — лезть некуда
    // (за границей уровня isSolid всегда true — без ограничения по ряду цикл был бы бесконечным)
    while (row > 0 && level.isSolid(wallCol, row - 1)) row--;

    const topY = row * ts;
    const rise = b.bottom - topY;
    if (rise <= 0 || rise > MAX_CLIMB_HEIGHT) return;

    const y1 = b.yForFeet(topY);
    const wallFace = dir > 0 ? wallCol * ts : (wallCol + 1) * ts;
    const x2 = b.xForCenter(wallFace + dir * (b.hitWidth / 2 + 1));
    // над препятствием должно хватить места и для подъёма, и для шага вперёд
    if (b.overlapsSolidAt(level, b.x, y1) || b.overlapsSolidAt(level, x2, y1)) return;

    this.climb = { t: 0, duration: 0.45 + 0.15 * (rise / ts), x0: b.x, y0: b.y, y1, x2 };
    b.vx = b.vy = 0;
  }

  private updateClimb(dt: number): void {
    const c = this.climb!;
    const b = this.body;
    c.t += dt;
    const p = Math.min(1, c.t / c.duration);
    b.y = lerp(c.y0, c.y1, smoothstep(0, 0.6, p));
    b.x = lerp(c.x0, c.x2, smoothstep(0.55, 1, p));
    b.vx = b.vy = 0;

    if (p >= 1) {
      this.climb = null;
      this.climbCooldown = CLIMB_COOLDOWN;
      b.grounded = true;
    }
  }
}
