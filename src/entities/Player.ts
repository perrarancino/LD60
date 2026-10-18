import type { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { InputState } from '../core/InputManager.ts';
import type { RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import { PlayerRig, PUNCH_DURATION, THROW_DURATION, THROW_RELEASE } from './PlayerRig.ts';
import type { ClimbPhase, ClimbPose, PunchPose, ThrowPose } from './PlayerRig.ts';
import { Ragdoll } from './Ragdoll.ts';
import { CraftingSystem } from '../systems/CraftingSystem.ts';

const MAX_CLIMB_HEIGHT = 66; // на какую высоту герой может залезть (≈ 2 тайла), px
const CLIMB_COOLDOWN = 0.15;
const WALL_SLIDE_SPEED = 70; // макс. скорость падения при скольжении по стене, px/с
const WALL_JUMP_PUSH = 170; // прыжок от стены без направления: толчок от стены по горизонтали, px/с
const WALL_JUMP_PUSH_AWAY = 215; // прыжок от стены с направлением от неё — сильнее и дальше
const WALL_JUMP_VY = 0.95; // доля силы обычного прыжка
const WALL_CLIMB_PUSH = 40; // прыжок вдоль стены (направление к стене): лёгкий отскок, герой остаётся у стены и лезет вверх
const WALL_CLIMB_VY = 0.9;
const KICK_ALONG_DURATION = 0.34; // с: поза рывка вверх по стене
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
const THROW_COOLDOWN = 0.38; // с: пауза между бросками (от начала)
const PUNCH_CHEST = 31; // на сколько выше ног плечи, px: от них считается направление удара
// Падение с большой высоты: тело становится регдоллом — падает по физике (вперёд по инерции бега, иначе ноги подкашиваются
// и он валится назад), сталкивается с тайлами, улёгшись — встаёт; управление на это время отключено
const FALL_HEIGHT = 7 * 32; // px (7 тайлов): с такой высоты и выше
const FALL_FULL = 12 * 32; // px: с такой — самый сильный удар
const LAND_DUST_HEIGHT = 2 * 32; // px: с такой высоты приземление поднимает пыль (сильнее к FALL_HEIGHT)
const FALL_TOPPLE: [number, number] = [70, 130]; // px/с: толчок груди назад, если герой не бежал (от слабого до сильного удара)
const GETUP_MIN = 0.55; // с: подъём не короче
const GETUP_MAX = 1.1; // с: и не дольше
const GETUP_DONE = 3.5; // px: тело почти в стойке — подъём закончен

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
  public onWallKick: ((x: number, y: number, wallDir: -1 | 1, along: boolean) => void) | null = null;
  /** Вызывается, когда герой приземлился с большой высоты и теряет равновесие: точка у ног и сила 0..1. */
  public onHardLanding: ((x: number, y: number, power: number) => void) | null = null;
  /** Обычное приземление с заметной высоты (до регдолла): точка у ног и сила 0..1 — для пыли. */
  public onLanding: ((x: number, y: number, power: number) => void) | null = null;

  /** Шестерёнка (или иной снаряд) покинула руку: кисть в мире и направление броска — отсюда стартует снаряд. */
  public onThrowRelease: ((x: number, y: number, dirX: number, dirY: number) => void) | null = null;

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
  private throwT = -1; // время от начала броска, с; < 0 — не бросает
  private throwCd = 0;
  private throwArm: 1 | -1 = -1;
  private throwDir = { x: 1, y: 0 };
  private throwGear = false;
  private throwReleased = false;
  private kickAlong = false; // текущий отскок — вдоль стены (вверх по ней), а не от неё
  private peakY = 0; // самая высокая точка с момента отрыва от земли (y ног)
  private wasGrounded = true;
  private doll: Ragdoll | null = null; // регдолл (создаётся при первом падении)
  private downed = false; // лежит регдоллом или встаёт
  private extraJumps = 0; // двойной прыжок (проводные ноги)

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
    // появление — не падение: высота отсчитывается от точки спавна, регдолла нет
    this.peakY = this.body.y;
    this.wasGrounded = true;
    this.downed = false;
  }

  /** aim — положение курсора в мире (null, пока мышь не двигали). */
  public update(dt: number, input: InputState, level: Level, aim: { x: number; y: number } | null): void {
    const b = this.body;
    this.climbCooldown -= dt;
    this.kickT = this.climb || b.grounded ? 0 : Math.max(0, this.kickT - dt);
    // пока герой лежит и встаёт — управления нет
    const ctl: InputState = this.downed
      ? {
          ...input,
          horizontal: 0,
          vertical: 0,
          jumpPressed: false,
          jumpHeld: false,
          attackPressed: false,
          attackHeld: false,
          specialAttackPressed: false,
          specialAttackHeld: false,
          hubMenuPressed: false
        }
      : input;

    if (this.climb) {
      this.updateClimb(dt);
    } else {
      const vxBefore = b.vx;
      const vyBefore = b.vy;
      this.updateMovement(dt, ctl, level);
      if (this.downed) this.updateDowned(dt, level);
      else this.checkHardLanding(vxBefore, vyBefore, level);
      if (!this.climb && !this.downed && this.climbCooldown <= 0 && ctl.horizontal !== 0 && b.blockedX === ctl.horizontal) {
        const plan = this.planClimb(ctl.horizontal, level);
        if (plan) this.beginClimb(plan);
      }
    }
    // высота падения считается от самой высокой точки; на земле, на стене и при залезании — сброс
    if (b.grounded || this.sliding !== 0 || this.climb) this.peakY = b.y;
    else this.peakY = Math.min(this.peakY, b.y);
    this.wasGrounded = b.grounded || !!this.climb;

    this.updatePunch(dt, ctl, aim);

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
      kick: this.kickT > 0 ? 1 - this.kickT / (this.kickAlong ? KICK_ALONG_DURATION : KICK_DURATION) : null,
      kickAlong: this.kickAlong,
      wall: this.sliding,
      wallX: this.wallX,
      punch: this.punchT >= 0 ? this.punchPose() : null,
      throwing: this.throwT >= 0 ? this.throwPose() : null,
      ragdoll: this.downed && this.doll ? { body: this.doll, solid: (x, y) => y >= 0 && level.isSolid(Math.floor(x / level.tileSize), Math.floor(y / level.tileSize)) } : null
    });
    this.sprite.position.set(b.x, b.y);
    this.updateThrow(dt);
  }

  private throwPose(): ThrowPose {
    return { time: this.throwT, dirX: this.throwDir.x, dirY: this.throwDir.y, arm: this.throwArm, gear: this.throwGear };
  }

  /** Можно ли начать бросок сейчас (не лезет, не лежит, не бьёт, не бросает, пауза прошла). */
  public get canThrow(): boolean {
    return !this.climb && !this.downed && this.throwT < 0 && this.punchT < 0 && this.throwCd <= 0;
  }

  /**
   * Бросок в сторону курсора: ближайшая к нему рука замахивается за голову и бросает; в момент отпускания зовётся onThrowRelease
   * с положением кисти — оттуда и вылетает шестерёнка. gear — в руке шестерёнка (рисуется на замахе).
   */
  public startThrow(aim: { x: number; y: number } | null, gear: boolean): boolean {
    if (!this.canThrow) return false;
    const b = this.body;
    let dx = aim ? aim.x - b.x : this.facing;
    let dy = aim ? aim.y - (b.y - PUNCH_CHEST) : 0;
    let len = Math.hypot(dx, dy);
    if (len < 6) { dx = this.facing; dy = 0; len = 1; }
    this.throwDir = { x: dx / len, y: dy / len };
    this.throwArm = (dx >= 0 ? -this.facing : this.facing) as 1 | -1;
    this.throwGear = gear;
    this.throwReleased = false;
    this.throwT = 0;
    this.throwCd = THROW_COOLDOWN;
    return true;
  }

  /** Ход броска; в момент отпускания — снаряд из руки (кисть уже посчитана ригом в этом кадре). */
  private updateThrow(dt: number): void {
    this.throwCd -= dt;
    if (this.throwT < 0) return;
    if (this.climb || this.downed) { this.throwT = -1; return; }
    this.throwT += dt;
    if (!this.throwReleased && this.throwT >= THROW_RELEASE) {
      this.throwReleased = true;
      const h = this.rig.hand;
      const b = this.body;
      this.onThrowRelease?.(h.active ? h.x : b.x, h.active ? h.y : b.y - 28, this.throwDir.x, this.throwDir.y);
    }
    if (this.throwT >= THROW_DURATION) this.throwT = -1;
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

  /** Приземление после падения с большой высоты: тело становится регдоллом (по инерции бега — вперёд, стоя — валится назад). */
  private checkHardLanding(vxBefore: number, vyBefore: number, level: Level): void {
    const b = this.body;
    if (this.wasGrounded || !b.grounded || this.downed) return;
    const fall = b.y - this.peakY;
    const legs = CraftingSystem.get().activeParts.legs;
    if ((legs.type === 'standard' && legs.level >= 2) || (legs.type === 'disc' && legs.level >= 1)) {
      if (fall >= LAND_DUST_HEIGHT) this.onLanding?.(b.x, b.bottom, Math.min(1, (fall - LAND_DUST_HEIGHT) / (FALL_HEIGHT - LAND_DUST_HEIGHT)));
      return; // Мягкое приземление без регдолла и потери управления
    }
    if (fall < FALL_HEIGHT) {
      if (fall >= LAND_DUST_HEIGHT) this.onLanding?.(b.x, b.bottom, (fall - LAND_DUST_HEIGHT) / (FALL_HEIGHT - LAND_DUST_HEIGHT));
      return;
    }
    const power = Math.min(1, (fall - FALL_HEIGHT) / (FALL_FULL - FALL_HEIGHT));
    const running = Math.abs(vxBefore) > 30;
    const topple = running ? 0 : -this.facing * (FALL_TOPPLE[0] + (FALL_TOPPLE[1] - FALL_TOPPLE[0]) * power);
    this.doll ??= new Ragdoll(this.rig.ragdollGeometry());
    this.doll.start(level, b.x, b.y, this.facing, vxBefore, Math.max(vyBefore, 0), topple);
    this.downed = true;
    this.punchT = -1;
    this.kickT = 0;
    this.onHardLanding?.(b.x, b.bottom, power);
  }

  /**
   * Лежит регдоллом: хитбокс тела едет за тазом (сквозь стены не проходит — двигается по физике тела), улёгшись —
   * встаёт: мышцы тянут регдолл к стойке на месте хитбокса; почти встал (или вышло время) — снова обычная анимация.
   */
  private updateDowned(dt: number, level: Level): void {
    const b = this.body;
    const doll = this.doll!;
    if (doll.gettingUp < 0) {
      const g = this.rig.ragdollGeometry();
      const target = doll.points[0].x - (g.waist.x - g.anchor.x) * this.facing; // где был бы хитбокс при таком тазе
      b.vx = Math.max(-300, Math.min(300, (target - b.x) / Math.max(dt, 1e-3)));
      b.move(dt, level);
      b.vx = 0;
      if (doll.settled) doll.getUp();
    }
    doll.update(dt, { bodyX: b.x, bodyY: b.y, facing: this.facing });
    const t = doll.gettingUp;
    if (t >= GETUP_MAX || (t >= GETUP_MIN && doll.offStand(b.x, b.y, this.facing) < GETUP_DONE)) this.downed = false;
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
    if (this.climb || this.throwT >= 0 || this.punchBuffer <= 0 || this.punchCd > 0) return;

    const b = this.body;
    let dx = aim ? aim.x - b.x : this.facing;
    let dy = aim ? aim.y - (b.y - PUNCH_CHEST) : 0;
    let len = Math.hypot(dx, dy);
    if (len < 6) { dx = this.facing; dy = 0; len = 1; } // курсор прямо у плеч — бьём вперёд
    this.punchDir = { x: dx / len, y: dy / len };
    // сторона рига: рука на экране справа от героя (мир) — side -1 при взгляде вправо, и наоборот
    this.punchArm = (dx >= 0 ? -this.facing : this.facing) as 1 | -1;
    this.punchT = 0;
    const cdMult = CraftingSystem.get().getAttackSpeedMultiplier();
    this.punchCd = PUNCH_COOLDOWN * cdMult;
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
    const speedMult = CraftingSystem.get().getSpeedMultiplier();
    const targetVx = input.horizontal * GAME_CONFIG.PLAYER_SPEED * speedMult;
    if (this.downed) {
      b.vx = 0; // лежит: хитбокс двигает регдолл (updateDowned)
    } else if (this.airSteer && !b.grounded) {
      // Скорость плавно подстраивается под ввод: после прыжка от стены героя можно вести в любую сторону
      const accel = (input.horizontal !== 0 ? AIR_ACCEL : AIR_DRAG) * dt;
      b.vx += Math.max(-accel, Math.min(accel, targetVx - b.vx));
    } else {
      this.airSteer = false;
      b.vx = targetVx;
    }

    this.coyote = b.grounded ? GAME_CONFIG.COYOTE_TIME_SEC : this.coyote - dt;
    this.jumpBuffer = input.jumpPressed ? GAME_CONFIG.JUMP_BUFFER_SEC : this.jumpBuffer - dt;

    if (b.grounded) {
      this.extraJumps = CraftingSystem.get().getAirJumpsCount();
    }

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      const jumpBoost = CraftingSystem.get().getJumpForceMultiplier();
      b.vy = GAME_CONFIG.JUMP_FORCE * jumpBoost;
      this.jumpBuffer = this.coyote = 0;
    } else if (this.jumpBuffer > 0 && !b.grounded && this.wallCoyote > 0 && this.wallDir !== 0) {
      // Прыжок у стены: если можно залезть — лезем, иначе прыжок от стены
      const plan = contact !== 0 && !this.climbBlocked() ? this.planClimb(contact, level) : null;
      if (plan) {
        this.beginClimb(plan);
        this.jumpBuffer = 0;
        return;
      }
      if (this.wallJumpCd <= 0) this.wallJump(input.horizontal, level);
    } else if (this.jumpBuffer > 0 && !b.grounded && this.extraJumps > 0) {
      // Двойной / тройной электро-прыжок в воздухе (проводные ноги)
      b.vy = GAME_CONFIG.JUMP_FORCE * 0.95;
      this.extraJumps--;
      this.jumpBuffer = 0;
      this.onWallKick?.(b.x, b.y - 4, this.facing, false);
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
   * Прыжок у стены, два вида:
   *  - вдоль стены (направление к стене): рывок вверх по ней — лёгкий отскок, герой остаётся лицом к стене, руки перехватывают
   *    стену выше, стопы отталкиваются вниз; дым уходит вниз по стене. Так можно взбираться по стене серией рывков;
   *  - от стены (без направления или от неё): разворот и прыжок от стены, с направлением — сильнее и дальше; дым веером от стены.
   * Дальше герой управляется как в обычном прыжке (скорость по X плавно подстраивается под ввод). Не чаще WALL_JUMP_COOLDOWN.
   */
  private wallJump(horizontal: number, level: Level): void {
    const b = this.body;
    const wall = this.wallDir as -1 | 1;
    const away = -wall as -1 | 1;
    const along = horizontal === wall;
    const ts = level.tileSize;
    this.wallX = wall > 0 ? Math.floor((b.right + 0.6) / ts) * ts : (Math.floor((b.left - 0.6) / ts) + 1) * ts;
    this.onWallKick?.(wall > 0 ? b.right + 1 : b.left - 1, along ? b.y - 4 : b.y - WALL_KICK_FX_HEIGHT, wall, along);
    if (along) {
      b.vy = GAME_CONFIG.JUMP_FORCE * WALL_CLIMB_VY;
      b.vx = away * WALL_CLIMB_PUSH;
      this.face(wall);
      this.kickT = KICK_ALONG_DURATION;
    } else {
      b.vy = GAME_CONFIG.JUMP_FORCE * WALL_JUMP_VY;
      b.vx = away * (horizontal === away ? WALL_JUMP_PUSH_AWAY : WALL_JUMP_PUSH);
      this.face(away);
      this.kickT = KICK_DURATION;
    }
    this.kickAlong = along;
    this.airSteer = true;
    this.wallJumpCd = WALL_JUMP_COOLDOWN;
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
