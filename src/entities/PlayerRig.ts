import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { RigDef, RigPartDef } from '../data/types.ts';
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
const HEAD_FOLLOW = 0.5; // максимальный поворот головы за курсором, рад
const TORSO_FOLLOW = 0.12; // торс поворачивается заметно слабее
const LEG_MAX_ANGLE = 1.0; // максимальный разворот ноги от вертикали, рад
const STEP_TRIGGER = 0.6; // шаг, когда стопа отстала от таза на эту долю досягаемости
const STEP_AHEAD = 0.55; // стопа приземляется впереди таза на эту долю досягаемости
const STEP_LIFT = 3.5; // высота подъёма стопы в махе, px
const ARM_CLIMB_STIFFNESS = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Процедурная анимация робота из частей-слоёв (data/rigs/*.json):
 *  - ноги физичны: стопы «приклеены» к земле, при уходе тела делают шаги, таз проседает при широкой постановке;
 *  - голова и торс поворачиваются за курсором;
 *  - руки — канаты (verlet), могут жёстко цепляться кистью за точку (уступ);
 *  - залезание: подпрыгивание, хват за край, подтягивание, перекат на уступ.
 */
export class PlayerRig {
  public readonly container = new Container();

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

  constructor(private readonly def: RigDef, sprites: SpriteLibrary) {
    for (const p of def.parts) {
      let part: Part;
      if (p.role === 'arm' && p.rope) {
        const limb = new RopeLimb(sprites.imageData(p.sprite_id), p.pivot, p.rope.segments);
        part = { def: p, sprite: null, limb };
        this.container.addChild(limb.container);
      } else {
        const sprite = sprites.createSprite(p.sprite_id);
        sprite.pivot.set(p.pivot.x, p.pivot.y);
        part = { def: p, sprite, limb: null };
        this.container.addChild(sprite);
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
    this.update(0, {
      bodyX: 0, bodyY: 0, vx: 0, vy: 0, facing: 1, grounded: true, aimX: 0, aimY: 0, climb: null
    });
  }

  public update(dt: number, s: RigPose): void {
    this.time += dt;
    const f = s.facing;
    const climb = s.climb;
    const speedL = s.vx * f; // скорость вдоль направления взгляда

    this.container.scale.x = f;

    // ---- Курсор в локальных координатах головы (вперёд = +x), нормированный вектор прицеливания
    const neck = this.head.def.pivot;
    const headWorldX = s.bodyX + (neck.x - this.def.anchor.x) * f;
    const headWorldY = s.bodyY + (neck.y - this.def.anchor.y);
    const dx = (s.aimX - headWorldX) * f;
    const dy = s.aimY - headWorldY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const gain = Math.min(1, dist / 24); // у самой головы курсор не дёргает её
    const nx = (dx / dist) * gain;
    const ny = (dy / dist) * gain;

    // ---- Ноги: шаговый контроллер -> просадка таза
    const drop = climb ? this.updateLegsClimb(dt, climb) : this.updateLegs(dt, s);
    this.pelvisDrop = approach(this.pelvisDrop, drop, 40, dt);

    // ---- Торс и голова
    let torsoTarget = nx * TORSO_FOLLOW + 0.04 * clamp(speedL / GAME_CONFIG.PLAYER_SPEED, -1, 1);
    let headTarget = clamp(nx * HEAD_FOLLOW, -HEAD_FOLLOW, HEAD_FOLLOW);
    let torsoLift = 0;
    if (climb) {
      switch (climb.phase) {
        case 'jump': torsoTarget = -0.15; headTarget = -0.3; torsoLift = -2 * Math.sin(Math.PI * climb.t); break;
        case 'hang': torsoTarget = -0.05; headTarget = -0.3; torsoLift = 1; break;
        case 'pull': torsoTarget = 0.1 * climb.t; headTarget = -0.25 * (1 - climb.t); break;
        case 'mantle': torsoTarget = 0.3 * Math.sin(Math.PI * Math.min(1, climb.t * 1.2)); headTarget = 0.05; break;
      }
    }
    this.torsoRot = approach(this.torsoRot, torsoTarget, 14, dt);
    this.headRot = approach(this.headRot, headTarget, 18, dt);

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
    place(this.head, headPos.x + nx * 1.5, headPos.y + ny, this.torsoRot + this.headRot);

    for (const foot of this.feet) {
      const pv = foot.part.def.pivot;
      place(foot.part, pv.x, pv.y + this.pelvisDrop - foot.lift, foot.angle);
    }

    // ---- Руки: канаты. Здесь задаётся поза покоя и хват, остальное — физика
    const frame = { bodyX: s.bodyX, bodyY: s.bodyY, facing: f };
    const speed = clamp(Math.abs(s.vx) / GAME_CONFIG.PLAYER_SPEED, 0, 1);
    const stepSin = Math.sin(this.time * 14);
    for (const arm of this.arms) {
      const side = arm.def.side ?? 1;
      const limb = arm.limb!;
      const sh = attach(arm.def.pivot);
      const rootX = s.bodyX + (sh.x - this.def.anchor.x) * f;
      const rootY = s.bodyY + (sh.y - this.def.anchor.y);

      if (climb) {
        const gx = climb.cornerX + climb.dir * (side === 1 ? 1 : 6); // две кисти на верхней грани уступа
        const gy = climb.cornerY - 1;
        const grab = climb.phase === 'hang' || climb.phase === 'pull' || (climb.phase === 'jump' && climb.t > 0.55)
          || (climb.phase === 'mantle' && climb.t < 0.3);
        let rest: number;
        if (climb.phase === 'mantle' && climb.t >= 0.3) {
          rest = limb.drawnAngle + this.torsoRot + side * -0.5; // отталкиваются от уступа
        } else {
          rest = Math.atan2(gy - rootY, (gx - rootX) * f); // тянутся к уступу (локальные координаты)
        }
        limb.update(dt, rootX, rootY, rest, ARM_CLIMB_STIFFNESS, frame, grab ? { x: gx, y: gy } : null);
        continue;
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

      if (!s.grounded) {
        // В воздухе ноги болтаются: расходятся, при падении шире, отстают от движения
        foot.air = true;
        foot.swing = false;
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
