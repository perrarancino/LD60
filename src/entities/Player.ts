import type { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { InputState } from '../core/InputManager.ts';
import type { RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import { PlayerRig } from './PlayerRig.ts';
import type { ClimbPhase, ClimbPose } from './PlayerRig.ts';

const MAX_CLIMB_HEIGHT = 66; // на какую высоту герой может залезть (≈ 2 тайла), px
const CLIMB_COOLDOWN = 0.15;
const HANG_FEET = 38; // на сколько ниже уступа стоят ноги, когда руки уже достают до края, px
const HANG_PRESS = 10; // на сколько герой прижимается к стене в висе, px
const PHASE_DURATION: Record<ClimbPhase, number> = { jump: 0.26, hang: 0.08, pull: 0.3, mantle: 0.24 };
const PHASE_ORDER: ClimbPhase[] = ['jump', 'hang', 'pull', 'mantle'];

/** Залезание: подпрыгнуть к краю -> схватиться -> подтянуться -> перекатиться на уступ. */
interface Climb {
  phase: ClimbPhase;
  t: number; // время в текущей фазе
  dur: Record<ClimbPhase, number>;
  dir: 1 | -1;
  cornerX: number;
  cornerY: number;
  x0: number;
  xHang: number;
  x2: number;
  feet0: number; // низ хитбокса в начале
  feetHang: number;
  feetTop: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

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
      climb: this.climb ? this.climbPose(this.climb) : null
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

    // Если уступ выше, чем достают руки с земли, герой сначала подпрыгивает до «виса»
    const feet0 = b.bottom;
    const feetHang = Math.min(feet0, topY + HANG_FEET);
    const dur = { ...PHASE_DURATION };
    if (feetHang >= feet0) dur.jump = 0;
    this.climb = {
      phase: dur.jump > 0 ? 'jump' : 'hang', t: 0, dur, dir: dir > 0 ? 1 : -1,
      cornerX: wallFace, cornerY: topY,
      x0: b.x, xHang: b.x + dir * HANG_PRESS, x2,
      feet0, feetHang, feetTop: topY
    };
    this.face(this.climb.dir);
    b.vx = b.vy = 0;
  }

  private climbPose(c: Climb): ClimbPose {
    const total = PHASE_ORDER.reduce((sum, ph) => sum + c.dur[ph], 0);
    let before = 0;
    for (const ph of PHASE_ORDER) {
      if (ph === c.phase) break;
      before += c.dur[ph];
    }
    const d = c.dur[c.phase] || 1;
    return {
      phase: c.phase, t: Math.min(1, c.t / d), p: Math.min(1, (before + c.t) / total),
      cornerX: c.cornerX, cornerY: c.cornerY, dir: c.dir
    };
  }

  private updateClimb(dt: number): void {
    const c = this.climb!;
    const b = this.body;
    c.t += dt;
    // Переход к следующей фазе (фазы нулевой длины пропускаются)
    while (c.t >= c.dur[c.phase]) {
      const next = PHASE_ORDER[PHASE_ORDER.indexOf(c.phase) + 1];
      if (!next) {
        this.climb = null;
        this.climbCooldown = CLIMB_COOLDOWN;
        b.x = c.x2;
        b.y = b.yForFeet(c.feetTop);
        b.vx = b.vy = 0;
        b.grounded = true;
        return;
      }
      c.t -= c.dur[c.phase];
      c.phase = next;
    }

    const u = c.t / (c.dur[c.phase] || 1);
    let feet = c.feetHang;
    let x = c.xHang;
    switch (c.phase) {
      case 'jump': {
        // Приседание перед толчком, затем рывок вверх к краю
        const crouch = u < 0.2 ? 3 * Math.sin((Math.PI * u) / 0.2) : 0;
        const go = easeOutCubic(Math.max(0, (u - 0.2) / 0.8));
        feet = lerp(c.feet0, c.feetHang, go) + crouch;
        x = lerp(c.x0, c.xHang, smoothstep(0.2, 1, u));
        break;
      }
      case 'hang':
        // Повисел, слегка раскачиваясь
        x = lerp(c.dur.jump > 0 ? c.xHang : c.x0, c.xHang, smoothstep(0, 1, u));
        feet = c.feetHang + 1.2 * Math.sin(u * Math.PI);
        break;
      case 'pull':
        feet = lerp(c.feetHang, c.feetTop, smoothstep(0, 1, u));
        break;
      case 'mantle':
        feet = c.feetTop;
        x = lerp(c.xHang, c.x2, smoothstep(0, 1, u));
        break;
    }
    b.x = x;
    b.y = b.yForFeet(feet);
    b.vx = b.vy = 0;
  }
}
