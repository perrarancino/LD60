import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { RigDef, RigPartDef } from '../data/types.ts';
import { splitFace } from './FaceSplit.ts';
import { RopeLimb } from './RopeLimb.ts';

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

/** Бьющая часть руки в мире: от плеча к кулаку. active — кулак выброшен и может попасть. */
export interface Fist {
  active: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Потеря равновесия после падения с высоты: t — прогресс 0..1 (удар -> падение -> лежит -> встаёт), dir — вперёд (+1) или назад (-1). */
export interface StumblePose {
  t: number;
  dir: 1 | -1;
  power: number; // 0..1: сила падения
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
  stumble?: StumblePose | null; // упал с высоты: теряет равновесие и встаёт
}

interface Part {
  def: RigPartDef;
  sprite: Sprite | null; // у рук-канатов вместо спрайта — limb
  limb: RopeLimb | null;
}

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
const LAND_DIP = 7; // px: на сколько проседает таз при жёстком приземлении (без потери равновесия)
const STUMBLE_TILT = 1.25; // рад: наклон всего тела, когда герой упал
const STUMBLE_LOWER = 17; // px: на сколько опускается тело (лежит на земле)

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
  private tiltDown = 0; // px: опускание всего тела (упал)
  private landDip = 0; // px: просадка таза после приземления, затухает
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
  private prevTilt = 0; // наклон головы к курсору в прошлом кадре (торс следует за ним)
  /** Центр головы в координатах холста (по непрозрачным пикселям) — от него считается направление на курсор. */
  private headCenter: { x: number; y: number };

  constructor(private readonly def: RigDef, sprites: SpriteLibrary) {
    this.tilt.position.set(0, -28); // центр вращения — середина тела
    this.tilt.pivot.set(0, -28);
    this.container.addChild(this.tilt);
    for (const p of def.parts) {
      let part: Part;
      if (p.role === 'arm' && p.rope) {
        const limb = new RopeLimb(sprites.imageData(p.sprite_id), p.pivot, p.rope.segments);
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
    this.update(0, {
      bodyX: 0, bodyY: 0, vx: 0, vy: 0, facing: 1, grounded: true, aimX: 0, aimY: 0, climb: null, kick: null, wall: 0, wallX: 0
    });
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

    // ---- Курсор в локальных координатах от центра головы (вперёд = +x)
    const hc = this.headCenter;
    const headWorldX = s.bodyX + (hc.x - this.def.anchor.x) * f;
    const headWorldY = s.bodyY + (hc.y - this.def.anchor.y) + this.pelvisDrop;
    const dx = (s.aimX - headWorldX) * f;
    const dy = s.aimY - headWorldY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const gain = Math.min(1, dist / 24); // у самой головы курсор не дёргает её
    const nx = (dx / dist) * gain;

    // ---- Приземление: таз проседает по силе удара о землю и пружинит обратно
    if (s.grounded && !this.wasGrounded && !climb && !s.stumble) this.landDip = LAND_DIP * clamp((this.airVy - 150) / 450, 0, 1);
    if (!s.grounded) this.airVy = s.vy;
    this.wasGrounded = s.grounded;
    this.landDip = approach(this.landDip, 0, 9, dt);

    // ---- Потеря равновесия: удар (присед) -> падение (всё тело наклоняется и опускается) -> лежит -> встаёт
    const st = !climb && s.stumble ? s.stumble : null;
    const fallAmt = st ? smoothstep(0.1, 0.32, st.t) * (1 - smoothstep(0.6, 0.97, st.t)) : 0;
    const impact = st && st.t < 0.14 ? (5 + 3 * st.power) * Math.sin((Math.PI * st.t) / 0.14) : 0;
    const bounce = st ? 2 * Math.sin(Math.PI * clamp((st.t - 0.3) / 0.12, 0, 1)) : 0; // отскок тела при ударе о землю

    // ---- Ноги: шаговый контроллер -> просадка таза
    const drop = climb ? this.updateLegsClimb(dt, climb) : this.updateLegs(dt, s, fallAmt);
    this.pelvisDrop = approach(this.pelvisDrop, drop + this.landDip + impact, 40, dt);

    // ---- Торс и голова
    let torsoTarget = this.prevTilt * TORSO_FOLLOW + 0.04 * clamp(speedL / GAME_CONFIG.PLAYER_SPEED, -1, 1);
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
    if (st) {
      // упал: всё тело заваливается вперёд или назад, голова — к земле; встаёт с лёгким перевесом в другую сторону
      const recover = Math.sin(Math.PI * clamp((st.t - 0.75) / 0.25, 0, 1));
      tiltTarget = st.dir * (STUMBLE_TILT + 0.2 * st.power) * fallAmt - st.dir * 0.12 * recover;
      torsoTarget = st.dir * 0.25 * fallAmt;
      headTarget = -st.dir * 0.35 * fallAmt;
    } else if (kick !== null && !climb && s.kickAlong) {
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
    const punch = s.punch && !climb ? s.punch : null;
    if (punch) {
      // Удар: торс подаётся в сторону удара (вперёд по взгляду +, назад -), пик — в момент выброса руки
      const arc = Math.sin(Math.PI * clamp(punch.time / PUNCH_DURATION, 0, 1));
      torsoTarget += PUNCH_LEAN * clamp(punch.dirX * f, -1, 1) * arc;
    }
    this.tiltRot = approach(this.tiltRot, tiltTarget, st ? 16 : 20, dt);
    this.tilt.rotation = this.tiltRot;
    this.tiltDown = approach(this.tiltDown, st ? STUMBLE_LOWER * fallAmt - bounce : 0, 18, dt);
    this.tilt.position.y = -28 + this.tiltDown;
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
      const eye = this.head.def.gaze_origin ?? this.headCenter;
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
      if (st) {
        // падение: руки взлетают и машут, потом выставляются вперёд по ходу падения — упереться в землю
        rest += -st.dir * 1.3 * fallAmt + side * 0.6 * Math.sin(this.time * 13 + side) * (1 - fallAmt) * (st.t < 0.35 ? 1 : 0);
      } else if (s.grounded) {
        rest += -stepSin * side * 0.3 * speed; // руки качаются против ног
      } else {
        rest += side * 0.5 * clamp(s.vy / 400, -0.3, 1); // в падении руки уходят вверх-в стороны
      }
      limb.update(dt, rootX, rootY, limb.drawnAngle + this.torsoRot + rest, 1, frame, null);
    }

    this.wasClimbing = !!climb;
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
  private updateLegs(dt: number, s: RigPose, fallAmt = 0): number {
    const f = s.facing;
    const speedL = s.vx * f;
    const moving = Math.abs(speedL) > 8;
    let drop = Number.POSITIVE_INFINITY;

    for (const foot of this.feet) {
      const L = foot.length;
      const reach = L * Math.sin(LEG_MAX_ANGLE);
      const hipX = this.hipWorldX(foot, s);

      if (s.stumble) {
        // упал: ноги разъезжаются и подгибаются (тело наклонено целиком); когда встанет — стопы заново встанут под таз
        foot.air = true;
        foot.swing = false;
        const st = s.stumble;
        foot.angle = approach(foot.angle, foot.side * (0.15 + 0.35 * fallAmt) - st.dir * 0.45 * fallAmt, 16, dt);
        foot.lift = approach(foot.lift, 2 * fallAmt, 16, dt);
        continue;
      }

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
      foot.angle = approach(foot.angle, -a, 45, dt); // вращение по часовой уводит стопу влево, поэтому знак минус
      if (!foot.swing) drop = Math.min(drop, L * (1 - Math.cos(a)));
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
