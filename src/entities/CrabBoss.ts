import { Container, Graphics, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { CrabBossDef, EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Particles } from '../effects/Particles.ts';
import { NeonThread } from '../effects/NeonThread.ts';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';
import type { Leash } from '../world/Rooms.ts';
import { Body } from './Body.ts';
import type { HeroRect } from './BossBird.ts';
import type { CrabOrb } from './CrabOrb.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';

// ---------- Настройка боя ----------
const ENRAGE_AT = 0.5; // доля здоровья, с которой босс звереет
const CLAW_SCALE = 0.2; // урон по клешне (она на нитке и только отвлекает): доля от обычного
const GRAVITY = 1100; // px/с²: босс тяжёлый, прыжок короткий и резкий
const WALK = 72; // px/с: ход между атаками
const STALK_TIME: [number, number] = [0.8, 1.5]; // с: идёт к герою, потом атакует
const INTRO = 1.8; // с: рык при появлении (неуязвим)
const JUMP_WIND = 0.55; // с: присел перед прыжком
const JUMP_AIR_MIN = 0.55; // с: минимальная длина прыжка
const JUMP_AIR_MAX = 1.05;
const SHOCK_RADIUS = 150; // px: ударная волна от приземления
const SHOCK_DAMAGE = 22;
const SLAM_RAISE = 0.42; // с: клешня взлетает над целью (цель отмечена на полу)
const SLAM_HOLD = 0.4; // с: клешня лежит после удара
const SLAM_GAP = 0.55; // с: между ударами левой и правой
const SLAM_DAMAGE = 26;
const SLAM_RADIUS = 38; // px: на таком расстоянии от удара герой на полу задет
const ORB_CHARGE = 1.0; // с: клешни лепят шары
const ORB_SPEED = 175; // px/с: шар катится
/** Урон шара по герою (шар бьёт сам, см. игру). */
export const CRAB_ORB_DAMAGE = 20;
const MOB_GAP = 1.1; // с: между бросками мобов
const BODY_TOUCH_DAMAGE = 14;
const TOUCH_COOLDOWN = 1.2;
const CLAW_REST: [number, number] = [64, 54]; // где висит клешня (от плеча: наружу, вниз)

const THREAD_COLORS = [pal('virus', 4), pal('virus', 5), pal('virus', 6), pal('virus', 7)];
const DUST = [0x9fb4c8, 0x6f8296, 0xdbe9f7];
const MAGENTA = [pal('virus', 3), pal('virus', 4), pal('virus', 5), pal('virus', 6)];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

type State =
  | 'idle' | 'intro' | 'stalk' | 'jump_wind' | 'jump_air' | 'land' | 'slam'
  | 'orb_charge' | 'orb_throw' | 'orb_wait'
  | 'ledge_walk' | 'ledge_wind' | 'ledge_air' | 'ledge_throw' | 'ledge_down' | 'rest';
type Attack = 'jump' | 'orbs' | 'platform';
type ClawMode = 'idle' | 'raise' | 'smash' | 'hold' | 'orb' | 'throw' | 'pose';

interface Vec {
  x: number;
  y: number;
}

interface Ledge {
  x0: number; // левый край верха, мир px
  x1: number;
  y: number; // верх платформы
}

interface Claw {
  side: -1 | 1; // -1 левая
  sprite: Sprite;
  thread: NeonThread;
  p: Vec; // запястье, мир
  v: Vec;
  goal: Vec;
  k: number;
  c: number;
  angle: number;
  mode: ClawMode;
  modeT: number;
  target: number; // x удара
  hitDone: boolean;
  orb: CrabOrb | null;
  energy: number;
}

/** Всё, чем босс влияет на игру. */
export interface CrabBossHooks {
  hero(): HeroRect & { x: number };
  hurt(amount: number, dirX: number, knock: boolean): void;
  /** Новый шар (держится в клешне, пока босс не бросит). */
  spawnOrb(x: number, y: number): CrabOrb;
  /** Швырнуть моба: (id врага, x, y, vx, vy). */
  throwMob(enemyId: string, x: number, y: number, vx: number, vy: number): void;
  mobsAlive(): number;
  shake(power: number): void;
  fx: Particles;
}

/**
 * Финальный босс — краб. Ходит и прыгает по полу, клешни не прикреплены к телу: они висят на неоновых нитях от плеч и бьют как кистени.
 * Три атаки: (1) прыжок на героя: ударная волна при приземлении и удары клешнями по очереди в то место, где стоит герой (оно отмечено на полу);
 * (2) катящиеся шары: клешни лепят по золотому шару и швыряют в стороны, шары катятся по полу, отскакивают от стен и разбиваются,
 * столкнувшись друг с другом; (3) платформа: запрыгивает на уступок над ареной и швыряет в героя обитателей прежних локаций.
 * Одна полоса здоровья, тело бьётся в полную силу, клешни — слабо. Ниже половины здоровья звереет: быстрее, чаще, больше шаров и мобов.
 */
export class CrabBoss implements PartDamageable {
  public readonly container = new Container();
  public leash: Leash | null = null;

  private readonly cfg: CrabBossDef;
  private readonly body = new Body();
  private readonly node = new Container(); // торс и ноги: сжимается при приседании
  private readonly bodySprites: Sprite[] = [];
  private readonly legs: Array<{ sprite: Sprite; role: string; pivot: Vec; dy: number }> = [];
  private readonly claws: Claw[] = [];
  private readonly clawLayer = new Container();
  private readonly marker = new Graphics(); // отметка удара на полу
  private readonly react: HitReaction;
  private readonly summonIds: string[];
  private readonly summonCount: number;
  private readonly summonMax: number;

  private readonly maxHp: number;
  private hp: number;
  private enraged = false;
  private roar = false;

  private state: State = 'idle';
  private stateT = 0;
  private time = Math.random() * 10;
  private woken = false;
  private plan: Attack[] = [];
  private planIdx = 0;
  private last: Attack | null = null;
  private floorY = 0; // пол под ногами сейчас (на уступе — его верх)
  private arenaY = 0; // пол арены
  private ledges: Ledge[] = [];
  private ledge: Ledge | null = null;

  private jumpsLeft = 0;
  private jumpTarget = 0;
  private slamQueue: Array<{ side: -1 | 1; at: number }> = [];
  private orbRounds = 0;
  private orbsOut: CrabOrb[] = [];
  private throwsLeft = 0;
  private throwT = 0;
  private throwSide: -1 | 1 = 1;
  private stalkTime = 1;
  private walkPhase = 0;
  private crouch = 0;
  private tuck = 0;
  private airT = 0;
  private touchCd = 0;
  private lastShock = 0;
  private readonly orbSpeed = ORB_SPEED;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly hooks: CrabBossHooks
  ) {
    const cfg = rig.crab_boss;
    if (!cfg) throw new Error(`[CrabBoss] в риге "${rig.id}" нет блока crab_boss`);
    this.cfg = cfg;
    this.maxHp = this.hp = def.stats.max_health;
    this.summonIds = def.summons?.enemy_ids ?? ['electro_rat'];
    this.summonCount = def.summons?.count ?? 5;
    this.summonMax = def.summons?.max_alive ?? 6;

    const ts = level.tileSize;
    this.body.setBox(cfg.box.w, cfg.box.h);
    this.body.x = (spawn.x + 0.5) * ts;
    this.body.y = (spawn.y + 1) * ts;
    this.floorY = this.arenaY = this.floorAt(this.body.x, this.body.y - 4);

    // тело: слои на общем холсте, точка привязки — центр стоп
    this.node.pivot.set(cfg.feet.x, cfg.feet.y);
    this.node.position.set(0, 0);
    for (const l of cfg.layers) {
      const sprite = sprites.createSprite(l.sprite_id);
      if (l.pivot) {
        sprite.pivot.set(l.pivot.x, l.pivot.y);
        sprite.position.set(l.pivot.x, l.pivot.y);
        this.legs.push({ sprite, role: l.role, pivot: l.pivot, dy: l.foot_y !== undefined ? Math.round(146 - l.foot_y) : 0 });
      }
      this.node.addChild(sprite);
      this.bodySprites.push(sprite);
    }
    this.container.addChild(this.node);
    this.container.addChild(this.marker);

    // клешни на нитях
    for (const side of [-1, 1] as const) {
      const sprite = sprites.createSprite(cfg.claw.sprite_id);
      sprite.pivot.set(cfg.claw.pivot.x, cfg.claw.pivot.y);
      if (side > 0) sprite.scale.x = -1;
      const thread = new NeonThread();
      this.container.addChild(thread.graphics);
      this.clawLayer.addChild(sprite);
      const a = this.anchor(side);
      const p = { x: a.x + side * CLAW_REST[0], y: a.y + CLAW_REST[1] };
      this.claws.push({
        side, sprite, thread, p, v: { x: 0, y: 0 }, goal: { ...p }, k: 40, c: 9, angle: 0, mode: 'idle', modeT: 0, target: 0,
        hitDone: false, orb: null, energy: 0
      });
    }
    this.container.addChild(this.clawLayer);
    this.react = new HitReaction([...this.bodySprites, ...this.claws.map((c) => c.sprite)]);

    this.findLedges();
    this.buildPlan();
    this.animate(0);
  }

  // ---------- Бой ----------

  /** Босс в бою (для полосы здоровья). */
  public get active(): boolean {
    return this.state !== 'idle';
  }

  public get health(): { hp: number; max: number } {
    return { hp: this.hp, max: this.maxHp };
  }

  /** Верх босса в мире (камера держит его в кадре). */
  public focusTop(): number {
    const standing = this.body.y - this.cfg.height;
    const clawTop = Math.min(...this.claws.map((c) => c.p.y - 30));
    return Math.min(standing, clawTop);
  }

  public hitCircles(): HitCircle[] {
    const out: HitCircle[] = [];
    const f = this.feet();
    for (const h of this.cfg.body_hit) {
      out.push({ x: f.x + (h.x - this.cfg.feet.x), y: f.y + (h.y - this.cfg.feet.y) + this.crouch * 8, r: h.r, part: 0 });
    }
    for (const c of this.claws) {
      const cos = Math.cos(c.angle);
      const sin = Math.sin(c.angle);
      for (const h of this.cfg.claw.hit) {
        const lx = (h.x - this.cfg.claw.pivot.x) * (c.side > 0 ? -1 : 1);
        const ly = h.y - this.cfg.claw.pivot.y;
        out.push({ x: c.p.x + lx * cos - ly * sin, y: c.p.y + lx * sin + ly * cos, r: h.r, part: c.side < 0 ? 2 : 3 });
      }
    }
    return out;
  }

  public onHit(_dx: number, _dy: number, part?: number): void {
    this.react.trigger(0, 0);
    if (part === 2 || part === 3) {
      const c = this.claws[part === 2 ? 0 : 1];
      c.v.y -= 40; // клешню на нитке подбрасывает
    }
  }

  public damageScale(part?: number): number {
    if (this.state === 'intro') return 0;
    return part === 2 || part === 3 ? CLAW_SCALE : 1;
  }

  public damagePart(_part: number, amount: number): PartDamageResult {
    this.hp -= amount;
    if (this.hp <= 0) return 'dead';
    if (!this.enraged && this.hp <= this.maxHp * ENRAGE_AT) {
      this.enraged = true;
      this.roar = true;
    }
    return 'hit';
  }

  /** Огни босса: клешни и нити светятся неоном (для освещения мира). */
  public lights(): Array<{ x: number; y: number; r: number; i: number; c: [number, number, number] }> {
    const out: Array<{ x: number; y: number; r: number; i: number; c: [number, number, number] }> = [];
    for (const c of this.claws) {
      out.push({ x: c.p.x, y: c.p.y, r: 70 + 40 * c.energy, i: 0.55 + 0.7 * c.energy, c: [0.82, 0.05, 0.97] });
      const a = this.anchor(c.side);
      out.push({ x: (a.x + c.p.x) / 2, y: (a.y + c.p.y) / 2 + 8, r: 46, i: 0.3, c: [0.82, 0.05, 0.97] });
    }
    return out;
  }

  // ---------- Геометрия ----------

  private feet(): Vec {
    return { x: this.body.x, y: this.body.y };
  }

  /** Плечо (крепление нити) в мире. */
  private anchor(side: -1 | 1): Vec {
    const s = side < 0 ? this.cfg.shoulders.left : this.cfg.shoulders.right;
    const f = this.feet();
    return { x: f.x + (s.x - this.cfg.feet.x), y: f.y + (s.y - this.cfg.feet.y) + this.crouch * 8 };
  }

  /** Кончик клешни (челюсти) в мире. */
  private tip(c: Claw, frac = 1): Vec {
    const len = this.cfg.claw.length * frac;
    return { x: c.p.x + Math.sin(c.angle) * len, y: c.p.y - Math.cos(c.angle) * len };
  }

  /** Пол под точкой: верх первой твёрдой клетки ниже y (мир px). */
  private floorAt(x: number, y: number): number {
    const ts = this.level.tileSize;
    const cx = Math.floor(x / ts);
    let row = Math.max(0, Math.floor(y / ts));
    while (row < this.level.heightTiles && !this.level.isSolid(cx, row)) row++;
    return row * ts;
  }

  /** Уступы над ареной, на которые босс может запрыгнуть: широкие (от 6 клеток), с воздухом над ними, в 3–6 клетках над полом. */
  private findLedges(): void {
    const ts = this.level.tileSize;
    const floorRow = Math.round(this.floorY / ts);
    const need = 6; // клеток воздуха над уступом
    const tops: number[] = [];
    for (let cx = 0; cx < this.level.widthTiles; cx++) {
      let top = -1;
      for (let row = floorRow - 7; row <= floorRow - 3; row++) {
        if (row < 1 || !this.level.isSolid(cx, row)) continue;
        let free = true;
        for (let k = 1; k <= need && free; k++) if (this.level.isSolid(cx, row - k)) free = false;
        if (free) {
          top = row;
          break;
        }
      }
      tops.push(top);
    }
    for (let cx = 0; cx < tops.length; ) {
      if (tops[cx] < 0) { cx++; continue; }
      let e = cx;
      while (e + 1 < tops.length && tops[e + 1] === tops[cx]) e++;
      if (e - cx + 1 >= 6) this.ledges.push({ x0: cx * ts, x1: (e + 1) * ts, y: tops[cx] * ts });
      cx = e + 1;
    }
  }

  // ---------- План ----------

  private buildPlan(): void {
    const base: Attack[] = this.enraged ? ['jump', 'orbs', 'jump', 'platform', 'orbs'] : ['jump', 'orbs', 'jump', 'platform'];
    this.plan = base.filter((a) => a !== 'platform' || this.ledges.length > 0);
    this.planIdx = 0;
  }

  private nextAttack(): Attack {
    if (this.planIdx >= this.plan.length) this.buildPlan();
    let a = this.plan[this.planIdx++];
    if (a === this.last && this.plan.length > 1) a = this.plan[this.planIdx++ % this.plan.length];
    this.last = a;
    return a;
  }

  private engaged(): boolean {
    if (this.leash) return this.leash.hero();
    const h = this.hooks.hero();
    if (Math.hypot(h.x - this.body.x, (h.top + h.bottom) / 2 - this.body.y) < 800) this.woken = true;
    return this.woken;
  }

  private enter(state: State): void {
    this.state = state;
    this.stateT = 0;
  }

  // ---------- Ход боя ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.stateT += dt;
    this.touchCd = Math.max(0, this.touchCd - dt);
    const h = this.hooks.hero();
    const awake = this.engaged();
    const fast = this.enraged ? 1.25 : 1;
    if (this.roar) this.doRoar();

    switch (this.state) {
      case 'idle':
        this.settle(dt);
        if (awake && this.stateT > 0.8) {
          this.enter('intro');
          this.hooks.shake(2.4);
        }
        break;

      case 'intro':
        this.settle(dt);
        this.poseClaws(0.0);
        if (this.stateT > INTRO) this.toStalk();
        break;

      case 'stalk': {
        // идёт к герою боком, пока не пора атаковать
        const dx = h.x - this.body.x;
        const want = Math.abs(dx) > 220 ? Math.sign(dx) : Math.abs(dx) < 120 ? -Math.sign(dx) : 0;
        this.walkTo(dt, want * WALK * fast);
        this.idleClaws();
        if (this.stateT >= this.stalkTime) this.begin(this.nextAttack());
        break;
      }

      // --- прыжок + клешни ---
      case 'jump_wind':
        this.settle(dt);
        this.crouch = Math.min(1, this.crouch + dt / (JUMP_WIND * 0.7));
        this.poseClaws(0.7);
        if (this.stateT >= JUMP_WIND / fast) this.launchJump();
        break;

      case 'jump_air':
        this.airT += dt;
        this.crouch = Math.max(0, this.crouch - dt * 6);
        this.tuck = Math.min(1, this.tuck + dt * 5);
        this.poseClaws(1.0);
        this.physics(dt);
        if (this.body.grounded && this.airT > 0.2) this.landed();
        break;

      case 'land':
        this.settle(dt);
        this.idleClaws();
        this.tuck = Math.max(0, this.tuck - dt * 5);
        if (this.stateT > 0.25) {
          this.startSlams();
          this.enter('slam');
        }
        break;

      case 'slam':
        this.settle(dt);
        this.idleClaws();
        this.updateSlams();
        if (this.slamQueue.length === 0 && this.claws.every((c) => c.mode === 'idle') && this.stateT > 0.3) {
          if (--this.jumpsLeft > 0) {
            this.enter('jump_wind');
          } else {
            this.rest(0.8 / fast);
          }
        }
        break;

      // --- шары ---
      case 'orb_charge': {
        this.settle(dt);
        const t = clamp(this.stateT / (ORB_CHARGE / fast), 0, 1);
        for (const c of this.claws) {
          c.mode = 'orb';
          c.goal = this.offset(this.anchor(c.side), c.side * 84, -64 + Math.sin(this.time * 7 + c.side) * 3);
          c.k = 70; c.c = 14;
          c.energy = t;
          c.orb?.hold(this.tip(c, 0.55).x, this.tip(c, 0.55).y, t);
          if (c.orb && Math.random() < 0.5) this.hooks.fx.burst(this.tip(c, 0.55).x + (Math.random() - 0.5) * 44, this.tip(c, 0.55).y + (Math.random() - 0.5) * 44, { count: 1, colors: [pal('gold', 6), pal('gold', 7)], speed: [10, 30], life: [0.2, 0.4], size: [1, 2] });
        }
        this.crouch = Math.sin(t * 6) * 0.1;
        if (this.stateT >= ORB_CHARGE / fast) this.enter('orb_throw');
        break;
      }

      case 'orb_throw': {
        this.settle(dt);
        for (const c of this.claws) {
          c.mode = 'throw';
          c.goal = this.offset(this.anchor(c.side), c.side * 190, -10);
          c.k = 900; c.c = 38;
          if (c.orb && this.stateT > 0.1) {
            const tip = this.tip(c, 0.55);
            c.orb.x = tip.x; c.orb.y = tip.y;
            c.orb.release(c.side * this.orbSpeed * (this.enraged ? 1.2 : 1), -150);
            this.orbsOut.push(c.orb);
            c.orb = null;
            this.hooks.shake(1.2);
            this.hooks.fx.burst(tip.x, tip.y, { count: 14, colors: [pal('gold', 5), pal('gold', 7), pal('virus', 6)], speed: [50, 160], spread: Math.PI * 2, life: [0.15, 0.4], size: [1, 2], drag: 4 });
          }
        }
        if (this.stateT > 0.4) {
          for (const c of this.claws) { c.mode = 'idle'; c.energy = 0; }
          this.enter('orb_wait');
        }
        break;
      }

      case 'orb_wait': {
        this.settle(dt);
        this.idleClaws();
        this.orbsOut = this.orbsOut.filter((o) => !o.expired);
        const gone = this.orbsOut.length === 0;
        if ((gone && this.stateT > 0.8) || this.stateT > 7) {
          if (--this.orbRounds > 0) {
            this.startOrbs();
          } else {
            this.rest(0.9 / fast);
          }
        }
        break;
      }

      // --- платформа ---
      case 'ledge_walk': {
        const l = this.ledge!;
        const side = this.body.x < (l.x0 + l.x1) / 2 ? -1 : 1;
        const gap = this.cfg.box.w / 2 + 70; // разбег с запасом: пока поднимается, угол платформы не задевает
        const startX = side < 0 ? l.x0 - gap : l.x1 + gap;
        const dx = startX - this.body.x;
        this.walkTo(dt, Math.abs(dx) < 12 ? 0 : Math.sign(dx) * WALK * 2.2);
        this.idleClaws();
        if (Math.abs(dx) < 14 || this.stateT > 4) this.enter('ledge_wind');
        break;
      }

      case 'ledge_wind':
        this.settle(dt);
        this.crouch = Math.min(1, this.crouch + dt / 0.5);
        this.poseClaws(0.7);
        if (this.stateT >= 0.7) this.launchLedge();
        break;

      case 'ledge_air':
        this.airT += dt;
        this.crouch = Math.max(0, this.crouch - dt * 6);
        this.tuck = Math.min(1, this.tuck + dt * 5);
        this.poseClaws(1.0);
        this.physics(dt);
        if (this.body.grounded && this.airT > 0.3) {
          this.landed(true);
          this.throwsLeft = this.enraged ? this.summonCount + 2 : this.summonCount;
          this.throwT = 0.8;
          this.enter('ledge_throw');
        }
        break;

      case 'ledge_throw': {
        this.settle(dt);
        this.tuck = Math.max(0, this.tuck - dt * 5);
        this.updateThrow(dt, h, fast);
        break;
      }

      case 'ledge_down':
        this.airT += dt;
        this.tuck = Math.min(1, this.tuck + dt * 5);
        this.crouch = Math.max(0, this.crouch - dt * 6);
        this.poseClaws(1.0);
        this.physics(dt);
        if (this.body.grounded && this.airT > 0.3) {
          this.landed();
          this.rest(0.9 / fast);
        }
        break;

      case 'rest':
        this.settle(dt);
        this.tuck = Math.max(0, this.tuck - dt * 5);
        this.idleClaws();
        if (this.stateT >= this.stalkTime) this.toStalk();
        break;
    }

    // слишком далеко ушёл от арены / упал — возвращаем (страховка)
    if (this.body.y > this.level.pixelHeight + 200) {
      this.body.x = this.level.pixelWidth / 2;
      this.body.y = this.floorY;
    }
    this.stepClaws(dt);
    this.touch();
    this.animate(dt);
    this.react.update(dt);
  }

  private offset(a: Vec, dx: number, dy: number): Vec {
    return { x: a.x + dx, y: a.y + dy };
  }

  private toStalk(): void {
    this.stalkTime = rand(STALK_TIME[0], STALK_TIME[1]);
    this.enter('stalk');
  }

  private rest(t: number): void {
    this.stalkTime = t;
    this.enter('rest');
  }

  /** Стоит на полу: гравитация и гашение скорости. */
  private settle(dt: number): void {
    this.body.vx *= Math.exp(-10 * dt);
    this.physics(dt);
    this.crouch = Math.max(0, this.crouch - dt * 3);
  }

  private physics(dt: number): void {
    this.body.vy += GRAVITY * dt;
    this.body.move(dt, this.level);
  }

  private walkTo(dt: number, vx: number): void {
    this.body.vx += (vx - this.body.vx) * (1 - Math.exp(-8 * dt));
    this.physics(dt);
    this.walkPhase += Math.abs(this.body.vx) * dt * 0.12;
    this.crouch = Math.max(0, this.crouch - dt * 3);
    this.tuck = Math.max(0, this.tuck - dt * 5);
  }

  private begin(a: Attack): void {
    if (a === 'jump') {
      this.jumpsLeft = this.enraged ? 3 : 2;
      this.enter('jump_wind');
    } else if (a === 'orbs') {
      this.orbRounds = this.enraged ? 2 : 1;
      if (this.orbsOut.filter((o) => !o.expired).length > 2) {
        this.rest(0.5);
        return;
      }
      this.startOrbs();
    } else {
      // платформа: ближайший уступок; если босс стоит под ним — сначала выходит из-под него
      this.ledge = this.ledges.reduce((best, l) => Math.abs((l.x0 + l.x1) / 2 - this.body.x) < Math.abs((best.x0 + best.x1) / 2 - this.body.x) ? l : best, this.ledges[0]);
      this.enter('ledge_walk');
    }
  }

  // ---------- Прыжок ----------

  private launchJump(): void {
    const h = this.hooks.hero();
    this.jumpTarget = h.x + rand(-45, 45);
    const dist = Math.abs(this.jumpTarget - this.body.x);
    const T = clamp(dist / 330, JUMP_AIR_MIN, JUMP_AIR_MAX) / (this.enraged ? 1.15 : 1);
    this.body.vx = (this.jumpTarget - this.body.x) / T;
    this.body.vy = -GRAVITY * T / 2;
    this.airT = 0;
    this.enter('jump_air');
    this.hooks.shake(1.0);
    this.hooks.fx.burst(this.body.x, this.body.y - 2, { count: 14, colors: DUST, speed: [50, 150], angle: -Math.PI / 2, spread: 1.3, life: [0.2, 0.5], size: [1, 3], gravity: 100, drag: 3 });
  }

  /** Приземление: пыль, тряска, ударная волна по полу (задевает героя, который стоит на земле рядом). */
  private landed(quiet = false): void {
    this.body.vx = 0;
    const f = this.feet();
    this.hooks.shake(quiet ? 3.0 : 4.0);
    this.floorY = f.y;
    for (const side of [-1, 1]) {
      this.hooks.fx.burst(f.x + side * 40, f.y - 2, { count: 16, colors: DUST, speed: [60, 190], angle: side > 0 ? -0.15 : Math.PI + 0.15, spread: 0.35, life: [0.25, 0.7], size: [1, 3], gravity: 110, drag: 3 });
      this.hooks.fx.burst(f.x + side * 70, f.y - 2, { count: 8, colors: MAGENTA, speed: [40, 130], angle: side > 0 ? -0.1 : Math.PI + 0.1, spread: 0.3, life: [0.2, 0.5], size: [1, 2], drag: 3 });
    }
    // волна идёт по полу: перепрыгнуть можно; задевает, если ноги героя у пола и он в радиусе
    const h = this.hooks.hero();
    if (h.bottom > f.y - 22 && Math.abs(h.x - f.x) < SHOCK_RADIUS && this.time - this.lastShock > 0.4) {
      this.lastShock = this.time;
      this.hooks.hurt(SHOCK_DAMAGE, h.x >= f.x ? 1 : -1, true);
    }
    if (this.state === 'jump_air') this.enter('land');
  }

  // ---------- Клешни ----------

  private startSlams(): void {
    const h = this.hooks.hero();
    const order: Array<-1 | 1> = h.x < this.body.x ? [-1, 1] : [1, -1]; // первой бьёт клешня, что ближе к герою
    this.slamQueue = order.map((side, i) => ({ side, at: i * SLAM_GAP }));
    if (this.enraged) this.slamQueue.push({ side: order[0], at: 2 * SLAM_GAP });
    this.stateT = 0;
  }

  private updateSlams(): void {
    const h = this.hooks.hero();
    while (this.slamQueue.length && this.stateT >= this.slamQueue[0].at / (this.enraged ? 1.2 : 1)) {
      const s = this.slamQueue.shift()!;
      const c = this.claws[s.side < 0 ? 0 : 1];
      if (c.mode !== 'idle' && c.mode !== 'pose') continue;
      c.mode = 'raise';
      c.modeT = 0;
      c.hitDone = false;
      c.target = clamp(h.x, this.anchor(s.side).x - this.cfg.thread_length * 0.8, this.anchor(s.side).x + this.cfg.thread_length * 0.8);
    }
  }

  private idleClaws(): void {
    for (const c of this.claws) {
      if (c.mode !== 'idle') continue;
      const a = this.anchor(c.side);
      c.goal = { x: a.x + c.side * CLAW_REST[0], y: a.y + CLAW_REST[1] + Math.sin(this.time * 1.9 + c.side * 1.3) * 6 };
      c.k = 36; c.c = 8;
      c.energy = Math.max(0, c.energy - 0.03);
    }
  }

  /** Клешни разведены (в прыжке и перед ним): amount 0 — рык, 0.7 — подняты, 1 — широко. */
  private poseClaws(amount: number): void {
    for (const c of this.claws) {
      if (c.mode !== 'idle' && c.mode !== 'pose') continue;
      c.mode = 'pose';
      const a = this.anchor(c.side);
      const spread = amount === 0 ? 70 : 60 + 50 * amount;
      const lift = amount === 0 ? -90 : -30 - 60 * amount;
      c.goal = { x: a.x + c.side * spread, y: a.y + lift + Math.sin(this.time * 8 + c.side) * (amount === 0 ? 8 : 4) };
      c.k = 60; c.c = 12;
      c.energy = amount === 0 ? 0.8 : 0.3;
    }
  }

  private stepClaws(dt: number): void {
    const f = this.feet();
    const h = this.hooks.hero();
    for (const c of this.claws) {
      c.modeT += dt;
      const a = this.anchor(c.side);
      // режимы
      if (c.mode === 'pose' && this.state !== 'jump_wind' && this.state !== 'jump_air' && this.state !== 'ledge_wind' && this.state !== 'ledge_air' && this.state !== 'ledge_down' && this.state !== 'intro') c.mode = 'idle';
      if (c.mode === 'raise') {
        c.goal = { x: c.target, y: this.floorY - 175 };
        c.k = 130; c.c = 18;
        c.energy = 0.5 + 0.4 * Math.sin(this.time * 18);
        if (c.modeT >= SLAM_RAISE / (this.enraged ? 1.2 : 1)) {
          c.mode = 'smash';
          c.modeT = 0;
        }
      } else if (c.mode === 'smash') {
        c.goal = { x: c.target, y: this.floorY - this.cfg.claw.length + 4 };
        c.k = 2400; c.c = 55;
        c.energy = 1;
        const tip = this.tip(c);
        const hit = tip.y >= this.floorY - 9 && Math.cos(c.angle) < -0.6;
        if (!c.hitDone && hit) {
          c.hitDone = true;
          this.slamImpact(c, h);
          c.mode = 'hold';
          c.modeT = 0;
        } else if (c.modeT > 0.7) {
          c.mode = 'hold';
          c.modeT = 0;
        } else if (!c.hitDone) {
          // клешня в полёте задевает героя на пути вниз
          this.clawTouch(c, h, SLAM_DAMAGE);
        }
      } else if (c.mode === 'hold') {
        c.goal = { x: c.p.x, y: this.floorY - this.cfg.claw.length + 4 };
        c.k = 200; c.c = 30;
        c.energy = Math.max(0, 1 - c.modeT * 2.5);
        if (c.modeT >= SLAM_HOLD) { c.mode = 'idle'; c.energy = 0; }
      }

      // пружина к цели
      const ax = c.k * (c.goal.x - c.p.x) - c.c * c.v.x;
      const ay = c.k * (c.goal.y - c.p.y) - c.c * c.v.y + (c.mode === 'idle' ? 120 : 0); // на нитке висит, провисает от веса
      c.v.x += ax * dt;
      c.v.y += ay * dt;
      const sp = Math.hypot(c.v.x, c.v.y);
      if (sp > 1600) { c.v.x *= 1600 / sp; c.v.y *= 1600 / sp; }
      c.p.x += c.v.x * dt;
      c.p.y += c.v.y * dt;
      // нить не растягивается
      const dx = c.p.x - a.x;
      const dy = c.p.y - a.y;
      const d = Math.hypot(dx, dy);
      const L = this.cfg.thread_length;
      if (d > L) {
        c.p.x = a.x + (dx / d) * L;
        c.p.y = a.y + (dy / d) * L;
        const radial = (c.v.x * dx + c.v.y * dy) / d;
        if (radial > 0) { c.v.x -= (dx / d) * radial; c.v.y -= (dy / d) * radial; }
      }
      // пол и стены
      const floor = this.floorAt(c.p.x, Math.min(c.p.y, this.floorY));
      const down = Math.max(0, -Math.cos(c.angle)) * this.cfg.claw.length; // челюсти вниз — кончик глубже запястья
      const lim = floor - 6 - down;
      if (c.p.y > lim) { c.p.y = lim; if (c.v.y > 0) c.v.y = 0; }
      // поворот: челюсти смотрят от плеча, плавно
      let want = Math.atan2(c.p.x - a.x, -(c.p.y - a.y));
      if (c.mode === 'smash' || c.mode === 'hold') want = Math.PI; // удар — челюстями вниз
      let da = want - c.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      c.angle += da * (1 - Math.exp(-14 * dt));
      // отрисовка (локально относительно стоп)
      c.sprite.position.set(Math.round(c.p.x - f.x), Math.round(c.p.y - f.y));
      c.sprite.rotation = c.angle;
      c.thread.draw(dt, { x: a.x - f.x, y: a.y - f.y }, { x: c.p.x - f.x, y: c.p.y - f.y }, L, c.energy);
      // опасна, пока летит быстро (кроме удара — у него своя проверка)
    }
    this.drawMarker();
  }

  private slamImpact(c: Claw, h: HeroRect & { x: number }): void {
    const tip = this.tip(c);
    const y = this.floorY;
    this.hooks.shake(3.2);
    this.hooks.fx.burst(tip.x, y - 2, { count: 22, colors: DUST, speed: [50, 200], angle: -Math.PI / 2, spread: 1.2, life: [0.25, 0.7], size: [1, 3], gravity: 140, drag: 3 });
    this.hooks.fx.burst(tip.x, y - 4, { count: 14, colors: THREAD_COLORS, speed: [60, 220], angle: -Math.PI / 2, spread: 1.4, life: [0.15, 0.5], size: [1, 2], drag: 4 });
    if (h.bottom > y - 30 && Math.abs(h.x - tip.x) < SLAM_RADIUS) {
      this.hooks.hurt(SLAM_DAMAGE, h.x >= tip.x ? 1 : -1, true);
    }
  }

  /** Клешня задевает героя (ударом на лету). */
  private clawTouch(c: Claw, h: HeroRect & { x: number }, dmg: number): void {
    for (const k of this.cfg.claw.hit) {
      const cos = Math.cos(c.angle);
      const sin = Math.sin(c.angle);
      const lx = (k.x - this.cfg.claw.pivot.x) * (c.side > 0 ? -1 : 1);
      const ly = k.y - this.cfg.claw.pivot.y;
      const x = c.p.x + lx * cos - ly * sin;
      const y = c.p.y + lx * sin + ly * cos;
      const nx = clamp(x, h.left, h.right);
      const ny = clamp(y, h.top, h.bottom);
      if (Math.hypot(x - nx, y - ny) < k.r * 0.85) {
        c.hitDone = true;
        this.hooks.hurt(dmg, h.x >= x ? 1 : -1, true);
        return;
      }
    }
  }

  /** Отметка на полу там, куда упадёт клешня: бегущая неоновая полоска. */
  private drawMarker(): void {
    const g = this.marker;
    g.clear();
    const f = this.feet();
    for (const c of this.claws) {
      if (c.mode !== 'raise') continue;
      const x = c.target - f.x;
      const y = this.floorY - f.y - 2;
      const k = clamp(c.modeT / SLAM_RAISE, 0, 1);
      const half = Math.round(SLAM_RADIUS * (0.6 + 0.4 * k));
      for (let i = -half; i <= half; i += 2) {
        if (((i + Math.floor(this.time * 40)) >> 1) % 2 === 0) g.rect(Math.round(x + i), Math.round(y), 2, 1);
      }
      g.fill({ color: pal('virus', k > 0.7 ? 7 : 5), alpha: 0.9 });
      g.rect(Math.round(x) - 1, Math.round(y) - 3, 2, 3).fill({ color: pal('virus', 6), alpha: 0.9 });
    }
  }

  // ---------- Шары ----------

  private startOrbs(): void {
    for (const c of this.claws) {
      const tip = this.tip(c, 0.55);
      c.orb = this.hooks.spawnOrb(tip.x, tip.y);
      c.orb.hold(tip.x, tip.y, 0.05);
    }
    this.enter('orb_charge');
  }

  // ---------- Платформа ----------

  private launchLedge(): void {
    const l = this.ledge!;
    const mid = (l.x0 + l.x1) / 2;
    const side = this.body.x < mid ? -1 : 1;
    const tx = clamp(mid + side * (l.x1 - l.x0) * 0.22, l.x0 + 60, l.x1 - 60);
    const T = 1.15;
    const dy = l.y - this.body.y;
    this.body.vx = (tx - this.body.x) / T;
    this.body.vy = (dy - 0.5 * GRAVITY * T * T) / T;
    this.airT = 0;
    this.enter('ledge_air');
    this.hooks.shake(1.4);
    this.hooks.fx.burst(this.body.x, this.body.y - 2, { count: 18, colors: DUST, speed: [60, 170], angle: -Math.PI / 2, spread: 1.4, life: [0.25, 0.6], size: [1, 3], gravity: 100, drag: 3 });
  }

  /** На платформе: клешня хватает моба и швыряет в героя дугой. */
  private updateThrow(dt: number, h: HeroRect & { x: number }, fast: number): void {
    this.idleClaws();
    this.throwT -= dt;
    // стоит лицом к герою, клешня, что ближе, отведена назад
    if (this.throwT <= 0 && this.throwsLeft > 0) {
      if (this.hooks.mobsAlive() >= this.summonMax) {
        this.throwsLeft--; // арена и так полна: бросок пропущен (иначе босс ждал бы вечно)
        this.throwT = 0.5;
        return;
      }
      this.throwSide = h.x < this.body.x ? -1 : 1;
      const c = this.claws[this.throwSide < 0 ? 0 : 1];
      const tip = this.tip(c, 0.6);
      const id = this.summonIds[Math.floor(Math.random() * this.summonIds.length)];
      const T = rand(0.75, 1.0);
      const g = 850;
      const tx = h.x;
      const ty = (h.top + h.bottom) / 2;
      const vx = (tx - tip.x) / T;
      const vy = (ty - tip.y - 0.5 * g * T * T) / T;
      this.hooks.throwMob(id, tip.x, tip.y, vx, vy);
      this.throwsLeft--;
      this.throwT = MOB_GAP / fast;
      // отмашка клешни
      c.mode = 'throw';
      c.modeT = 0;
      c.goal = this.offset(this.anchor(c.side), this.throwSide * 130, -50);
      c.k = 800; c.c = 36;
      c.energy = 1;
      this.hooks.fx.burst(tip.x, tip.y, { count: 10, colors: THREAD_COLORS, speed: [40, 140], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2], drag: 4 });
      this.hooks.shake(0.8);
    }
    for (const c of this.claws) if (c.mode === 'throw' && c.modeT > 0.25) { c.mode = 'idle'; c.energy = 0.3; }
    if ((this.throwsLeft <= 0 && this.throwT <= -0.6) || this.stateT > 16) this.leaveLedge(h);
  }

  private leaveLedge(h: HeroRect & { x: number }): void {
    const T = 0.95;
    const tx = clamp(h.x + (h.x > this.body.x ? -90 : 90), 120, this.level.pixelWidth - 120);
    // прыжок вниз к герою: по дуге на пол арены
    const dy = this.arenaY - this.body.y;
    this.body.vx = (tx - this.body.x) / T;
    this.body.vy = (dy - 0.5 * GRAVITY * T * T) / T;
    this.airT = 0;
    this.enter('ledge_down');
  }

  // ---------- Рык ----------

  private doRoar(): void {
    this.roar = false;
    this.hooks.shake(3);
    const f = this.feet();
    this.hooks.fx.burst(f.x, f.y - 60, { count: 36, colors: MAGENTA, speed: [80, 240], spread: Math.PI * 2, life: [0.3, 0.8], size: [1, 3], drag: 3 });
    this.buildPlan();
  }

  // ---------- Касание героя ----------

  private touch(): void {
    if (this.touchCd > 0 || this.state === 'idle' || this.state === 'intro') return;
    const h = this.hooks.hero();
    // клешни бьют на лету и в замахе
    for (const c of this.claws) {
      if (c.mode === 'throw' || (Math.hypot(c.v.x, c.v.y) > 420 && c.mode !== 'smash')) {
        if (!c.hitDone) this.clawTouch(c, h, 18);
        if (c.hitDone) { this.touchCd = TOUCH_COOLDOWN; c.hitDone = false; return; }
      }
    }
    for (const k of this.hitCircles()) {
      if (k.part !== 0) continue;
      const nx = clamp(k.x, h.left, h.right);
      const ny = clamp(k.y, h.top, h.bottom);
      if (Math.hypot(k.x - nx, k.y - ny) > k.r * 0.8) continue;
      this.touchCd = TOUCH_COOLDOWN;
      this.hooks.hurt(BODY_TOUCH_DAMAGE, h.x >= k.x ? 1 : -1, false);
      return;
    }
  }

  // ---------- Рисунок ----------

  private animate(dt: number): void {
    const f = this.feet();
    this.container.position.set(Math.round(f.x), Math.round(f.y));
    // приседание: торс и ноги сплющиваются от стоп
    const squash = 1 - 0.16 * this.crouch + (this.state === 'jump_air' || this.state === 'ledge_air' || this.state === 'ledge_down' ? Math.min(0.1, Math.abs(this.body.vy) / 6000) : 0);
    this.node.scale.set(1 + 0.05 * this.crouch, squash);
    // ноги: ходьба (пары в противофазе), прыжок — поджаты, приседание — разведены
    const moving = Math.min(1, Math.abs(this.body.vx) / 60) * (this.body.grounded ? 1 : 0);
    for (const leg of this.legs) {
      const left = leg.role === 'leg_lb' || leg.role === 'leg_lf';
      const pair = leg.role === 'leg_lb' || leg.role === 'leg_rf' ? 0 : Math.PI;
      let a = Math.sin(this.walkPhase * 3 + pair) * 0.17 * moving;
      a += (left ? -1 : 1) * this.tuck * 0.38;
      a += (left ? 1 : -1) * this.crouch * 0.12;
      if (this.state === 'intro') a += Math.sin(this.time * 30) * 0.03;
      leg.sprite.rotation = a;
      leg.sprite.position.set(leg.pivot.x, leg.pivot.y + leg.dy * (1 - this.tuck));
    }
    void dt;
  }
}
