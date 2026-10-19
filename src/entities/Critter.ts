import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { CritterAnimDef, CritterDef, CritterLungeDef, CritterShootDef, EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import { LightningTail } from '../effects/LightningTail.ts';
import { Body } from './Body.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, Hittable } from './Hittable.ts';
import type { Leash } from '../world/Rooms.ts';

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
const TUCK_OPEN_SPEED = 200; // px/с: на такой скорости падения ноги прыгуна уже полностью раскрыты
const WHIP_MARGIN = 12; // px: хлестать начинает, подойдя ближе reach на столько
const WHIP_HIT_R = 11; // px: на таком расстоянии от хвоста герой считается задетым
const WHIP_GIVE_UP = 5; // с: гонится за героем так долго и не дотянулся — отстаёт на время
const KEEP_AWAY_NEAR = 40; // px: если герой подошёл ближе этого во время перезарядки хвоста, крыса отступает
const KEEP_AWAY_FAR = 60; // px: отступает до этого безопасного расстояния, затем останавливается и ждёт
const LUNGE_SQUASH = -0.34; // сжатие тела на приседании перед броском
const LUNGE_RETREAT = 0.6; // с: после броска прыгун отскакивает от героя
const LUNGE_HOP_RUN = 1.5; // во сколько раз длиннее прыжки-подскоки, когда идёт на героя
const SHOOT_HEIGHT = 120; // px: стражу видно героя и на такой разнице высот (обычный SEE_HEIGHT мал для стрелка)
const SHOOT_LEAD = 0.6; // доля упреждения: куда герой дойдёт, пока летит молния (молния медленная)
const SHOOT_LEAD_MAX = 70; // px: потолок упреждения
const SHOOT_JITTER = 0.07; // рад: случайный разброс каждой молнии
const HERO_CHEST = 26; // px: в какую точку над ногами героя целится страж

interface Vec {
  x: number;
  y: number;
}

interface Part {
  sprite: Sprite;
  pivot: Vec;
  name: string;
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
  private readonly tail: LightningTail | null = null;
  private wState: 'none' | 'windup' | 'lash' | 'recover' = 'none'; // хлёст хвостом: замах -> удар -> возврат
  private wT = 0;
  private wind = 0; // 0..1: замах (для хвоста)
  private lash = 0; // 0..1: ход хлёста
  private whipCd = rand(1.2, 3.2); // пауза до следующего хлёста, с
  private chaseT = 0;
  private tossT = 0; // с: минимум в полёте после броска (у точки броска «земля» ещё не приземление)
  private tossing = false; // брошен боссом: летит по дуге и не управляет собой, пока не приземлится
  private backingOff = false; // отступает на безопасную дистанцию при перезарядке хвоста
  private whipHitDone = false;
  /** Хлёст задел героя: (x, y, сторона отбрасывания). Возвращает true, если герой сбит (иначе — не засчитан, например уже лежит). */
  public onWhipHit: ((x: number, y: number, dirX: number) => boolean) | null = null;
  /** Щелчок хлыста в конце удара: точка кончика в мире. */
  public onCrack: ((x: number, y: number) => void) | null = null;
  /** Комната-«дом»: замечает героя и держится только в ней (null — без привязки). */
  public leash: Leash | null = null;

  // ---- Бросок прыгуна (cfg.lunge): приседание -> прыжок в героя -> отскок
  private lState: 'none' | 'windup' | 'air' = 'none';
  private lT = 0;
  private lungeCd = rand(0.8, 2);
  private retreatT = 0; // с: после броска отскакивает от героя
  private lungeHit = false;
  /** Тело героя (прямоугольник мира) — по нему засчитывается бросок. */
  public heroBox: (() => { left: number; right: number; top: number; bottom: number } | null) | null = null;
  /** Бросок достал героя: (x, y, сторона отбрасывания, урон). Возвращает true, если урон засчитан. */
  public onLungeHit: ((x: number, y: number, dirX: number, damage: number) => boolean) | null = null;
  private readonly attackDamage: number;
  private shakeX = 0; // px: дрожь тела на приседании перед броском
  /** Эффекты броска: wind — приседание (k 0..1), leap — отрыв от земли, trail — полёт, land — приземление (k — сила). x, y — ноги; dirX — куда летит. */
  public onLungeFx: ((kind: 'wind' | 'leap' | 'trail' | 'land', x: number, y: number, k: number, dirX: number) => void) | null = null;

  // ---- Выстрел стража (cfg.shoot): зарядка глаза -> молния -> пауза
  private sState: 'idle' | 'charge' = 'idle';
  private sT = 0;
  private shootCd = rand(1.2, 2.6);
  private chargeK = 0; // сглаженная зарядка 0..1 (для анимации стража)
  private recoil = 0; // отдача выстрела 1 -> 0
  private heroLast: Vec | null = null;
  private heroVel: Vec = { x: 0, y: 0 }; // сглаженная скорость героя (для упреждения)
  /** Зарядка глаза: точка глаза в мире и доля зарядки 0..1 (игра рисует сходящиеся искры). */
  public onCharge: ((x: number, y: number, k: number) => void) | null = null;
  /** Выстрел: глаз (мир), курс (рад) и параметры залпа. */
  public onShoot: ((x: number, y: number, angle: number, cfg: CritterShootDef) => void) | null = null;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly target: () => Vec | null // герой (ноги)
  ) {
    const cfg = rig.critter;
    if (!cfg) throw new Error(`[Critter] в риге "${rig.id}" нет блока critter`);
    this.cfg = cfg;
    this.speed = def.stats.movement_speed;
    this.attackDamage = def.attack.damage;
    this.spriteDef = sprites.def(spawn.sprite_id);
    this.anchor = { x: this.spriteDef.frame_width * this.spriteDef.origin.x, y: this.spriteDef.frame_height * this.spriteDef.origin.y };

    for (const d of cfg.parts) {
      const sprite = sprites.createSprite(d.sprite_id);
      sprite.pivot.set(d.pivot.x, d.pivot.y);
      sprite.position.set(d.pivot.x, d.pivot.y);
      this.node.addChild(sprite);
      this.parts.push({ sprite, pivot: d.pivot, name: d.name, anims: d.anims ?? [], cur: { dx: 0, dy: 0, rot: 0, sy: 1 } });
    }
    if (cfg.tail) {
      // хвост-молния: поверх деталей; хлёст дотягивается на reach px вперёд от точки привязки
      this.tail = new LightningTail(cfg.tail, cfg.tail.root.x - this.anchor.x + (cfg.tail.whip?.reach ?? 0), this.anchor.y);
      this.node.addChild(this.tail.graphics);
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

  /**
   * Свет хвоста-молнии (синий, как у всех молний игры — стиль BLUE): в покое слабое свечение у середины хвоста, в замахе и хлёсте — яркая вспышка у кончика.
   * null — хвоста нет или он вне зоны видимости.
   */
  public tailLight(): { x: number; y: number; r: number; i: number; c: [number, number, number] } | null {
    const shoot = this.cfg.shoot;
    if (shoot && this.sState === 'charge') {
      // страж заряжает выстрел: глаз разгорается синим
      const eye = this.hitCircles()[0];
      const k = clamp(this.sT / shoot.windup, 0, 1);
      return { x: eye.x, y: eye.y, r: 36 + 54 * k, i: 0.3 + 1.1 * k, c: [0.24, 0.91, 0.9] };
    }
    const tail = this.tail;
    if (!tail || !tail.graphics.visible) return null;
    const p = this.position;
    const sx = this.mirrored() ? -1 : 1;
    const k = Math.max(this.wind * 0.5, this.lash);
    const n = tail.nodes[Math.floor(tail.nodes.length * (k > 0.1 ? 0.9 : 0.55))];
    return {
      x: p.x + (n.x - this.anchor.x) * sx, y: p.y + (n.y - this.anchor.y), r: 44 + 52 * k, i: 0.32 + 1.0 * k,
      c: [0.24, 0.91, 0.9]
    };
  }

  /** Страж (watcher) только следит и никого не трогает. */
  public get passive(): boolean {
    return this.cfg.kind === 'watcher';
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

  /** Точка (мир) в пределах комнаты моба (без привязки — везде). */
  private inRoom(x: number, y: number): boolean {
    return !this.leash || this.leash.contains(x, y);
  }

  private heroNear(range: number): Vec | null {
    if (this.leash && !this.leash.hero()) return null; // герой в другой комнате — моб его не замечает
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
    this.updateTail(dt);
  }

  /** Хвост-молния: рисуется только рядом с героем (дальше — вне экрана), позу задают замах и хлёст. */
  private updateTail(dt: number): void {
    const tail = this.tail;
    if (!tail) return;
    const h = this.target();
    const p = this.position;
    const near = !h || Math.abs(h.x - p.x) < 640;
    tail.graphics.visible = near;
    if (!near && this.wState === 'none') return;
    if (tail.update(dt, this.move, this.wind, this.lash)) {
      const sx = this.mirrored() ? -1 : 1;
      this.onCrack?.(p.x + (tail.tip.x - this.anchor.x) * sx, p.y + (tail.tip.y - this.anchor.y));
    }
  }

  /** Хлёст: замах -> удар -> возврат; в удар задетый хвостом герой сбивается с ног. Зверёк при этом стоит на месте. */
  private stepWhip(dt: number, hero: Vec | null, whip: NonNullable<NonNullable<CritterDef['tail']>['whip']>): void {
    const b = this.body;
    const easeV = (v: number) => v * v * (3 - 2 * v);
    switch (this.wState) {
      case 'none': {
        this.whipCd -= dt;
        if (!hero || this.whipCd > 0) { if (!hero) this.chaseT = 0; break; }
        if (b.grounded && Math.abs(hero.x - b.x) <= whip.reach - WHIP_MARGIN && Math.abs(hero.y - b.y) < 40) {
          this.wState = 'windup';
          this.wT = 0;
          this.chaseT = 0;
          this.whipHitDone = false;
          this.setFacing(hero.x > b.x ? 1 : -1);
        } else if ((this.chaseT += dt) > WHIP_GIVE_UP) {
          this.chaseT = 0;
          this.whipCd = rand(2, 3.5);
        }
        break;
      }
      case 'windup':
        this.wT += dt;
        this.wind = easeV(clamp(this.wT / whip.windup, 0, 1));
        this.lash = 0;
        if (this.wT >= whip.windup) { this.wState = 'lash'; this.wT = 0; }
        break;
      case 'lash':
        this.wT += dt;
        this.wind = 1;
        this.lash = clamp(this.wT / whip.lash, 0, 1);
        if (!this.whipHitDone && this.lash > 0.45 && hero && this.tailTouches(hero)) {
          const dirX = hero.x >= b.x ? 1 : -1;
          this.whipHitDone = true;
          const tip = this.tail!.tip;
          const sx = this.mirrored() ? -1 : 1;
          this.onWhipHit?.(b.x + (tip.x - this.anchor.x) * sx, b.y + (tip.y - this.anchor.y), dirX);
        }
        if (this.wT >= whip.lash) { this.wState = 'recover'; this.wT = 0; }
        break;
      default: {
        this.wT += dt;
        const u = clamp(this.wT / whip.recover, 0, 1);
        this.lash = 1 - easeV(u);
        this.wind = 1 - easeV(clamp(u * 1.25, 0, 1));
        if (this.wT >= whip.recover) {
          this.wState = 'none';
          this.wind = this.lash = 0;
          this.whipCd = rand(whip.cooldown[0], whip.cooldown[1]);
        }
      }
    }
  }

  /** Задел ли хвост героя в этот момент: хлыст бьёт по земле, поэтому считаются только ноги (два круга у пола) — прыжком его можно перепрыгнуть. */
  private tailTouches(hero: Vec): boolean {
    const tail = this.tail;
    if (!tail) return false;
    const p = this.position;
    const sx = this.mirrored() ? -1 : 1;
    const local = (wy: number) => ({ x: (hero.x - p.x) * sx + this.anchor.x, y: wy - p.y + this.anchor.y });
    const shins = local(hero.y - 5);
    const knees = local(hero.y - 15);
    return tail.distanceTo(shins.x, shins.y) < WHIP_HIT_R || tail.distanceTo(knees.x, knees.y) < WHIP_HIT_R - 2;
  }

  /** Пружина тела: на взлёте тянется вверх по скорости, на приземлении сплющивается и пружинит назад. */
  private updateSquash(dt: number): void {
    const grounded = this.cfg.kind === 'hopper' || this.cfg.kind === 'walker' ? this.body.grounded : true;
    if (grounded && !this.wasGrounded && this.cfg.kind === 'hopper') {
      this.sq = Math.min(this.sq, -0.2); // приземлился — сплющило (после броска — сильнее)
      this.sqV = 0;
    }
    this.wasGrounded = grounded;
    // в воздухе цель — растяжение по скорости, на земле — покой, на приседании перед броском — сжатие
    let target = this.cfg.kind === 'hopper' && !grounded ? clamp(-this.body.vy / 1500, -0.07, 0.13) : 0;
    if (this.lState === 'windup' && this.cfg.lunge) {
      const u = clamp(this.lT / this.cfg.lunge.windup, 0, 1);
      target = LUNGE_SQUASH * u * u * (3 - 2 * u);
    }
    this.sqV += (SQUASH_K * (target - this.sq) - SQUASH_D * this.sqV) * dt;
    this.sq += this.sqV * dt;
  }

  private setFacing(dir: 1 | -1): void {
    if (dir === this.facing) return;
    this.facing = dir;
    if (this.cfg.kind === 'walker' || this.cfg.kind === 'hopper') this.body.setHitbox(this.spriteDef, this.mirrored());
  }

  /** Брошенный (боссом): появляется в точке и летит по дуге; пока не приземлился, идёт по своей скорости, а не по повадке. Только ходячие и прыгающие. */
  public toss(x: number, y: number, vx: number, vy: number): void {
    this.body.x = x;
    this.body.y = y;
    this.body.vx = vx;
    this.body.vy = vy;
    this.pos = { x, y };
    this.tossT = 0.25;
    this.tossing = true;
    this.setFacing(vx >= 0 ? 1 : -1);
    this.applyTransform(0);
  }

  /** Полёт брошенного: гравитация и движение, пока не приземлится; true — ещё летит (повадка выключена). */
  private flyingToss(dt: number): boolean {
    if (!this.tossing) return false;
    const b = this.body;
    this.tossT -= dt;
    this.gravity(dt);
    this.air = true;
    if (b.grounded && this.tossT <= 0) {
      this.tossing = false;
      return false;
    }
    return true;
  }

  private updateWalker(dt: number): void {
    if (this.flyingToss(dt)) return;
    const b = this.body;
    const hero = this.heroNear(this.cfg.sight ?? 180);
    const whip = this.cfg.tail?.whip;
    if (whip) this.stepWhip(dt, hero, whip);

    let want: 1 | -1 = this.dir;
    let speed = this.speed;

    if (this.wState !== 'none') {
      // Замах и хлёст: зверёк замер на месте, удар наносится в сторону героя
      speed = 0;
      this.backingOff = false;
    } else if (hero && whip && this.whipCd > 0) {
      // Хвост на перезарядке (после попытки удара): держим дистанцию с гистерезисом, без бесконечных разворотов
      const dist = Math.abs(hero.x - b.x);
      if (dist < KEEP_AWAY_NEAR) {
        this.backingOff = true;
      } else if (dist >= KEEP_AWAY_FAR) {
        this.backingOff = false;
      }

      if (this.backingOff) {
        want = (hero.x > b.x ? -1 : 1) as 1 | -1;
        const blocked = b.blockedX === want || (b.grounded && !this.groundAhead(want)) || !this.inRoom(b.x + want * (b.hitWidth / 2 + LEDGE_PROBE), b.y - 4);
        if (blocked) {
          // Упёрлись в стену или край платформы сзади: не можем отступать дальше, замираем лицом к герою
          speed = 0;
          this.backingOff = false;
          if (dist > 8) this.setFacing((hero.x > b.x ? 1 : -1) as 1 | -1);
        } else {
          speed = this.speed;
          this.setFacing(want);
          this.dir = want;
        }
      } else {
        // На безопасной дистанции: останавливаемся и смотрим на героя, ожидая перезарядки
        speed = 0;
        if (dist > 8) this.setFacing((hero.x > b.x ? 1 : -1) as 1 | -1);
      }
    } else if (hero && (!whip || this.whipCd <= 0)) {
      // Готов атаковать: сближение с героем на повышенной скорости
      this.backingOff = false;
      const dist = Math.abs(hero.x - b.x);
      if (dist > 8) want = (hero.x > b.x ? 1 : -1) as 1 | -1;
      speed = this.speed * CHASE_BOOST;
      const blocked = b.blockedX === want || (b.grounded && !this.groundAhead(want)) || !this.inRoom(b.x + want * (b.hitWidth / 2 + LEDGE_PROBE), b.y - 4);
      if (blocked) {
        speed = 0;
      }
      if (speed > 0) {
        this.setFacing(want);
        this.dir = want;
      }
    } else {
      // Обычное патрулирование: ходит туда-сюда, разворачивается у препятствий
      this.backingOff = false;
      want = this.dir;
      speed = this.speed;
      const blocked = b.blockedX === want || (b.grounded && !this.groundAhead(want)) || !this.inRoom(b.x + want * (b.hitWidth / 2 + LEDGE_PROBE), b.y - 4);
      if (blocked) {
        this.dir = want = (-want) as 1 | -1;
      }
      if (speed > 0) this.setFacing(want);
    }

    b.vx += (want * speed - b.vx) * (1 - Math.exp(-14 * dt));
    this.gravity(dt);
    this.move += ((Math.abs(b.vx) / Math.max(1, this.speed) > 0.1 ? 1 : 0) - this.move) * (1 - Math.exp(-MOVE_RATE * dt));
    this.stepPhase += Math.abs(b.vx) * dt * (this.cfg.stride ?? 0.12);
    this.air = !b.grounded;
  }

  private updateHopper(dt: number): void {
    if (this.flyingToss(dt)) return;
    const b = this.body;
    const lunge = this.cfg.lunge;
    this.hopTimer -= dt;
    this.lungeCd -= dt;
    this.retreatT -= dt;
    const hero = this.heroNear(lunge ? Math.max(lunge.sight, this.cfg.sight ?? 0) : this.cfg.sight ?? 100);

    if (lunge && this.lState === 'windup') {
      // приседает и смотрит на героя; пока присел — не двигается
      this.lT += dt;
      b.vx *= Math.exp(-20 * dt);
      const h = this.target();
      if (h && Math.abs(h.x - b.x) > 4) this.setFacing(h.x > b.x ? 1 : -1);
      const k = clamp(this.lT / lunge.windup, 0, 1);
      this.shakeX = Math.sin(this.t * 90) * 1.4 * k * k; // перед прыжком мелко дрожит
      this.onLungeFx?.('wind', b.x, b.y, k, this.facing);
      if (this.lT >= lunge.windup) this.leap(lunge);
    } else if (b.grounded && !(lunge && this.lState === 'air')) {
      b.vx *= Math.exp(-14 * dt);
      // заметил героя в пределах броска: присесть
      if (lunge && hero && this.lungeCd <= 0 && Math.abs(hero.x - b.x) <= lunge.range && Math.abs(hero.y - b.y) < 56) {
        this.lState = 'windup';
        this.lT = 0;
        this.lungeHit = false;
        this.setFacing(hero.x > b.x ? 1 : -1);
      } else if (this.hopTimer <= 0) {
        // обычный прыгун от героя — прочь; бросающийся — к нему, пока бросок заряжен, и от него — пока перезаряжается
        const approach = !!lunge && this.lungeCd <= 0 && this.retreatT <= 0;
        let dir: 1 | -1 = Math.random() < 0.65 ? this.facing : ((-this.facing) as 1 | -1);
        if (hero) dir = (hero.x > b.x) === approach ? 1 : -1;
        if (b.blockedX === dir || !this.inRoom(b.x + dir * 40, b.y - 4)) dir = (-dir) as 1 | -1;
        this.setFacing(dir);
        b.vy = -rand(HOP_SPEED[0], HOP_SPEED[1]) * (hero ? 1.2 : 1);
        b.vx = dir * rand(HOP_RUN[0], HOP_RUN[1]) * (hero ? (approach ? LUNGE_HOP_RUN : 1.4) : 1);
        this.hopTimer = rand(HOP_TIME[0], HOP_TIME[1]) * (hero ? 0.5 : 1);
      }
    }
    this.gravity(dt);
    if (lunge && this.lState === 'air') this.stepLungeAir(dt, lunge);
    this.air = !b.grounded;
    this.move += ((this.air ? 1 : 0) - this.move) * (1 - Math.exp(-MOVE_RATE * dt));
    this.stepPhase += (this.air ? 1 : 0) * dt * 14;
  }

  /** Прыжок на героя: дуга рассчитана так, чтобы приземлиться там, где герой стоит сейчас (но не дальше max_vx). */
  private leap(lunge: CritterLungeDef): void {
    const b = this.body;
    const h = this.target();
    const dir: 1 | -1 = h ? (h.x > b.x ? 1 : -1) : this.facing;
    const flightTime = (2 * lunge.speed_y) / GRAVITY;
    const dx = h ? h.x - b.x : dir * 60;
    b.vy = -lunge.speed_y;
    b.vx = clamp(dx / flightTime, -lunge.max_vx, lunge.max_vx);
    this.setFacing(dir);
    this.lState = 'air';
    this.lT = 0;
    this.lungeHit = false;
    this.shakeX = 0;
    this.sq = 0.3; // мощный толчок: тело вытягивается вверх
    this.sqV = 4;
    this.onLungeFx?.('leap', b.x, b.y, 1, dir);
  }

  /** Бросок в воздухе: задел героя — урон; приземлился — пауза и отскок. */
  private stepLungeAir(dt: number, lunge: CritterLungeDef): void {
    const b = this.body;
    this.lT += dt;
    if (this.lT > 0.05) this.onLungeFx?.('trail', b.x, b.y - 14, 1, b.vx >= 0 ? 1 : -1);
    if (!this.lungeHit && this.onLungeHit) {
      const box = this.heroBox?.();
      if (box && this.touches(box)) {
        this.lungeHit = true;
        this.onLungeHit(b.x, b.y - 10, b.vx >= 0 ? 1 : -1, this.attackDamage);
      }
    }
    if (b.grounded && this.lT > 0.12) {
      this.sq = -0.36; // тяжёлое приземление: сплющивает
      this.sqV = 0;
      this.onLungeFx?.('land', b.x, b.y, 1, b.vx >= 0 ? 1 : -1);
      this.lState = 'none';
      this.lungeCd = rand(lunge.cooldown[0], lunge.cooldown[1]);
      this.retreatT = LUNGE_RETREAT;
      this.hopTimer = rand(0.25, 0.5);
    }
  }

  /** Касается ли тело зверька прямоугольника героя (по кругам попадания). */
  private touches(box: { left: number; right: number; top: number; bottom: number }): boolean {
    for (const c of this.hitCircles()) {
      const nx = clamp(c.x, box.left, box.right);
      const ny = clamp(c.y, box.top, box.bottom);
      if (Math.hypot(c.x - nx, c.y - ny) <= c.r * 0.85) return true;
    }
    return false;
  }

  private gravity(dt: number): void {
    const b = this.body;
    b.vy += GRAVITY * dt;
    const oldX = b.x;
    b.move(dt, this.level);
    if (this.leash && !this.inRoom(b.x, b.y - 4)) {
      b.x = oldX;
      b.vx = -b.vx * 0.5;
    }
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
    const hit = this.level.isSolid(Math.floor(ahead.x / ts), Math.floor(ahead.y / ts)) || ahead.y < 0 || ahead.x < 0 || ahead.x > this.level.widthTiles * ts
      || !this.inRoom(ahead.x, ahead.y) || !this.inRoom(nx, ny);
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
    if (this.cfg.shoot) this.stepShoot(dt, this.cfg.shoot);
  }

  /** Страж стреляет: видит героя (в дальности, без стены между ними) -> заряжает глаз -> пускает залп молний -> пауза. */
  private stepShoot(dt: number, shoot: CritterShootDef): void {
    const h = this.leash && !this.leash.hero() ? null : this.target();
    // скорость героя для упреждения (сглаженная по кадрам)
    if (h && this.heroLast) {
      const k = 1 - Math.exp(-8 * dt);
      this.heroVel.x += ((h.x - this.heroLast.x) / Math.max(dt, 1e-3) - this.heroVel.x) * k;
      this.heroVel.y += ((h.y - this.heroLast.y) / Math.max(dt, 1e-3) - this.heroVel.y) * k;
    }
    this.heroLast = h ? { x: h.x, y: h.y } : null;

    const eye = this.hitCircles()[0];
    const chest = h ? { x: h.x, y: h.y - HERO_CHEST } : null;
    const inRange = !!chest && Math.hypot(chest.x - eye.x, chest.y - eye.y) <= shoot.sight && Math.abs(chest.y - eye.y) < SHOOT_HEIGHT * 2;

    if (this.sState === 'idle') {
      this.shootCd -= dt;
      if (this.shootCd <= 0) {
        if (inRange) { // стена между ними не мешает: молнии отражаются и ищут героя рикошетом
          this.sState = 'charge';
          this.sT = 0;
        } else {
          this.shootCd = 0.4; // героя нет в дальности — присмотреться позже
        }
      }
      return;
    }
    this.sT += dt;
    this.onCharge?.(eye.x, eye.y, clamp(this.sT / shoot.windup, 0, 1));
    if (this.sT < shoot.windup) return;
    this.sState = 'idle';
    this.recoil = 1; // отдача выстрела: голова вдавливается, ножка качается
    this.shootCd = rand(shoot.cooldown[0], shoot.cooldown[1]);
    if (!chest) return;
    // целится в упреждённую точку: герой дойдёт до неё, пока молния летит
    const dist = Math.hypot(chest.x - eye.x, chest.y - eye.y);
    const lead = Math.min(SHOOT_LEAD_MAX, (dist / shoot.speed) * SHOOT_LEAD * Math.hypot(this.heroVel.x, this.heroVel.y));
    const vlen = Math.hypot(this.heroVel.x, this.heroVel.y) || 1;
    const ax = chest.x + (this.heroVel.x / vlen) * lead;
    const ay = chest.y + (this.heroVel.y / vlen) * lead * 0.5;
    const base = Math.atan2(ay - eye.y, ax - eye.x);
    for (let i = 0; i < shoot.count; i++) {
      const off = shoot.count > 1 ? (i / (shoot.count - 1) - 0.5) * shoot.spread : 0;
      this.onShoot?.(eye.x, eye.y, base + off + (Math.random() * 2 - 1) * SHOOT_JITTER, shoot);
    }
  }


  // ---------- Рисование ----------

  private applyTransform(dt: number): void {
    const p = this.position;
    this.container.position.set(p.x, p.y);
    // плавный разворот; сжатие по высоте раздувает тело вширь и наоборот (объём сохраняется)
    this.flip += ((this.mirrored() ? -1 : 1) - this.flip) * (dt > 0 ? 1 - Math.exp(-FLIP_RATE * dt) : 1);
    if (Math.abs(this.flip) < 0.06) this.flip = this.flip < 0 ? -0.06 : 0.06; // не схлопывается в нитку
    this.node.scale.set(this.flip * (1 - this.sq * 0.7), 1 + this.sq);
    this.node.position.x = this.shakeX;
    // птичка кренится по курсу: нос вверх при подъёме
    this.node.rotation = this.cfg.kind === 'flyer' ? Math.sin(this.heading) * 0.4 * (this.mirrored() ? -1 : 1) * -1 : 0;
  }

  /** Анимации деталей: шаг (translate), качание/клёв/взмах (rotate вокруг pivot), парение, сжатие. */
  private animate(dt: number): void {
    const m = this.move;
    this.airT += ((this.air ? 1 : 0) - this.airT) * (dt > 0 ? 1 - Math.exp(-AIR_RATE * dt) : 1);
    const airT = this.airT;
    const k = dt > 0 ? 1 - Math.exp(-PART_SMOOTH * dt) : 1;
    // подбор ног: в воздухе подтянуты, на спуске раскрываются навстречу земле (готовятся к приземлению)
    const tuck = this.cfg.kind === 'hopper' ? airT * clamp(1 - Math.max(0, this.body.vy) / TUCK_OPEN_SPEED, 0, 1) : 0;
    // страж: зарядка и отдача выстрела (глаз приподнимается и дрожит, после выстрела вдавливается, ножка раскачивается)
    const watcher = this.cfg.kind === 'watcher' && !!this.cfg.shoot;
    if (watcher) {
      const goal = this.sState === 'charge' ? clamp(this.sT / this.cfg.shoot!.windup, 0, 1) : 0;
      this.chargeK += (goal - this.chargeK) * (dt > 0 ? 1 - Math.exp(-14 * dt) : 1);
      this.recoil = Math.max(0, this.recoil - dt * 3.2);
    }
    const ck = this.chargeK;
    const rc = this.recoil * this.recoil;
    for (const [pi, part] of this.parts.entries()) {
      let dx = 0;
      let dy = 0;
      let rot = 0;
      let sy = 1;
      if (watcher) {
        const head = pi === this.parts.length - 1;
        if (head) {
          dy += -3.5 * ck + 4 * rc;
          dx += Math.sin(this.t * 70) * 0.9 * ck * ck;
          rot += Math.sin(this.t * 55) * 0.07 * ck * ck + Math.sin(this.t * 22) * 0.1 * rc;
          sy *= 1 + 0.1 * ck - 0.22 * rc;
        } else {
          rot += Math.sin(this.t * 30) * 0.12 * rc - 0.05 * ck;
          sy *= 1 - 0.05 * ck + 0.08 * rc;
        }
      }
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
          case 'tuck': sy *= 1 - tuck * a.amp; dy -= (a.lift ?? 0) * tuck; break; // ноги вжимаются в тело (на прыжке)
          case 'sink': {
            // идёт за смещением другой детали (она выше в списке — уже посчитана) только вниз: вверх не отрывается, а уходит в неё
            const src = this.parts.find((q) => q.name === a.of);
            if (src) dy += Math.max(0, src.cur.dy) * a.amp;
            break;
          }
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
