import { Container, Sprite } from 'pixi.js';
import { RopeLimb } from './RopeLimb.ts';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import { GAME_CONFIG } from '../core/Constants.ts';
import type { RigDef, RigPartDef } from '../data/types.ts';

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
  climb: number | null; // прогресс залезания на преграду 0..1, null — не лезет
}

interface Part {
  def: RigPartDef;
  sprite: Sprite | null; // у рук-канатов вместо спрайта — limb
  limb: RopeLimb | null;
}

// Настройки процедурной анимации
const STEP_RATE = 11; // рад/с фазы шага при полной скорости
const LEG_SWING = 0.65; // амплитуда качания ног, рад
const HEAD_FOLLOW = 0.5; // максимальный поворот головы за курсором, рад
const TORSO_FOLLOW = 0.12; // торс поворачивается заметно слабее
const ARM_CLIMB_STIFFNESS = 2.2; // при залезании руки «собраны» и тянутся к уступу

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Процедурная анимация робота из частей-слоёв (data/rigs/*.json):
 * ходьба ногами, голова и торс поворачиваются за курсором, руки — физичные канаты (verlet),
 * отдельная поза при залезании на преграду.
 */
export class PlayerRig {
  public readonly container = new Container();

  private parts: Part[] = [];
  private torso: Part;
  private head: Part;
  private time = 0;
  private phase = 0;
  private torsoRot = 0;
  private headRot = 0;
  private legAngles = new Map<Part, number>();
  private arms: Part[] = [];

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
      if (p.role === 'leg') this.legAngles.set(part, 0);
      if (p.role === 'arm') this.arms.push(part);
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
    const climbing = s.climb !== null;
    const speed = clamp(Math.abs(s.vx) / GAME_CONFIG.PLAYER_SPEED, 0, 1);
    const walk = s.grounded && !climbing ? speed : 0;
    if (walk > 0) this.phase += dt * STEP_RATE * (0.6 + 0.4 * walk);
    const stepSin = Math.sin(this.phase);

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

    // ---- Торс и голова
    let torsoTarget = nx * TORSO_FOLLOW + 0.05 * walk;
    let headTarget = clamp(nx * HEAD_FOLLOW, -HEAD_FOLLOW, HEAD_FOLLOW);
    if (climbing) {
      const p = s.climb!;
      torsoTarget = -0.12 * (1 - smoothstep(0.1, 0.4, p)) + 0.28 * smoothstep(0.45, 0.85, p);
      headTarget = -0.2 * (1 - smoothstep(0.5, 0.9, p));
    }
    this.torsoRot = approach(this.torsoRot, torsoTarget, 14, dt);
    this.headRot = approach(this.headRot, headTarget, 18, dt);

    const bob = walk > 0 ? -Math.abs(stepSin) * 1.4 * walk : 0;
    const breathe = Math.sin(this.time * 2.4) * 0.4 * (1 - walk);
    const torsoOy = bob + breathe + (climbing ? 1 : 0);
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

    // ---- Ноги
    for (const [leg, angle] of this.legAngles) {
      const side = leg.def.side ?? 1;
      let target: number;
      let lift = 0;
      if (climbing) {
        const sc = Math.sin(this.time * 24 + (side === 1 ? 0 : Math.PI));
        target = sc * 0.9;
        lift = Math.max(0, sc) * 4;
      } else if (s.grounded) {
        const sw = stepSin * side; // ноги в противофазе
        target = sw * LEG_SWING * walk;
        lift = Math.max(0, sw) * 3 * walk;
      } else {
        // в воздухе: разводим ноги, при падении шире
        target = side * (0.3 + 0.3 * clamp(s.vy / 300, 0, 1) - 0.15 * clamp(-s.vy / 300, 0, 1));
      }
      const a = approach(angle, target, 22, dt);
      this.legAngles.set(leg, a);
      const pv = leg.def.pivot;
      place(leg, pv.x, pv.y - lift, a);
    }

    // ---- Руки: канаты. Здесь задаётся только поза покоя (куда рука «хочет» тянуться), остальное — физика
    const frame = { bodyX: s.bodyX, bodyY: s.bodyY, facing: f };
    for (const arm of this.arms) {
      const side = arm.def.side ?? 1;
      let rest = Math.sin(this.time * 1.3 + side) * 0.03; // лёгкое покачивание в покое
      let stiffness = 1;
      if (climbing) {
        const p = s.climb!;
        const reach = smoothstep(0, 0.15, p) * (1 - smoothstep(0.55, 0.8, p));
        const push = smoothstep(0.55, 0.8, p);
        rest = side * (1.8 * reach - 0.4 * push);
        stiffness = ARM_CLIMB_STIFFNESS;
      } else if (s.grounded) {
        rest += -stepSin * side * 0.45 * walk; // руки качаются против ног
      } else {
        rest += side * 0.5 * clamp(s.vy / 400, -0.3, 1); // в падении руки уходят вверх-в стороны
      }
      const limb = arm.limb!;
      const sh = attach(arm.def.pivot);
      limb.update(
        dt,
        s.bodyX + (sh.x - this.def.anchor.x) * f,
        s.bodyY + (sh.y - this.def.anchor.y),
        limb.drawnAngle + this.torsoRot + rest,
        stiffness,
        frame
      );
    }
  }
}
