import { Container, Sprite, type Texture } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { RigDef, RigPartDef } from '../data/types.ts';
import { splitFace } from './FaceSplit.ts';
import type { Ragdoll, RagdollGeometry } from './Ragdoll.ts';
import { RopeLimb } from './RopeLimb.ts';
import { bareImage, imageTexture, textureImage } from './armorSkin.ts';
import type { Slot } from '../systems/ArmorSystem.ts';

/** Фаза залезания на уступ. */
export type ClimbPhase = 'jump' | 'hang' | 'pull' | 'mantle';

export interface ClimbPose {
  phase: ClimbPhase;
  t: number; // 0..1 внутри фазы
  p: number; // 0..1 за всё залезание
  cornerX: number; // край уступа (мир): сюда цепляются руки
  cornerY: number;
  dir: 1 | -1;
}

/** Тайминг удара, с: замах -> рывок руки -> удержание; дальше рука сама возвращается (физика каната). */
export const PUNCH_WINDUP = 0.05;
export const PUNCH_STRIKE = 0.05;
export const PUNCH_HOLD = 0.07;
export const PUNCH_DURATION = PUNCH_WINDUP + PUNCH_STRIKE + PUNCH_HOLD;
const PUNCH_FOLDED = 0.5; // доля длины руки при замахе (рука сложена у плеча)
const PUNCH_REACH = 1.55; // во сколько раз рука вытягивается в ударе относительно нарисованной длины (растягивается)
const PUNCH_BLEND = 34; // 1/с: как быстро рука переходит из физической позы в ударную (по умолчанию у каната 9 — слишком вяло для удара)
const PUNCH_LEAN = 0.2; // рад: наклон торса в сторону удара

/** Удар: время от начала, мировое направление (единичный вектор) и какая рука бьёт (side руки в риге). */
export interface PunchPose {
  time: number;
  dirX: number;
  dirY: number;
  arm: 1 | -1;
}

/**
 * Бросок: замах (рука уходит назад и вверх за голову, в ней шестерёнка), рывок вперёд по дуге над головой, в конце рывка — отпускание
 * (RELEASE), затем рука доводится вперёд и возвращается. Тайминг, с.
 */
export const THROW_WINDUP = 0.2;
export const THROW_SWING = 0.075;
export const THROW_HOLD = 0.11;
export const THROW_RELEASE = THROW_WINDUP + THROW_SWING * 0.92; // шестерёнка покидает руку
export const THROW_DURATION = THROW_WINDUP + THROW_SWING + THROW_HOLD;
const THROW_BLEND = 26; // 1/с: переход руки из физической позы в бросковую
const THROW_LEAN = 0.16; // рад: корпус откидывается назад на замахе и подаётся вперёд в броске

export interface ThrowPose {
  time: number;
  dirX: number;
  dirY: number;
  arm: 1 | -1;
  gear: boolean; // в руке шестерёнка (иначе просто жест)
}

/** Бьющая часть руки в мире: от плеча к кулаку. active — кулак выброшен и может попасть. */
export interface Fist {
  active: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Состояние героя, из которого рисуется поза. Все координаты — мировые. */
export interface RigPose {
  bodyX: number;
  bodyY: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  aimX: number; // положение курсора в мире
  aimY: number;
  climb: ClimbPose | null;
  kick: number | null; // прогресс «отталкивания от стены» 0..1 (поза прыжка от стены), null — нет
  kickAlong?: boolean; // отскок вдоль стены (рывок вверх по ней, лицом к стене), а не от неё
  wall: -1 | 0 | 1; // скольжение по стене: сторона стены (мир, -1 слева / 1 справа), 0 — нет
  wallX: number; // x поверхности стены (мир)
  punch?: PunchPose | null; // идёт удар: ближайшая к цели рука резко выбрасывается вперёд
  throwing?: ThrowPose | null; // идёт бросок: замах, рывок и отпускание шестерёнки
  beam?: { dirX: number; dirY: number; arm: 1 | -1 } | null; // луч молнии: рука вытянута к курсору и держится
  ragdoll?: { body: Ragdoll; solid: (x: number, y: number) => boolean } | null; // упал с высоты: тело — регдолл (solid — тайлы для рук)
}

interface Part {
  def: RigPartDef;
  sprite: Sprite | null; // у рук-канатов вместо спрайта — limb
  limb: RopeLimb | null;
}

/** Вид части в данной «броне» (0 — голое шасси, 1 и 2 — части моделей героя): картинка, точка привязки и то, что от неё зависит. */
interface PartSkin {
  texture?: Texture; // обычная часть (у рук-канатов — по image)
  image?: ImageData; // руки-канаты: пиксели слоя
  pivot: { x: number; y: number }; // точка привязки части на её картинке (на тело ставится в pivot рига)
  length?: number; // ноги: длина
  face?: Texture; // голова: слой лица (глаза)
  gaze?: { x: number; y: number }; // голова: откуда смотрят глаза
  center?: { x: number; y: number }; // голова: центр по пикселям (от него направление на курсор)
}

const ROLE_SLOT: Record<string, Slot> = { head: 'head', torso: 'torso', arm: 'arms', leg: 'legs' };

/** Нога с шаговым контроллером: стопа стоит на месте в мире, пока тело не уйдёт, затем делает шаг. */
interface Foot {
  part: Part;
  side: 1 | -1;
  length: number;
  wx: number; // мировая x стопы
  swing: boolean; // в махе (шаг)
  swingFrom: number;
  swingT: number;
  swingDur: number;
  swingRel: number; // куда приземлится относительно таза (локально, вперёд = +)
  air: boolean; // в воздухе (ноги болтаются)
  angle: number; // текущий угол ноги, рад
  lift: number; // подъём стопы в махе, px
}

// Настройки процедурной анимации
const HEAD_ROLL_SHARE = 0.4; // доля угла на курсор, на которую наклоняется голова целиком (остальное «досматривают» глаза)
const HEAD_MAX_ROLL = 0.5; // максимальный наклон головы, рад (~29°)
const TORSO_FOLLOW = 0.3; // торс поворачивается за головой, но заметно слабее (доля наклона головы)
const LEG_MAX_ANGLE = 1.0; // максимальный разворот ноги от вертикали, рад
const STEP_TRIGGER = 0.6; // шаг, когда стопа отстала от таза на эту долю досягаемости
const STEP_AHEAD = 0.55; // стопа приземляется впереди таза на эту долю досягаемости
const STEP_LIFT = 3.5; // высота подъёма стопы в махе, px
// Приземление — пружина в ногах: удар о землю задаёт скорость сжатия, таз проседает, ноги разъезжаются наружу ровно настолько,
// чтобы стопы оставались на земле (ноги — одна кость), корпус кивает вперёд; затем пружина распрямляется с лёгким отскоком
const LAND_SPEED_MIN = 200; // px/с: удар о землю медленнее — ноги не пружинят
const LAND_GAIN = 1.0; // доля скорости падения, которая уходит в сжатие ног
const LAND_STIFF = 380; // 1/с²: жёсткость ног
const LAND_DAMPING = 0.55; // доля критического затухания (меньше 1 — с лёгким отскоком)
const LAND_MAX = 12; // px: глубже таз не проседает
const LAND_LEAN = 0.03; // рад на px сжатия: кивок корпуса вперёд
const LAND_STEP = 1 / 240; // с: фиксированный шаг пружины
const RAGDOLL_ARM_STIFF = 0.12; // руки регдолла почти не держат позу — болтаются и падают под весом

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * Процедурная анимация робота из частей-слоёв (data/rigs/*.json):
 *  - ноги физичны: стопы «приклеены» к земле, при уходе тела делают шаги, таз проседает при широкой постановке;
 *  - голова и торс поворачиваются за курсором;
 *  - руки — канаты (verlet), могут жёстко цепляться кистью за точку (уступ);
 *  - залезание: подпрыгивание, хват за край, подтягивание, перекат на уступ.
 */
export class PlayerRig {
  public readonly container = new Container();
  /** Внутренний контейнер: наклоняется всем телом (вокруг центра тела) при отталкивании от стены. */
  private readonly tilt = new Container();
  private tiltRot = 0;
  private landC = 0; // px: сжатие ног после приземления
  private landV = 0; // px/с: скорость сжатия
  private landAcc = 0;
  private airVy = 0; // скорость падения в последнем кадре в воздухе
  private wasGrounded = true;

  private parts: Part[] = [];
  private torso: Part;
  private head: Part;
  private arms: Part[] = [];
  private feet: Foot[] = [];
  private time = 0;
  private torsoRot = 0;
  private headRot = 0;
  private pelvisDrop = 0;
  private wasClimbing = false;
  private faceSprite: Sprite | null = null; // лицо (глаза, рот) поверх черепа: сдвигается к курсору
  private faceShift = { x: 0, y: 0 };
  /** Кулак бьющей руки в мире (обновляется в update): по нему игра проверяет попадания. */
  public readonly fist: Fist = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
  /** Кисть бросающей руки в мире (обновляется, пока идёт бросок): отсюда вылетает шестерёнка. */
  public readonly hand = { x: 0, y: 0, active: false };
  private readonly gear: Sprite | null; // шестерёнка в руке (видна на замахе, пока не отпущена)
  private readonly tiers: Record<Slot, number> = { head: 1, torso: 1, arms: 1, legs: 1 }; // надетая «броня» по слотам: 0 шасси, 1 модель 1, 2 модель 2
  private readonly skins = new Map<string, PartSkin>(); // виды частей: `${имя части}:${ступень}`
  private headGaze: { x: number; y: number } | undefined;
  private readonly partTier = new Map<Part, number>();
  private prevTilt = 0; // наклон головы к курсору в прошлом кадре (торс следует за ним)
  /** Центр головы в координатах холста (по непрозрачным пикселям) — от него считается направление на курсор. */
  private headCenter: { x: number; y: number };

  /** def — основная модель (ступень 1); alt — вторая модель героя (ступень 2): её части можно ставить на любой слот. */
  constructor(private readonly def: RigDef, sprites: SpriteLibrary, alt: RigDef | null = null) {
    try {
      this.gear = sprites.createSprite('bullet1');
      this.gear.pivot.set(this.gear.width / 2, this.gear.height / 2);
      this.gear.visible = false;
    } catch {
      this.gear = null; // спрайта шестерёнки нет — бросок без неё
    }
    this.tilt.position.set(0, -28); // центр вращения — середина тела
    this.tilt.pivot.set(0, -28);
    this.container.addChild(this.tilt);
    for (const p of def.parts) {
      let part: Part;
      if (p.role === 'arm' && p.rope) {
        const image = sprites.imageData(p.sprite_id);
        const limb = new RopeLimb(image, p.pivot, p.rope.segments);
        part = { def: p, sprite: null, limb };
        this.tilt.addChild(limb.container);
      } else if (p.role === 'head' && p.face) {
        // Череп и лицо — отдельные спрайты: лицо сдвигается по черепу, и голова «смотрит» на курсор
        let sprite: Sprite;
        let faceSprite: Sprite;
        if (p.face.sprite_id) {
          // лицо нарисовано отдельным слоем (глаза): просто лежит поверх головы
          sprite = sprites.createSprite(p.sprite_id);
          faceSprite = sprites.createSprite(p.face.sprite_id);
        } else {
          const { skull, face } = splitFace(sprites.imageData(p.sprite_id), p.face.feature_colors ?? [], p.face.region);
          sprite = new Sprite(skull);
          faceSprite = new Sprite(face);
        }
        sprite.pivot.set(p.pivot.x, p.pivot.y);
        faceSprite.pivot.set(p.pivot.x, p.pivot.y);
        this.faceSprite = faceSprite;
        part = { def: p, sprite, limb: null };
        this.tilt.addChild(sprite, faceSprite);
      } else {
        const sprite = sprites.createSprite(p.sprite_id);
        sprite.pivot.set(p.pivot.x, p.pivot.y);
        part = { def: p, sprite, limb: null };
        this.tilt.addChild(sprite);
      }
      this.parts.push(part);
      if (p.role === 'arm') this.arms.push(part);
      if (p.role === 'leg') {
        this.feet.push({
          part, side: p.side ?? 1, length: p.length ?? 16, wx: 0, swing: false, swingFrom: 0, swingT: 0,
          swingDur: 0.1, swingRel: 0, air: true, angle: 0, lift: 0
        });
      }
    }
    const torso = this.parts.find((p) => p.def.role === 'torso');
    const head = this.parts.find((p) => p.def.role === 'head');
    if (!torso || !head) throw new Error(`[PlayerRig] в риге "${def.id}" нужны части torso и head`);
    this.torso = torso;
    this.head = head;
    this.headCenter = this.opaqueCenter(sprites.imageData(head.def.sprite_id));
    this.headGaze = head.def.gaze_origin;
    for (const [i, model] of [def, ...(alt ? [alt] : [])].entries()) {
      for (const p of model.parts) this.skins.set(`${p.name}:${i + 1}`, this.makeSkin(p, sprites));
    }
    for (const part of this.parts) this.partTier.set(part, 1);
    if (this.gear) this.tilt.addChild(this.gear); // шестерёнка в руке — поверх рук
    this.update(0, {
      bodyX: 0, bodyY: 0, vx: 0, vy: 0, facing: 1, grounded: true, aimX: 0, aimY: 0, climb: null, kick: null, wall: 0, wallX: 0
    });
  }

  /** Вид части из слоёв модели (рига) — для смены частей между моделями. */
  private makeSkin(p: RigPartDef, sprites: SpriteLibrary): PartSkin {
    if (p.role === 'arm' && p.rope) return { image: sprites.imageData(p.sprite_id), pivot: { x: p.pivot.x, y: p.pivot.y } };
    const skin: PartSkin = { texture: sprites.createSprite(p.sprite_id).texture, pivot: { x: p.pivot.x, y: p.pivot.y }, length: p.length };
    if (p.role === 'head') {
      skin.center = this.opaqueCenter(sprites.imageData(p.sprite_id));
      skin.gaze = p.gaze_origin;
      if (p.face?.sprite_id) skin.face = sprites.createSprite(p.face.sprite_id).texture;
    }
    return skin;
  }

  /** Вид части на ступени: 1 и 2 — части моделей героя, 0 — голое серое шасси (рисунок модели 1, перекрашенный). */
  private skin(name: string, tier: number): PartSkin {
    const key = `${name}:${tier}`;
    let skin = this.skins.get(key);
    if (skin) return skin;
    const base = this.skins.get(`${name}:1`)!;
    skin = { ...base };
    if (base.image) skin.image = bareImage(base.image);
    else skin.texture = imageTexture(bareImage(textureImage(base.texture!)));
    this.skins.set(key, skin);
    return skin;
  }

  /**
   * Собрать героя из частей: на каждый слот (голова, туловище, руки, ноги) — своя ступень: 0 голое шасси, 1 часть первой модели, 2 часть второй.
   * Части подгоняются друг к другу: картинка встаёт точкой привязки (шея, плечо, бедро) в точку привязки рига, у ног меняется длина, у головы — взгляд.
   */
  public setArmor(tiers: Record<Slot, number>): void {
    for (const part of this.parts) {
      const slot = ROLE_SLOT[part.def.role ?? ''];
      if (!slot) continue;
      const tier = tiers[slot];
      if (this.partTier.get(part) === tier) continue;
      this.partTier.set(part, tier);
      const sk = this.skin(part.def.name, tier);
      if (part.limb) {
        // рука-канат пересобирается из картинки другой модели; цепочка начинается заново у плеча
        const old = part.limb;
        const fresh = new RopeLimb(sk.image!, sk.pivot, part.def.rope!.segments);
        this.tilt.addChildAt(fresh.container, this.tilt.getChildIndex(old.container));
        this.tilt.removeChild(old.container);
        old.container.destroy({ children: true, texture: true });
        part.limb = fresh;
      } else if (part.sprite) {
        part.sprite.texture = sk.texture!;
        part.sprite.pivot.set(sk.pivot.x, sk.pivot.y);
        const foot = this.feet.find((f) => f.part === part);
        if (foot && sk.length) foot.length = sk.length;
        if (part === this.head) {
          if (this.faceSprite && sk.face) {
            this.faceSprite.texture = sk.face;
            this.faceSprite.pivot.set(sk.pivot.x, sk.pivot.y);
          }
          if (sk.center) this.headCenter = sk.center;
          this.headGaze = sk.gaze;
        }
      }
    }
    Object.assign(this.tiers, tiers);
  }

  /**
   * Снимки частей слота, которые сейчас на герое (для отвалившихся обломков): текстура, положение точки привязки в мире, поворот.
   */
  public detachPieces(slot: Slot, bodyX: number, bodyY: number, facing: 1 | -1): {
    texture: Texture; x: number; y: number; rotation: number; flip: 1 | -1; pivot: { x: number; y: number };
  }[] {
    const tier = this.tiers[slot];
    const out = [];
    for (const part of this.parts) {
      if (ROLE_SLOT[part.def.role ?? ''] !== slot) continue;
      const sk = this.skin(part.def.name, tier);
      const pv = part.def.pivot;
      if (part.sprite) {
        out.push({
          texture: sk.texture!, x: bodyX + part.sprite.x * facing, y: bodyY + part.sprite.y, rotation: part.sprite.rotation * facing, flip: facing,
          pivot: { x: sk.pivot.x, y: sk.pivot.y }
        });
      } else {
        // рука-канат: обломок — вся рука целиком у плеча
        sk.texture ??= imageTexture(sk.image!);
        out.push({
          texture: sk.texture, x: bodyX + (pv.x - this.def.anchor.x) * facing, y: bodyY + pv.y - this.def.anchor.y, rotation: 0, flip: facing,
          pivot: { x: sk.pivot.x, y: sk.pivot.y }
        });
      }
    }
    return out;
  }

  private opaqueCenter(img: ImageData): { x: number; y: number } {
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return { x: (x0 + x1 + 1) / 2, y: (y0 + y1 + 1) / 2 };
  }

  public update(dt: number, s: RigPose): void {
    this.time += dt;
    const f = s.facing;
    const climb = s.climb;
    const speedL = s.vx * f; // скорость вдоль направления взгляда

    this.container.scale.x = f;
    if (s.ragdoll) {
      this.poseRagdoll(dt, s, s.ragdoll.body, s.ragdoll.solid);
      return;
    }

    // ---- Курсор в локальных координатах от центра головы (вперёд = +x)
    const hc = this.headCenter;
    const headWorldX = s.bodyX + (hc.x - this.def.anchor.x) * f;
    const headWorldY = s.bodyY + (hc.y - this.def.anchor.y) + this.pelvisDrop;
    const dx = (s.aimX - headWorldX) * f;
    const dy = s.aimY - headWorldY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const gain = Math.min(1, dist / 24); // у самой головы курсор не дёргает её
    const nx = (dx / dist) * gain;

    // ---- Приземление: пружина в ногах (сжатие задаёт удар о землю)
    if (s.grounded && !this.wasGrounded && !climb) this.landV += Math.max(0, this.airVy - LAND_SPEED_MIN) * LAND_GAIN;
    if (!s.grounded) this.airVy = s.vy;
    this.wasGrounded = s.grounded;
    this.updateLandSpring(dt, s.grounded && !climb);

    // ---- Ноги: шаговый контроллер (+ разведение при сжатии) -> просадка таза
    const drop = climb ? this.updateLegsClimb(dt, climb) : this.updateLegs(dt, s);
    this.pelvisDrop = approach(this.pelvisDrop, drop, 60, dt);

    // ---- Торс и голова
    let torsoTarget = this.prevTilt * TORSO_FOLLOW + 0.04 * clamp(speedL / GAME_CONFIG.PLAYER_SPEED, -1, 1) + LAND_LEAN * this.landC;
    // Поворот головы относительно торса: null — головой управляет курсор (считается ниже, от шеи); число — поза (залезание/отскок)
    let headTarget: number | null = null;
    let torsoLift = 0;
    if (climb) {
      switch (climb.phase) {
        case 'jump': torsoTarget = -0.15; headTarget = -0.3; torsoLift = -2 * Math.sin(Math.PI * climb.t); break;
        case 'hang': torsoTarget = -0.05; headTarget = -0.3; torsoLift = 1; break;
        case 'pull': torsoTarget = 0.1 * climb.t; headTarget = -0.25 * (1 - climb.t); break;
        case 'mantle': torsoTarget = 0.3 * Math.sin(Math.PI * Math.min(1, climb.t * 1.2)); headTarget = 0.05; break;
      }
    }
    const kick = s.kick;
    let tiltTarget = 0;
    if (kick !== null && !climb && s.kickAlong) {
      // рывок вверх вдоль стены: тело чуть к стене, грудь вверх, голова смотрит вверх
      const arc = Math.sin(Math.PI * Math.min(1, kick));
      tiltTarget = 0.12 * arc;
      torsoTarget = -0.12 * arc;
      headTarget = -0.3 * arc;
    } else if (kick !== null && !climb) {
      // Отталкивание от стены: всё тело наклоняется вперёд по ходу прыжка, торс и голова поворачиваются следом
      const arc = Math.sin(Math.PI * Math.min(1, kick / 0.85));
      tiltTarget = 0.38 * arc;
      torsoTarget = 0.25 * arc;
      headTarget = 0.1 * arc;
    }
    const thr = s.throwing && !climb && !s.punch ? s.throwing : null;
    if (thr) {
      // Бросок: корпус откидывается на замахе, подаётся вперёд в рывке
      const wind = clamp(thr.time / THROW_WINDUP, 0, 1);
      const swing = clamp((thr.time - THROW_WINDUP) / THROW_SWING, 0, 1);
      const lean = (-wind * (1 - swing) + swing * (1 - clamp((thr.time - THROW_WINDUP - THROW_SWING) / THROW_HOLD, 0, 1))) * THROW_LEAN;
      torsoTarget += lean * clamp(thr.dirX * f, -1, 1);
    }
    const beam = s.beam && !climb && !s.punch && !thr ? s.beam : null;
    if (beam) torsoTarget += 0.1 * clamp(beam.dirX * f, -1, 1); // корпус слегка подаётся к лучу
    const punch = s.punch && !climb ? s.punch : null;
    if (punch) {
      // Удар: торс подаётся в сторону удара (вперёд по взгляду +, назад -), пик — в момент выброса руки
      const arc = Math.sin(Math.PI * clamp(punch.time / PUNCH_DURATION, 0, 1));
      torsoTarget += PUNCH_LEAN * clamp(punch.dirX * f, -1, 1) * arc;
    }
    this.tiltRot = approach(this.tiltRot, tiltTarget, 20, dt);
    this.tilt.rotation = this.tiltRot;
    this.torsoRot = approach(this.torsoRot, torsoTarget, 14, dt);

    const breathe = Math.sin(this.time * 2.4) * 0.4;
    const torsoOy = this.pelvisDrop + breathe + torsoLift;
    const torsoOx = nx * 0.5;

    const waist = this.torso.def.pivot;
    // Точка крепления (шея/плечо) вместе с поворотом и сдвигом торса
    const attach = (p: { x: number; y: number }) => {
      const rx = p.x - waist.x;
      const ry = p.y - waist.y;
      const c = Math.cos(this.torsoRot);
      const sn = Math.sin(this.torsoRot);
      return { x: waist.x + rx * c - ry * sn + torsoOx, y: waist.y + rx * sn + ry * c + torsoOy };
    };
    const place = (part: Part, x: number, y: number, rot: number) => {
      const sprite = part.sprite!;
      sprite.position.set(x - this.def.anchor.x, y - this.def.anchor.y);
      sprite.rotation = rot;
    };

    place(this.torso, waist.x + torsoOx, waist.y + torsoOy, this.torsoRot);
    const headPos = attach(this.head.def.pivot);

    // Голова «смотрит» на курсор двумя способами: целиком слегка наклоняется к нему (как раньше, но мягче), а черты лица
    // (глаза, брови, рот) сдвигаются по черепу в сторону курсора — глаза смотрят прямо на него.
    const nk = this.head.def.pivot;
    const face = this.head.def.face;
    if (headTarget === null) {
      // Наклон головы: угол на курсор от шеи (вверх = 0, вправо = +), для нижней полуплоскости отражается
      const nxw = s.bodyX + (headPos.x - this.def.anchor.x) * f;
      const nyw = s.bodyY + (headPos.y - this.def.anchor.y);
      const adx = (s.aimX - nxw) * f;
      const ady = s.aimY - nyw;
      const agin = Math.min(1, Math.hypot(adx, ady) / 24);
      const aimAngle = Math.atan2(adx, -ady);
      const toward = Math.sign(aimAngle) * Math.min(Math.abs(aimAngle), Math.PI - Math.abs(aimAngle));
      this.prevTilt = clamp(toward * HEAD_ROLL_SHARE, -HEAD_MAX_ROLL, HEAD_MAX_ROLL) * agin;
      headTarget = this.prevTilt - this.torsoRot;
    } else {
      this.prevTilt = 0;
    }
    this.headRot = approach(this.headRot, headTarget, 22, dt);
    const headTot = this.torsoRot + this.headRot;
    place(this.head, headPos.x, headPos.y, headTot);

    if (this.faceSprite && face) {
      // Направление на курсор от глаз (в системе контейнера: вперёд = +x), затем — в системе черепа (с учётом поворота головы)
      const eye = this.headGaze ?? this.headCenter;
      const vx = eye.x - nk.x;
      const vy = eye.y - nk.y;
      const c = Math.cos(headTot);
      const sn = Math.sin(headTot);
      const ex = headPos.x + vx * c - vy * sn;
      const ey = headPos.y + vx * sn + vy * c;
      const gx = (s.aimX - (s.bodyX + (ex - this.def.anchor.x) * f)) * f;
      const gy = s.aimY - (s.bodyY + (ey - this.def.anchor.y));
      const gd = Math.hypot(gx, gy);
      const gGain = Math.min(1, gd / 24);
      const ux = gd > 1e-3 ? (gx / gd) * gGain : 0;
      const uy = gd > 1e-3 ? (gy / gd) * gGain : 0;
      // в систему черепа: поворот на -headTot
      const sx = ux * c + uy * sn;
      const sy = -ux * sn + uy * c;
      this.faceShift.x = approach(this.faceShift.x, sx * face.max_shift.x, 26, dt);
      this.faceShift.y = approach(this.faceShift.y, sy * face.max_shift.y, 26, dt);
      // целые пиксели арта — черты не «плывут» между пикселями
      const qx = Math.round(this.faceShift.x);
      const qy = Math.round(this.faceShift.y);
      // обратно в систему контейнера
      const px = qx * c - qy * sn;
      const py = qx * sn + qy * c;
      this.faceSprite.position.set(headPos.x - this.def.anchor.x + px, headPos.y - this.def.anchor.y + py);
      this.faceSprite.rotation = headTot;
    }

    for (const foot of this.feet) {
      const pv = foot.part.def.pivot;
      place(foot.part, pv.x, pv.y + this.pelvisDrop - foot.lift, foot.angle);
    }

    // ---- Руки: канаты. Здесь задаётся поза покоя и хват, остальное — физика
    const frame = { bodyX: s.bodyX, bodyY: s.bodyY, facing: f };
    this.fist.active = false;
    const speed = clamp(Math.abs(s.vx) / GAME_CONFIG.PLAYER_SPEED, 0, 1);
    const stepSin = Math.sin(this.time * 14);
    for (const arm of this.arms) {
      const side = arm.def.side ?? 1;
      const limb = arm.limb!;
      const sh = attach(arm.def.pivot);
      const rootX = s.bodyX + (sh.x - this.def.anchor.x) * f;
      const rootY = s.bodyY + (sh.y - this.def.anchor.y);

      // Сторона выгиба локтя (локально): левая рука выгибается влево-вниз, правая — вправо-вниз при опущенных руках
      const bend = side;
      const reachLen = limb.length;
      const restDir = limb.drawnAngle + this.torsoRot; // направление «как нарисовано» (локально)
      const dirWorld = (ang: number) => ({ x: f * Math.cos(ang), y: Math.sin(ang) });

      if (climb) {
        // Во время залезания руки не симулируются: поза однозначно задаётся хватом за край (нет дрожи)
        const grab = { x: climb.cornerX + climb.dir * (side === 1 ? 4 : 10), y: climb.cornerY - 1 };
        const rd = dirWorld(restDir);
        const rest = { x: rootX + rd.x * reachLen * 0.9, y: rootY + rd.y * reachLen * 0.9 };
        const pd = dirWorld(restDir + side * -0.5);
        const push = { x: rootX + pd.x * reachLen * 0.9, y: rootY + pd.y * reachLen * 0.9 };
        let tx = grab.x;
        let ty = grab.y;
        // Кисть переходит из позы в позу по ДУГЕ вокруг плеча (угол + длина), а не по прямой: прямая проходит
        // у самого плеча, и рука мгновенно разворачивалась бы на 180°. Сторона обхода — наружу от тела.
        const sweep = side * f;
        if (climb.phase === 'jump') {
          [tx, ty] = this.sweepVec(rootX, rootY, rest, grab, smoothstep(0.1, 0.75, climb.t), sweep); // тянутся к краю
        } else if (climb.phase === 'mantle') {
          [tx, ty] = this.sweepVec(rootX, rootY, grab, push, smoothstep(0.3, 0.65, climb.t), sweep); // отталкиваются от уступа
        }
        limb.setKinematic(dt, rootX, rootY, tx, ty, bend, frame);
        continue;
      }

      if (thr && side === thr.arm) {
        // Бросок: рука по дугам — вниз -> вверх впереди (замах, кисть над плечом) -> вперёд вдоль прицела (рывок над головой); дальше доводится
        const t = thr.time;
        const reach = limb.length;
        const rest = { x: rootX + dirWorld(restDir).x * reach * 0.9, y: rootY + dirWorld(restDir).y * reach * 0.9 };
        const cock = { x: rootX - thr.dirX * reach * 0.2, y: rootY - reach * 0.97 }; // кисть над плечом, чуть позади — рука поднята вертикально
        const fwd = { x: rootX + thr.dirX * reach * 0.98, y: rootY + thr.dirY * reach * 0.98 };
        const sweep = thr.dirX >= 0 ? 1 : -1;
        let tx: number;
        let ty: number;
        if (t < THROW_WINDUP) {
          // рука поднимается вверх ВПЕРЁД по обычному повороту (а не заводится назад за спину), затем бросок над головой
          [tx, ty] = this.sweepVec(rootX, rootY, rest, cock, smoothstep(0, 1, t / THROW_WINDUP), -sweep);
        } else {
          [tx, ty] = this.sweepVec(rootX, rootY, cock, fwd, easeOutQuad(clamp((t - THROW_WINDUP) / THROW_SWING, 0, 1)), sweep);
        }
        limb.setKinematic(dt, rootX, rootY, tx, ty, bend, frame, THROW_BLEND);
        const tip = limb.tip;
        this.hand.x = tip.x;
        this.hand.y = tip.y;
        this.hand.active = true;
        if (this.gear) {
          // шестерёнка в кисти на замахе (в броске — пока не отпущена), вертится
          const hold = thr.gear && t < THROW_RELEASE;
          this.gear.visible = hold;
          if (hold) {
            this.gear.position.set((tip.x - s.bodyX) * f, tip.y - s.bodyY);
            this.gear.rotation = this.time * 14;
          }
        }
        continue;
      }

      if (beam && side === beam.arm) {
        // Луч молнии: рука вытянута к курсору и держится, кисть — источник луча
        const reach = limb.length;
        limb.setKinematic(dt, rootX, rootY, rootX + beam.dirX * reach * 0.98, rootY + beam.dirY * reach * 0.98, bend, frame, 24);
        const tip = limb.tip;
        this.hand.x = tip.x;
        this.hand.y = tip.y;
        this.hand.active = true;
        continue;
      }

      if (punch && side === punch.arm) {
        // Удар: рука резко выбрасывается от плеча по направлению удара (дуга без физики)
        const t = punch.time;
        const reach = limb.length;
        const k = t < PUNCH_WINDUP
          ? PUNCH_FOLDED
          : PUNCH_FOLDED + (PUNCH_REACH - PUNCH_FOLDED) * easeOutQuad(clamp((t - PUNCH_WINDUP) / PUNCH_STRIKE, 0, 1));
        const tx = rootX + punch.dirX * reach * k;
        const ty = rootY + punch.dirY * reach * k;
        limb.setKinematic(dt, rootX, rootY, tx, ty, bend, frame, PUNCH_BLEND, Math.max(1, k));
        const fist = this.fist;
        fist.active = k > 1.1; // рука выпрямлена и растягивается — удар засчитывается
        fist.x1 = rootX; fist.y1 = rootY; fist.x2 = tx; fist.y2 = ty;
        continue;
      }

      if (s.kick !== null && !s.grounded && s.kickAlong) {
        // Рывок вверх по стене: руки перехватывают стену выше — по очереди, ладони на стене
        const k = s.kick;
        const high = side === 1 ? 0.95 - 0.3 * smoothstep(0.3, 1, k) : 0.6 + 0.35 * smoothstep(0, 0.6, k);
        limb.setKinematic(dt, rootX, rootY, s.wallX - f * (side === 1 ? 3 : 1), rootY - reachLen * high, bend, frame);
        continue;
      }

      if (s.kick !== null && !s.grounded && s.kick < 0.85) {
        // Отталкивание от стены: руки упираются в стену позади, затем взмахивают вверх-вперёд (дуга, без физики)
        const locBack = { x: rootX + f * -0.95 * reachLen * 0.92, y: rootY + 0.1 * reachLen * 0.92 };
        const locThrow = { x: rootX + f * 0.55 * reachLen * 0.95, y: rootY - 0.82 * reachLen * 0.95 };
        const [kx, ky] = this.sweepVec(rootX, rootY, locBack, locThrow, smoothstep(0.2, 0.65, s.kick), f);
        limb.setKinematic(dt, rootX, rootY, kx, ky, bend, frame);
        continue;
      }

      if (s.wall !== 0 && !s.grounded && side === -1) {
        // Скольжение по стене: передняя рука (к стене) упирается ладонью в стену на уровне головы
        const wallDirLocal = s.wall * f; // стена впереди (+1) или сзади (-1) относительно взгляда
        if (wallDirLocal > 0) {
          limb.setKinematic(dt, rootX, rootY, s.wallX, rootY - 7, bend, frame);
          continue;
        }
      }


      let rest = Math.sin(this.time * 1.3 + side) * 0.03; // лёгкое покачивание в покое
      if (s.grounded) {
        rest += -stepSin * side * 0.3 * speed; // руки качаются против ног
      } else {
        rest += side * 0.5 * clamp(s.vy / 400, -0.3, 1); // в падении руки уходят вверх-в стороны
      }
      limb.update(dt, rootX, rootY, limb.drawnAngle + this.torsoRot + rest, 1, frame, null);
    }

    this.wasClimbing = !!climb;
    if (!thr && !beam) {
      this.hand.active = false;
      if (this.gear) this.gear.visible = false;
    }
  }

  /** Пружина ног: затухающие колебания сжатия (фиксированный шаг — одинаково при любом dt). В воздухе ноги распрямляются. */
  private updateLandSpring(dt: number, active: boolean): void {
    if (!active) {
      this.landC = approach(this.landC, 0, 20, dt);
      this.landV = 0;
      return;
    }
    const c = 2 * LAND_DAMPING * Math.sqrt(LAND_STIFF);
    this.landAcc = Math.min(this.landAcc + Math.min(dt, 1 / 30), LAND_STEP * 12);
    while (this.landAcc >= LAND_STEP) {
      this.landAcc -= LAND_STEP;
      this.landV += (-LAND_STIFF * this.landC - c * this.landV) * LAND_STEP;
      this.landC += this.landV * LAND_STEP;
      if (this.landC > LAND_MAX) { this.landC = LAND_MAX; this.landV = Math.min(this.landV, 0); }
      if (this.landC < -1.5) { this.landC = -1.5; this.landV = Math.max(this.landV, 0); } // распрямляясь, чуть «подпрыгивает» не выше 1.5 px
    }
  }

  /** Геометрия тела для регдолла: таз, шея, центр головы, бёдра и длины ног — в координатах холста. */
  public ragdollGeometry(): RagdollGeometry {
    return {
      anchor: this.def.anchor, waist: this.torso.def.pivot, neck: this.head.def.pivot, head: this.headCenter,
      hips: this.feet.map((foot) => ({ at: foot.part.def.pivot, length: foot.length }))
    };
  }

  /**
   * Поза из регдолла: торс — от таза к шее, голова — от шеи к центру головы, ноги — от бёдер (едут вместе с торсом) к стопам;
   * руки — канаты, почти без силы позы (болтаются и падают под весом) и с упором в тайлы. Все части — в той же системе
   * зеркалируемого контейнера, что и обычная поза: после подъёма анимация продолжается без скачка.
   */
  private poseRagdoll(dt: number, s: RigPose, rd: Ragdoll, solid: (x: number, y: number) => boolean): void {
    const f = s.facing;
    const a = this.def.anchor;
    const toCanvas = (p: { x: number; y: number }) => ({ x: (p.x - s.bodyX) * f + a.x, y: p.y - s.bodyY + a.y });
    const [pw, nw, hw, ...feetW] = rd.points;
    const P = toCanvas(pw);
    const Nk = toCanvas(nw);
    const Hd = toCanvas(hw);
    const waist = this.torso.def.pivot;
    const neck = this.head.def.pivot;
    const hc = this.headCenter;
    const torsoRot = Math.atan2(Nk.y - P.y, Nk.x - P.x) - Math.atan2(neck.y - waist.y, neck.x - waist.x);
    const headAbs = Math.atan2(Hd.y - Nk.y, Hd.x - Nk.x) - Math.atan2(hc.y - neck.y, hc.x - neck.x);
    const c = Math.cos(torsoRot);
    const sn = Math.sin(torsoRot);
    const onTorso = (p: { x: number; y: number }) => {
      const rx = p.x - waist.x;
      const ry = p.y - waist.y;
      return { x: P.x + rx * c - ry * sn, y: P.y + rx * sn + ry * c };
    };
    const place = (part: Part, x: number, y: number, rot: number) => {
      part.sprite!.position.set(x - a.x, y - a.y);
      part.sprite!.rotation = rot;
    };

    this.tiltRot = 0;
    this.tilt.rotation = 0;
    this.torsoRot = torsoRot;
    this.headRot = headAbs - torsoRot;
    this.pelvisDrop = 0;
    this.landC = this.landV = 0;
    this.prevTilt = 0;
    place(this.torso, P.x, P.y, torsoRot);
    const headPos = onTorso(neck);
    place(this.head, headPos.x, headPos.y, headAbs);
    if (this.faceSprite) {
      this.faceShift.x = this.faceShift.y = 0;
      this.faceSprite.position.set(headPos.x - a.x, headPos.y - a.y);
      this.faceSprite.rotation = headAbs;
    }
    this.feet.forEach((foot, i) => {
      const hip = onTorso(foot.part.def.pivot);
      const ft = feetW[i] ? toCanvas(feetW[i]) : { x: hip.x, y: hip.y + foot.length };
      const rot = Math.atan2(ft.y - hip.y, ft.x - hip.x) - Math.PI / 2;
      foot.angle = rot;
      foot.lift = 0;
      foot.air = true; // после подъёма стопы заново встанут под таз
      foot.swing = false;
      place(foot.part, hip.x, hip.y, rot);
    });

    const frame = { bodyX: s.bodyX, bodyY: s.bodyY, facing: f };
    this.fist.active = false;
    for (const arm of this.arms) {
      const sh = onTorso(arm.def.pivot);
      const rootX = s.bodyX + (sh.x - a.x) * f;
      const rootY = s.bodyY + (sh.y - a.y);
      arm.limb!.update(dt, rootX, rootY, arm.limb!.drawnAngle + torsoRot, RAGDOLL_ARM_STIFF, frame, null, solid);
    }
    this.wasClimbing = false;
    this.wasGrounded = true;
  }

  /**
   * Точка между a и b, считая от плеча (rootX, rootY): угол и длина вектора меняются плавно, поворот — в сторону sweep
   * (+1 — по возрастанию угла/по часовой на экране, -1 — против), даже если дуга длиннее 180°.
   */
  private sweepVec(
    rootX: number, rootY: number, a: { x: number; y: number }, b: { x: number; y: number }, k: number, sweep: number
  ): [number, number] {
    const ax = a.x - rootX, ay = a.y - rootY, bx = b.x - rootX, by = b.y - rootY;
    const a0 = Math.atan2(ay, ax);
    let d = Math.atan2(by, bx) - a0;
    if (sweep > 0) { while (d < 0) d += Math.PI * 2; } else { while (d > 0) d -= Math.PI * 2; }
    const ang = a0 + d * k;
    const len = Math.hypot(ax, ay) + (Math.hypot(bx, by) - Math.hypot(ax, ay)) * k;
    return [rootX + Math.cos(ang) * len, rootY + Math.sin(ang) * len];
  }

  /** Горизонтальное положение таза над ногой (мир). */
  private hipWorldX(foot: Foot, s: RigPose): number {
    return s.bodyX + (foot.part.def.pivot.x - this.def.anchor.x) * s.facing;
  }

  private relOf(foot: Foot, s: RigPose): number {
    return (foot.wx - this.hipWorldX(foot, s)) * s.facing;
  }

  /**
   * Физичные ноги. Возвращает, насколько надо опустить таз (px), чтобы стоящая нога доставала до земли.
   */
  private updateLegs(dt: number, s: RigPose): number {
    const f = s.facing;
    const speedL = s.vx * f;
    const moving = Math.abs(speedL) > 8;
    let drop = Number.POSITIVE_INFINITY;

    for (const foot of this.feet) {
      const L = foot.length;
      const reach = L * Math.sin(LEG_MAX_ANGLE);
      const hipX = this.hipWorldX(foot, s);

      if (!s.grounded && s.kick !== null && s.kickAlong) {
        // Рывок вверх по стене: стопы сначала упираются в стену ниже, отталкиваются вниз и подтягиваются
        foot.air = true;
        foot.swing = false;
        const k = smoothstep(0.15, 0.6, s.kick);
        const target = (-0.65 + foot.side * 0.1) * (1 - k) + (-0.15 + foot.side * 0.2) * k;
        foot.angle = approach(foot.angle, target, 26, dt);
        foot.lift = approach(foot.lift, 4 * k, 22, dt);
        continue;
      }

      if (!s.grounded && s.kick !== null) {
        // Отталкивание: сначала стопы упираются в стену (она сзади), затем подтягиваются
        foot.air = true;
        foot.swing = false;
        const k = smoothstep(0.3, 0.7, s.kick);
        const target = (0.85 + foot.side * 0.1) * (1 - k) + foot.side * 0.55 * k;
        foot.angle = approach(foot.angle, target, 24, dt);
        foot.lift = approach(foot.lift, 3 * k, 20, dt);
        continue;
      }

      if (!s.grounded) {
        // В воздухе ноги болтаются: расходятся, при падении шире, отстают от движения
        foot.air = true;
        foot.swing = false;
        if (s.wall !== 0) {
          // Скольжение по стене: стопы упираются в стену впереди
          const toward = s.wall * f > 0 ? -0.5 : 0.5; // знак: поворот по часовой уводит стопу влево
          foot.angle = approach(foot.angle, toward + foot.side * 0.12, 18, dt);
          foot.lift = approach(foot.lift, 0, 20, dt);
          continue;
        }
        const target = foot.side * (0.3 + 0.3 * clamp(s.vy / 300, 0, 1) - 0.15 * clamp(-s.vy / 300, 0, 1)) - speedL * 0.0012;
        foot.angle = approach(foot.angle, target, 14, dt);
        foot.lift = approach(foot.lift, 0, 20, dt);
        continue;
      }

      if (foot.air || this.wasClimbing) {
        // Приземление: стопа встаёт под таз
        foot.air = false;
        foot.swing = false;
        foot.wx = hipX;
      }

      const other = this.feet.find((o) => o !== foot)!;
      let rel = (foot.wx - hipX) * f; // положение стопы относительно таза, вперёд = +

      if (foot.swing) {
        foot.swingT += dt;
        const u = clamp(foot.swingT / foot.swingDur, 0, 1);
        const targetWx = hipX + foot.swingRel * f;
        foot.wx = foot.swingFrom + (targetWx - foot.swingFrom) * smoothstep(0, 1, u);
        foot.lift = STEP_LIFT * Math.sin(Math.PI * u) * (moving ? 1 : 0.5);
        if (u >= 1) { foot.swing = false; foot.lift = 0; }
        rel = (foot.wx - hipX) * f;
      } else {
        foot.lift = approach(foot.lift, 0, 30, dt);
        const needStep = moving
          ? rel < -reach * STEP_TRIGGER && rel <= this.relOf(other, s) + (foot.side === 1 ? 0.01 : -0.01)
          : Math.abs(rel) > 1.5;
        if (needStep && !other.swing) {
          foot.swing = true;
          foot.swingFrom = foot.wx;
          foot.swingT = 0;
          foot.swingRel = moving ? reach * STEP_AHEAD : 0;
          foot.swingDur = moving ? clamp(0.09 - Math.abs(speedL) * 0.0002, 0.06, 0.09) : 0.12;
        }
      }

      // Угол ноги: стопа в точке rel (в пределах максимального разворота)
      const sinA = clamp(rel / L, -Math.sin(LEG_MAX_ANGLE), Math.sin(LEG_MAX_ANGLE));
      const a = Math.asin(sinA);
      // сжатие после приземления: нога разворачивается наружу (от центра таза) так, чтобы таз опустился на landC, а стопа осталась на земле
      const out = Math.sign(foot.part.def.pivot.x - this.torso.def.pivot.x) || foot.side;
      const splay = this.landC > 0 ? Math.acos(clamp(1 - this.landC / L, 0, 1)) : 0;
      const ang = -a - out * splay; // вращение по часовой уводит стопу влево, поэтому знак минус
      foot.angle = approach(foot.angle, ang, 45, dt);
      if (!foot.swing) drop = Math.min(drop, L * (1 - Math.cos(ang)));
    }
    return Number.isFinite(drop) ? drop : 0;
  }

  /** Ноги при залезании: подбор под себя, упор в стену, карабканье. */
  private updateLegsClimb(dt: number, c: ClimbPose): number {
    for (const foot of this.feet) {
      foot.air = true; // после залезания стопы заново встанут под таз
      foot.swing = false;
      const alt = foot.side === 1 ? 0 : Math.PI;
      let target: number;
      let lift = 0;
      switch (c.phase) {
        case 'jump': // подтягивают ноги в прыжке
          target = foot.side * (0.5 - 0.25 * c.t);
          lift = 3 * Math.sin(Math.PI * c.t);
          break;
        case 'hang': // болтаются, нащупывая стену
          target = foot.side * 0.15 - 0.5 + 0.2 * Math.sin(this.time * 9 + alt);
          break;
        default: { // карабкаются по стене, упираясь стопами вперёд
          const sc = Math.sin(this.time * 24 + alt);
          target = -0.55 + 0.45 * sc;
          lift = Math.max(0, sc) * 3.5;
        }
      }
      foot.angle = approach(foot.angle, target, 25, dt);
      foot.lift = approach(foot.lift, lift, 25, dt);
    }
    return 0;
  }
}
