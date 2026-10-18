import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { CritterAnimDef, CritterDef, EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { Body } from './Body.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, Hittable } from './Hittable.ts';

const GRAVITY = 850; // px/с²
const CHASE_BOOST = 1.5; // во сколько раз быстрее бежит, заметив героя
const LEDGE_PROBE = 4; // px: проверка земли впереди
const MOVE_RATE = 9; // 1/с: насколько быстро «движется» (для анимации) догоняет скорость
const HOP_TIME: [number, number] = [0.7, 2.1]; // с: пауза между прыжками воробья
const HOP_SPEED: [number, number] = [180, 250]; // px/с: прыжок вверх
const HOP_RUN: [number, number] = [50, 95]; // px/с: прыжок вперёд
const FLY_TURN = 2.6; // рад/с: как круто разворачивается птичка
const FLY_RADIUS = 110; // px: на сколько птичка разлетается от точки появления
const SEE_HEIGHT = 80; // px: на такой разнице высот герой считается «рядом»
const PART_SMOOTH = 16; // 1/с: насколько быстро детали догоняют целевую позу — убирает рывки анимации
const FLIP_RATE = 15; // 1/с: плавный разворот (рисунок сжимается через ноль и раскрывается в другую сторону)
const AIR_RATE = 10; // 1/с: плавный переход «на земле» ↔ «в воздухе» (взмахи крыла не включаются щелчком)
const SQUASH_K = 190; // 1/с²: пружина сжатия/растяжения тела на прыжке и приземлении
const SQUASH_D = 17; // 1/с: её затухание

interface Vec {
  x: number;
  y: number;
}

interface Part {
  sprite: Sprite;
  pivot: Vec;
  anims: CritterAnimDef[];
  cur: { dx: number; dy: number; rot: number; sy: number }; // сглаженное состояние детали (пружина к целевому)
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Небольшое существо из слоёв с процедурной анимацией (data/rigs/*.json, блок critter). Четыре повадки:
 *  - walker (крыса): ходит по полу туда-обратно, у края и стены разворачивается, заметив героя — бросается на него быстрее;
 *  - hopper (воробей): скачет прыжками, на земле клюёт, от героя отскакивает;
 *  - flyer (птичка): летает петлями вокруг точки появления, огибая тайлы;
 *  - watcher (страж): стоит на месте и провожает героя взглядом.
 * Детали рига вращаются и сдвигаются вокруг своих точек (шаг лап, взмах, качание хвоста, клёв, парение), рисунок не пересэмплируется.
 */
export class Critter implements Hittable {
  public readonly container = new Container();

  private readonly node = new Container(); // рисунок: pivot — точка привязки холста, зеркалится по ходу
  private readonly parts: Part[] = [];
  private readonly cfg: CritterDef;
  private readonly body = new Body(); // физика (ходьба и прыжки); у летающих и стражей не используется
  private readonly react: HitReaction;
  private readonly anchor: Vec;
  private readonly speed: number;
  private readonly home: Vec;
  private readonly seed = Math.random() * 100;

  private dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1; // куда идёт (мир)
  private facing: 1 | -1 = this.dir;
  private t = Math.random() * 10;
  private flip = 1; // сглаженное зеркало по X: 1 — как нарисовано, −1 — отражено
  private sq = 0; // сжатие (<0) и растяжение (>0) тела по высоте, доля
  private sqV = 0;
  private wasGrounded = true;
  private airT = 0; // сглаженное «в воздухе»: 0..1
  private stepPhase = 0;
  private move = 0; // 0..1: насколько сейчас в движении (для анимации)
  private air = false;
  private hopTimer = rand(0.3, 1.2);
  private lookX = 0; // куда смотрит страж: −1..1 (в системе взгляда)
  private heading = Math.random() * Math.PI * 2; // курс птички
  private pos: Vec = { x: 0, y: 0 };
  private readonly spriteDef;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly target: () => Vec | null // герой (ноги)
  ) {
    const cfg = rig.critter;
    if (!cfg) throw new Error(`[Critter] в риге "${rig.id}" нет блока critter`);
    this.cfg = cfg;
    this.speed = def.stats.movement_speed;
    this.spriteDef = sprites.def(spawn.sprite_id);
    this.anchor = { x: this.spriteDef.frame_width * this.spriteDef.origin.x, y: this.spriteDef.frame_height * this.spriteDef.origin.y };

    for (const d of cfg.parts) {
      const sprite = sprites.createSprite(d.sprite_id);
      sprite.pivot.set(d.pivot.x, d.pivot.y);
      sprite.position.set(d.pivot.x, d.pivot.y);
      this.node.addChild(sprite);
      this.parts.push({ sprite, pivot: d.pivot, anims: d.anims ?? [], cur: { dx: 0, dy: 0, rot: 0, sy: 1 } });
    }
    this.node.pivot.set(this.anchor.x, this.anchor.y);
    this.container.addChild(this.node);
    this.react = new HitReaction(this.parts.map((p) => p.sprite));

    const ts = level.tileSize;
    if (cfg.kind === 'flyer') {
      this.pos = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 0.5) * ts };
    } else {
      // ноги — на нижней границе клетки; у ходячих дальше ведёт физика
      this.pos = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 1) * ts };
      if (this.spriteDef.hitbox) {
        this.body.setHitbox(this.spriteDef, this.mirrored());
        this.body.x = this.pos.x;
        this.body.y = this.pos.y;
      }
    }
    this.home = { ...this.pos };
    this.flip = this.mirrored() ? -1 : 1;
    this.applyTransform(0);
    this.animate(0);
  }

  /** Рисунок зеркален, когда существо идёт в сторону, противоположную той, куда смотрит нарисованное. */
  private mirrored(): boolean {
    return this.facing !== this.cfg.draw_facing;
  }

  // ---------- Бой ----------

  public hitCircles(): HitCircle[] {
    const sx = this.mirrored() ? -1 : 1;
    const p = this.position;
    return this.cfg.hit.map((c) => ({ x: p.x + (c.x - this.anchor.x) * sx, y: p.y + (c.y - this.anchor.y), r: c.r }));
  }

  public onHit(): void {
    this.react.trigger(0, 0);
  }

  private get position(): Vec {
    return this.cfg.kind === 'flyer' || this.cfg.kind === 'watcher' ? this.pos : { x: this.body.x, y: this.body.y };
  }

  // ---------- Мир ----------

  private groundAhead(dir: number): boolean {
    const b = this.body;
    const ts = this.level.tileSize;
    const x = b.x + dir * (b.hitWidth / 2 + LEDGE_PROBE);
    return this.level.isSolid(Math.floor(x / ts), Math.floor((b.y + 3) / ts));
  }

  private heroNear(range: number): Vec | null {
    const h = this.target();
    if (!h) return null;
    const p = this.position;
    return Math.abs(h.x - p.x) < range && Math.abs(h.y - p.y) < SEE_HEIGHT ? h : null;
  }

  // ---------- Обновление ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.t += dt;
    this.react.update(dt);
    switch (this.cfg.kind) {
      case 'walker': this.updateWalker(dt); break;
      case 'hopper': this.updateHopper(dt); break;
      case 'flyer': this.updateFlyer(dt); break;
      default: this.updateWatcher(dt);
    }
    this.updateSquash(dt);
    this.applyTransform(dt);
    this.animate(dt);
  }

  /** Пружина тела: на взлёте тянется вверх по скорости, на приземлении сплющивается и пружинит назад. */
  private updateSquash(dt: number): void {
    const grounded = this.cfg.kind === 'hopper' || this.cfg.kind === 'walker' ? this.body.grounded : true;
    if (grounded && !this.wasGrounded && this.cfg.kind === 'hopper') {
      this.sq = -0.2; // приземлился — сплющило
      this.sqV = 0;
    }
    this.wasGrounded = grounded;
    // в воздухе цель — растяжение по скорости, на земле — покой
    const target = this.cfg.kind === 'hopper' && !grounded ? clamp(-this.body.vy / 1500, -0.07, 0.13) : 0;
    this.sqV += (SQUASH_K * (target - this.sq) - SQUASH_D * this.sqV) * dt;
    this.sq += this.sqV * dt;
  }

  private setFacing(dir: 1 | -1): void {
    if (dir === this.facing) return;
    this.facing = dir;
    if (this.cfg.kind === 'walker' || this.cfg.kind === 'hopper') this.body.setHitbox(this.spriteDef, this.mirrored());
  }

  private updateWalker(dt: number): void {
    const b = this.body;
    const hero = this.heroNear(this.cfg.sight ?? 180);
    let want = this.dir;
    let speed = this.speed;
    if (hero) {
      if (Math.abs(hero.x - b.x) > 8) want = hero.x > b.x ? 1 : -1;
      speed *= CHASE_BOOST;
    }
    const blocked = b.blockedX === want || (b.grounded && !this.groundAhead(want));
    if (blocked) {
      if (hero) speed = 0; // у края или стены не падает и не лезет в стену — ждёт
      else {
        this.dir = want = (-want) as 1 | -1;
      }
    } else if (!hero) {
      this.dir = want;
    }
    if (speed > 0) this.setFacing(want);
    b.vx += (want * speed - b.vx) * (1 - Math.exp(-14 * dt));
    this.gravity(dt);
    this.move += ((Math.abs(b.vx) / Math.max(1, this.speed) > 0.1 ? 1 : 0) - this.move) * (1 - Math.exp(-MOVE_RATE * dt));
    this.stepPhase += Math.abs(b.vx) * dt * (this.cfg.stride ?? 0.12);
    this.air = !b.grounded;
  }

  private updateHopper(dt: number): void {
    const b = this.body;
    this.hopTimer -= dt;
    if (b.grounded) {
      b.vx *= Math.exp(-14 * dt);
      if (this.hopTimer <= 0) {
        const hero = this.heroNear(this.cfg.sight ?? 100);
        // от героя — прочь; иначе куда придётся (чаще — туда же, куда смотрит)
        let dir: 1 | -1 = Math.random() < 0.65 ? this.facing : ((-this.facing) as 1 | -1);
        if (hero) dir = hero.x > b.x ? -1 : 1;
        if (b.blockedX === dir) dir = (-dir) as 1 | -1;
        this.setFacing(dir);
        b.vy = -rand(HOP_SPEED[0], HOP_SPEED[1]) * (hero ? 1.2 : 1);
        b.vx = dir * rand(HOP_RUN[0], HOP_RUN[1]) * (hero ? 1.4 : 1);
        this.hopTimer = rand(HOP_TIME[0], HOP_TIME[1]) * (hero ? 0.5 : 1);
      }
    }
    this.gravity(dt);
    this.air = !b.grounded;
    this.move += ((this.air ? 1 : 0) - this.move) * (1 - Math.exp(-MOVE_RATE * dt));
    this.stepPhase += (this.air ? 1 : 0) * dt * 14;
  }

  private gravity(dt: number): void {
    const b = this.body;
    b.vy += GRAVITY * dt;
    b.move(dt, this.level);
    this.pos = { x: b.x, y: b.y };
  }

  private updateFlyer(dt: number): void {
    const ts = this.level.tileSize;
    // цель — точка, плавающая вокруг дома: петли и восьмёрки
    const tx = this.home.x + Math.cos(this.t * 0.45 + this.seed) * FLY_RADIUS;
    const ty = this.home.y + Math.sin(this.t * 0.9 + this.seed) * FLY_RADIUS * 0.45;
    const want = Math.atan2(ty - this.pos.y, tx - this.pos.x);
    this.heading = wrap(this.heading + clamp(wrap(want - this.heading), -FLY_TURN * dt, FLY_TURN * dt));
    const v = this.speed * (0.9 + 0.2 * Math.sin(this.t * 1.7 + this.seed));
    const nx = this.pos.x + Math.cos(this.heading) * v * dt;
    const ny = this.pos.y + Math.sin(this.heading) * v * dt;
    // перед тайлом (и краем уровня) — разворот
    const ahead = { x: this.pos.x + Math.cos(this.heading) * 14, y: this.pos.y + Math.sin(this.heading) * 14 };
    const hit = this.level.isSolid(Math.floor(ahead.x / ts), Math.floor(ahead.y / ts)) || ahead.y < 0 || ahead.x < 0 || ahead.x > this.level.widthTiles * ts;
    if (hit) {
      this.heading = wrap(this.heading + Math.PI * (0.6 + Math.random() * 0.3) * (Math.random() < 0.5 ? 1 : -1));
    } else {
      this.pos = { x: nx, y: ny };
    }
    const dx = Math.cos(this.heading);
    if (Math.abs(dx) > 0.15) this.setFacing(dx > 0 ? 1 : -1);
    this.move = 1;
    this.air = true;
  }

  private updateWatcher(dt: number): void {
    const hero = this.heroNear(this.cfg.sight ?? 200);
    const goal = hero ? clamp((hero.x - this.pos.x) / 90, -1, 1) : 0;
    this.lookX += (goal - this.lookX) * (1 - Math.exp(-6 * dt));
    if (hero && Math.abs(hero.x - this.pos.x) > 6) this.setFacing(hero.x > this.pos.x ? 1 : -1);
    this.move = 0;
  }

  // ---------- Рисование ----------

  private applyTransform(dt: number): void {
    const p = this.position;
    this.container.position.set(p.x, p.y);
    // плавный разворот; сжатие по высоте раздувает тело вширь и наоборот (объём сохраняется)
    this.flip += ((this.mirrored() ? -1 : 1) - this.flip) * (dt > 0 ? 1 - Math.exp(-FLIP_RATE * dt) : 1);
    if (Math.abs(this.flip) < 0.06) this.flip = this.flip < 0 ? -0.06 : 0.06; // не схлопывается в нитку
    this.node.scale.set(this.flip * (1 - this.sq * 0.7), 1 + this.sq);
    // птичка кренится по курсу: нос вверх при подъёме
    this.node.rotation = this.cfg.kind === 'flyer' ? Math.sin(this.heading) * 0.4 * (this.mirrored() ? -1 : 1) * -1 : 0;
  }

  /** Анимации деталей: шаг (translate), качание/клёв/взмах (rotate вокруг pivot), парение, сжатие. */
  private animate(dt: number): void {
    const m = this.move;
    this.airT += ((this.air ? 1 : 0) - this.airT) * (dt > 0 ? 1 - Math.exp(-AIR_RATE * dt) : 1);
    const airT = this.airT;
    const k = dt > 0 ? 1 - Math.exp(-PART_SMOOTH * dt) : 1;
    for (const part of this.parts) {
      let dx = 0;
      let dy = 0;
      let rot = 0;
      let sy = 1;
      for (const a of part.anims) {
        const ph = (a.phase ?? 0);
        const rate = a.rate ?? 1;
        switch (a.type) {
          case 'step': {
            const w = this.stepPhase + ph;
            dx += Math.sin(w) * a.amp * m;
            dy -= Math.max(0, Math.cos(w)) * (a.lift ?? 0) * m;
            break;
          }
          case 'bounce': dy -= (0.5 - 0.5 * Math.cos(this.stepPhase * 2)) * a.amp * m; break; // плавная «горка» без острых впадин
          case 'swing': rot += Math.sin(this.stepPhase + ph) * a.amp * (a.always ? 1 : m) + (a.always ? Math.sin(this.t * rate + ph + this.seed) * a.amp : 0); break;
          case 'wag': rot += Math.sin(this.t * rate + ph + this.seed) * a.amp * (0.4 + 0.6 * m); break;
          case 'bob': dy += Math.sin(this.t * rate + ph + this.seed) * a.amp; break;
          case 'flap': rot += Math.sin(this.t * rate + ph) * a.amp * (0.08 + 0.92 * airT); break;
          case 'squash': {
            const s = Math.sin(this.t * rate + ph + this.seed);
            sy *= 1 + s * a.amp;
            dy -= s * 1.5;
            break;
          }
          case 'track': rot += this.lookX * a.amp; break;
          case 'peck': rot += Math.pow(Math.max(0, Math.sin(this.t * rate + ph + this.seed)), 3) * a.amp * (1 - airT); break;
        }
      }
      // деталь плавно догоняет цель (пружина первого порядка): мелкие рывки анимации сглаживаются
      const c = part.cur;
      c.dx += (dx - c.dx) * k;
      c.dy += (dy - c.dy) * k;
      c.rot += (rot - c.rot) * k;
      c.sy += (sy - c.sy) * k;
      part.sprite.position.set(part.pivot.x + c.dx, part.pivot.y + c.dy);
      part.sprite.rotation = c.rot;
      part.sprite.scale.set(1, c.sy);
    }
  }
}
