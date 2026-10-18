import type { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { InputState } from '../core/InputManager.ts';
import type { RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { SolidBox } from './Hittable.ts';
import { Body } from './Body.ts';
import { PlayerRig, PUNCH_DURATION } from './PlayerRig.ts';
import type { ClimbPhase, ClimbPose, PunchPose } from './PlayerRig.ts';

const MAX_CLIMB_HEIGHT = 66; // на какую высоту герой может залезть (≈ 2 тайла), px
const CLIMB_COOLDOWN = 0.15;
const WALL_SLIDE_SPEED = 70; // макс. скорость падения при скольжении по стене, px/с
const WALL_JUMP_PUSH = 170; // начальный толчок от стены по горизонтали, px/с (чуть быстрее бега — плавный «вынос» вперёд)
const WALL_JUMP_VY = 0.95; // доля силы обычного прыжка
const WALL_JUMP_COOLDOWN = 0.28; // с: пауза между прыжками от стены (не чаще)
const KICK_DURATION = 0.45; // с: длительность позы отталкивания от стены
const WALL_COYOTE = 0.1; // с: прыжок от стены возможен сразу после потери контакта с ней
const AIR_ACCEL = 900; // px/с²: управляемость в воздухе после прыжка от стены
const AIR_DRAG = 260; // px/с²: плавное торможение без ввода
const HANG_FEET = 38; // на сколько ниже уступа стоят ноги, когда руки уже достают до края, px
const HANG_PRESS = 10; // на сколько герой прижимается к стене в висе, px
const PHASE_DURATION: Record<ClimbPhase, number> = { jump: 0.26, hang: 0.08, pull: 0.3, mantle: 0.24 };
const PHASE_ORDER: ClimbPhase[] = ['jump', 'hang', 'pull', 'mantle'];
const WALL_KICK_FX_HEIGHT = 26; // на какой высоте над ногами у стены появляется дым отскока, px
const PUNCH_COOLDOWN = 0.26; // с: пауза между ударами (от начала предыдущего)
const PUNCH_BUFFER = 0.12; // с: нажатие чуть раньше конца паузы не теряется
const PUNCH_CHEST = 31; // на сколько выше ног плечи, px: от них считается направление удара

/** Удар в мире: от плеча к кулаку; id растёт с каждым ударом (чтобы один удар засчитывался врагу один раз). */
export interface Strike {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dirX: number;
  dirY: number;
}

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
  /** Вызывается при прыжке от стены: точка касания стены (мир) и сторона стены — для эффекта дыма. */
  public onWallKick: ((x: number, y: number, wallDir: -1 | 1) => void) | null = null;

  private readonly rig: PlayerRig;
  private readonly spriteDef;
  private facing: 1 | -1 = 1;
  private coyote = 0;
  private jumpBuffer = 0;
  private climb: Climb | null = null;
  private climbCooldown = 0;
  private wallDir: -1 | 0 | 1 = 0; // последняя стена, с которой был контакт
  private wallCoyote = 0;
  private wallJumpCd = 0; // пауза между прыжками от стены, с
  private kickT = 0; // оставшееся время позы отталкивания от стены
  private airSteer = false; // после прыжка от стены скорость по X меняется плавно и управляется
  private sliding: -1 | 0 | 1 = 0; // сейчас скользит по стене (сторона)
  private wallX = 0;
  private punchT = -1; // время от начала удара, с; < 0 — не бьёт
  private punchCd = 0;
  private punchBuffer = 0;
  private punchId = 0;
  private punchDir = { x: 1, y: 0 };
  private punchArm: 1 | -1 = -1;

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
  public update(
    dt: number, input: InputState, level: Level, aim: { x: number; y: number } | null, solids: readonly SolidBox[] = []
  ): void {
    const b = this.body;
    b.solids = solids;
    this.climbCooldown -= dt;
    this.kickT = this.climb || b.grounded ? 0 : Math.max(0, this.kickT - dt);

    if (this.climb) {
      this.updateClimb(dt);
    } else {
      this.updateMovement(dt, input, level);
      if (!this.climb && this.climbCooldown <= 0 && input.horizontal !== 0 && b.blockedX === input.horizontal) {
        const plan = this.planClimb(input.horizontal, level);
        if (plan) this.beginClimb(plan);
      }
    }

    this.updatePunch(dt, input, aim);

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
      climb: this.climb ? this.climbPose(this.climb) : null,
      kick: this.kickT > 0 ? 1 - this.kickT / KICK_DURATION : null,
      wall: this.sliding,
      wallX: this.wallX,
      punch: this.punchT >= 0 ? this.punchPose() : null
    });
    this.sprite.position.set(b.x, b.y);
  }

  /**
   * Удар в мире, пока кулак выброшен и может попасть (иначе null). Руку выбирает сам удар: бьёт та, что ближе к цели.
   * Читать после update().
   */
  public get strike(): Strike | null {
    const f = this.rig.fist;
    if (this.punchT < 0 || !f.active) return null;
    return { id: this.punchId, x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, dirX: this.punchDir.x, dirY: this.punchDir.y };
  }

  private punchPose(): PunchPose {
    return { time: this.punchT, dirX: this.punchDir.x, dirY: this.punchDir.y, arm: this.punchArm };
  }

  /** Удар по кнопке атаки: в сторону курсора бьёт ближайшая к нему рука. Во время залезания не бьём. */
  private updatePunch(dt: number, input: InputState, aim: { x: number; y: number } | null): void {
    this.punchCd -= dt;
    this.punchBuffer = input.attackPressed ? PUNCH_BUFFER : this.punchBuffer - dt;
    if (this.punchT >= 0) {
      this.punchT += dt;
      if (this.punchT >= PUNCH_DURATION) this.punchT = -1;
    }
    if (this.climb || this.punchBuffer <= 0 || this.punchCd > 0) return;

    const b = this.body;
    let dx = aim ? aim.x - b.x : this.facing;
    let dy = aim ? aim.y - (b.y - PUNCH_CHEST) : 0;
    let len = Math.hypot(dx, dy);
    if (len < 6) { dx = this.facing; dy = 0; len = 1; } // курсор прямо у плеч — бьём вперёд
    this.punchDir = { x: dx / len, y: dy / len };
    // сторона рига: рука на экране справа от героя (мир) — side -1 при взгляде вправо, и наоборот
    this.punchArm = (dx >= 0 ? -this.facing : this.facing) as 1 | -1;
    this.punchT = 0;
    this.punchCd = PUNCH_COOLDOWN;
    this.punchBuffer = 0;
    this.punchId++;
  }

  private face(dir: 1 | -1): void {
    if (dir === this.facing) return;
    this.facing = dir;
    this.body.setHitbox(this.spriteDef, dir < 0);
  }

  private updateMovement(dt: number, input: InputState, level: Level): void {
    const b = this.body;

    // Контакт со стеной (только в воздухе)
    const contact = b.grounded ? 0 : b.wallContact(level, input.horizontal);
    if (contact !== 0) {
      this.wallDir = contact;
      this.wallCoyote = WALL_COYOTE;
    } else {
      this.wallCoyote -= dt;
    }
    this.wallJumpCd -= dt;

    if (input.horizontal !== 0) this.face(input.horizontal > 0 ? 1 : -1);
    const targetVx = input.horizontal * GAME_CONFIG.PLAYER_SPEED;
    if (this.airSteer && !b.grounded) {
      // Скорость плавно подстраивается под ввод: после прыжка от стены героя можно вести в любую сторону
      const accel = (input.horizontal !== 0 ? AIR_ACCEL : AIR_DRAG) * dt;
      b.vx += Math.max(-accel, Math.min(accel, targetVx - b.vx));
    } else {
      this.airSteer = false;
      b.vx = targetVx;
    }

    this.coyote = b.grounded ? GAME_CONFIG.COYOTE_TIME_SEC : this.coyote - dt;
    this.jumpBuffer = input.jumpPressed ? GAME_CONFIG.JUMP_BUFFER_SEC : this.jumpBuffer - dt;

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      b.vy = GAME_CONFIG.JUMP_FORCE;
      this.jumpBuffer = this.coyote = 0;
    } else if (this.jumpBuffer > 0 && !b.grounded && this.wallCoyote > 0 && this.wallDir !== 0) {
      // Прыжок у стены: если можно залезть — лезем, иначе прыжок от стены
      const plan = contact !== 0 && !this.climbBlocked() ? this.planClimb(contact, level) : null;
      if (plan) {
        this.beginClimb(plan);
        this.jumpBuffer = 0;
        return;
      }
      if (this.wallJumpCd <= 0) this.wallJump();
    }
    // Короткий прыжок: отпустили кнопку на подъёме — гасим скорость
    if (!input.jumpHeld && b.vy < GAME_CONFIG.JUMP_FORCE * 0.4) {
      b.vy = GAME_CONFIG.JUMP_FORCE * 0.4;
    }

    b.vy += GAME_CONFIG.GRAVITY * dt;

    // Скольжение по стене: жмёмся к ней в падении — падаем медленно, лицом к стене
    this.sliding = 0;
    if (contact !== 0 && input.horizontal === contact && b.vy > 0) {
      this.sliding = contact;
      b.vy = Math.min(b.vy, WALL_SLIDE_SPEED);
      this.face(contact);
      const ts = level.tileSize;
      this.wallX = contact > 0 ? Math.floor((b.right + 0.6) / ts) * ts : (Math.floor((b.left - 0.6) / ts) + 1) * ts;
    }

    b.move(dt, level);
  }

  /** Кулдаун после предыдущего залезания не прошёл. */
  private climbBlocked(): boolean {
    return this.climbCooldown > 0;
  }

  /**
   * План залезания на препятствие со стороны dir: если оно не выше MAX_CLIMB_HEIGHT и над ним есть место — возвращает
   * параметры залезания (вверх вдоль стены, затем вперёд на верх), иначе null. Ничего не меняет.
   */
  private planClimb(dir: number, level: Level): Climb | null {
    const b = this.body;
    const ts = level.tileSize;

    const wallCol = Math.floor(((dir > 0 ? b.right : b.left) + dir * 0.6) / ts);
    let row = Math.floor((b.bottom - 1) / ts);
    if (!level.isSolid(wallCol, row)) return null; // стена не на уровне ног — лезть некуда
    // (за границей уровня isSolid всегда true — без ограничения по ряду цикл был бы бесконечным)
    while (row > 0 && level.isSolid(wallCol, row - 1)) row--;

    const topY = row * ts;
    const rise = b.bottom - topY;
    if (rise <= 0 || rise > MAX_CLIMB_HEIGHT) return null;

    const y1 = b.yForFeet(topY);
    const wallFace = dir > 0 ? wallCol * ts : (wallCol + 1) * ts;
    const x2 = b.xForCenter(wallFace + dir * (b.hitWidth / 2 + 1));
    // над препятствием должно хватить места и для подъёма, и для шага вперёд
    if (b.overlapsSolidAt(level, b.x, y1) || b.overlapsSolidAt(level, x2, y1)) return null;

    // Если уступ выше, чем достают руки с земли, герой сначала подпрыгивает до «виса»
    const feet0 = b.bottom;
    const feetHang = Math.min(feet0, topY + HANG_FEET);
    const dur = { ...PHASE_DURATION };
    if (feetHang >= feet0) dur.jump = 0;
    return {
      phase: dur.jump > 0 ? 'jump' : 'hang', t: 0, dur, dir: dir > 0 ? 1 : -1,
      cornerX: wallFace, cornerY: topY,
      x0: b.x, xHang: b.x + dir * HANG_PRESS, x2,
      feet0, feetHang, feetTop: topY
    };
  }

  private beginClimb(plan: Climb): void {
    this.climb = plan;
    this.face(plan.dir);
    this.body.vx = this.body.vy = 0;
    this.airSteer = false;
    this.sliding = 0;
  }

  /**
   * Прыжок от стены: полноценный прыжок вверх с лёгким толчком от стены; дальше герой управляется как в обычном прыжке
   * (скорость по X плавно подстраивается под ввод). Прыжки от стены можно повторять, но не чаще WALL_JUMP_COOLDOWN.
   */
  private wallJump(): void {
    const b = this.body;
    const away = -this.wallDir as -1 | 1;
    if (this.wallDir !== 0) this.onWallKick?.(this.wallDir > 0 ? b.right + 1 : b.left - 1, b.y - WALL_KICK_FX_HEIGHT, this.wallDir);
    b.vy = GAME_CONFIG.JUMP_FORCE * WALL_JUMP_VY;
    b.vx = away * WALL_JUMP_PUSH;
    this.face(away);
    this.airSteer = true;
    this.wallJumpCd = WALL_JUMP_COOLDOWN;
    this.kickT = KICK_DURATION;
    this.jumpBuffer = this.wallCoyote = 0;
    this.wallDir = 0;
    this.sliding = 0;
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
