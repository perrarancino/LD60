import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { BirdBossDef, BirdHitDef, EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Particles } from '../effects/Particles.ts';
import { pal } from '../core/Palette.ts';
import type { Level } from '../world/Level.ts';
import type { Leash } from '../world/Rooms.ts';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';
import type { HeroRect } from './BossBird.ts';

// ---------- Настройка боя ----------
const ENRAGE_AT = 0.5; // доля здоровья, с которой босс звереет: быстрее, чаще, злее
const AIR_DAMAGE = 0.35; // во сколько раз гасятся удары по летящему боссу (перья): настоящий урон — когда он сидит на полу
const WING_DAMAGE = 0.6; // крылья — ещё мягче
const HOVER_SPEED = 300; // px/с: потолок скорости при зависании над героем
const HOVER_TIME: [number, number] = [1.3, 2.1]; // с: сколько висит над героем между атаками
const WINDUP = 0.8; // с: замирает и отводит крылья перед пролётом (герой успевает отпрыгнуть)
const WINDUP_LOCK = 0.2; // с: за столько до броска направление уже не меняется
const DASH_SPEED = 560; // px/с
const DASH_OVERSHOOT = 240; // px: пролетает герой насквозь и ещё столько
const DASH_MIN = 480;
const DASH_MAX = 1150;
const RECOVER = 0.55; // с: гасит скорость после пролёта
const SPIT_WIND = 0.75; // с: перед выплёвыванием птичек
const SPIT_GAP = 0.16; // с: пауза между птичками
const SPIT_FAN = 0.38; // рад: угол между соседними птичками веера
const SIT_TIME = 7; // с: сидит на полу, пока можно бить
const SIT_STAGGER = 0.35; // доля здоровья, потеряв которую сидя, птица злится и взлетает раньше срока
const LAND_SPEED = 230; // px/с: снижение
const DASH_DAMAGE = 24;
const TOUCH_DAMAGE = 12; // касание крылом, когда птица просто висит
const TOUCH_COOLDOWN = 1.0;
const BIRDS_MAX_ALIVE = 8; // больше птичек в воздухе не выпускает

const HOVER_RADIUS = 34; // px: «ядро» птицы при проверке столкновений с тайлами
const DASH_RADIUS = 20; // в пролёте — тоньше, чтобы проходить над героем, стоящим на полу
const BOUNDS_TOP = 70;
const BOUNDS_BOTTOM = 70;
const CIRCLE_ARC = 8; // точек вокруг ядра при проверке столкновений

type State = 'idle' | 'hover' | 'windup' | 'dash' | 'recover' | 'spit' | 'descend' | 'sit' | 'takeoff';
type Action = 'dash' | 'spit' | 'land';

/** Номера частей в HitCircle.part. */
const PART = { body: 0, head: 1, wing_l: 2, wing_r: 3 } as const;

const TRAIL = [pal('cobalt', 4), pal('cobalt', 5), pal('cobalt', 6), pal('cobalt', 7)];
const FEATHERS = [pal('cobalt', 5), pal('cobalt', 6), pal('cobalt', 7), pal('gold', 5)];
const DUST = [0x9fb4c8, 0x6f8296, 0xdbe9f7];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

interface Vec {
  x: number;
  y: number;
}

/** Всё, чем босс влияет на игру: герой, урон по нему, птички, призыв, тряска и частицы. */
export interface BirdBossHooks {
  hero(): HeroRect & { x: number };
  /** Урон герою; knock — сбить с ног. */
  hurt(amount: number, dirX: number, knock: boolean): void;
  spawnBird(x: number, y: number, angle: number, enraged: boolean): void;
  birdsAlive(): number;
  /** Птица села: (x центра, y пола) — игра призывает рядом обитателей локации. */
  summon(x: number, floorY: number): void;
  shake(power: number): void;
  fx: Particles;
}

interface Layer {
  sprite: Sprite;
  wing?: 'left' | 'right';
  pivot?: Vec;
}

/**
 * Босс второй локации — большая синяя птица. Кружит над героем, потом замирает, отводит крылья и проносится сквозь него по прямой
 * (как оса в Террарии), либо замирает под потолком и выпускает веер птичек-ищеек. Потеряв ход боя, спускается на пол, призывает двух
 * обитателей локации и сидит: тогда по ней можно бить в полную силу (в воздухе перья гасят удары). Одна полоса здоровья на всё тело;
 * крылья и голова — отдельные круги попадания (крылья мягче).
 */
export class BirdBoss implements PartDamageable {
  public readonly container = new Container();
  /** Комната-«дом»: босс дерётся, только пока герой в ней, и не вылетает за неё (null — без привязки). */
  public leash: Leash | null = null;

  private readonly node = new Container(); // рисунок: pivot — точка тела, зеркалится по взгляду
  private readonly layers: Layer[] = [];
  private head: Sprite | null = null;
  private readonly react: HitReaction;
  private readonly cfg: BirdBossDef;
  private readonly hitDefs: BirdHitDef[];

  private readonly maxHp: number;
  private hp: number;
  private enraged = false;
  private screech = false; // зарычал при переходе в ярость, эффект ещё не показан

  private pos: Vec;
  private vel: Vec = { x: 0, y: 0 };
  private state: State = 'idle';
  private stateT = 0;
  private time = Math.random() * 10;
  private facing: 1 | -1 = -1; // куда смотрит (мир); в рисунке — draw_facing
  private flip = 1; // сглаженное зеркало по X: 1 — как нарисовано, −1 — отражено
  private tilt = 0;
  private flap = 0; // фаза взмахов
  private wingBase = 0.3; // сглаженные: угол крыла и размах (рад)
  private wingAmp = 0.4;
  private bobY = 0;
  private trailT = 0;
  private touchCd = 0;

  private plan: Action[] = [];
  private planIdx = 0;
  private hoverGoal: Vec = { x: 0, y: 0 };
  private hoverDur = 1.5; // с: сколько висит до следующей атаки
  private hoverSide: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  private woken = false; // без комнаты: проснулась, когда герой подошёл, и больше не засыпает
  private radius = HOVER_RADIUS;

  private dashDir: Vec = { x: 1, y: 0 };
  private dashLeft = 0; // px до конца пролёта
  private spitShots = 0;
  private spitDir = 0;
  private landing: { x: number; floorY: number; phase: 'approach' | 'drop' } | null = null;
  private landT = 0;
  private sitHit = 0; // сколько здоровья потеряла, пока сидит

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly hooks: BirdBossHooks
  ) {
    const cfg = rig.bird_boss;
    if (!cfg) throw new Error(`[BirdBoss] в риге "${rig.id}" нет блока bird_boss`);
    this.cfg = cfg;
    this.hitDefs = cfg.hit;
    this.maxHp = this.hp = def.stats.max_health;

    for (const d of cfg.layers) {
      const sprite = sprites.createSprite(d.sprite_id);
      if (d.pivot) {
        sprite.pivot.set(d.pivot.x, d.pivot.y);
        sprite.position.set(d.pivot.x, d.pivot.y);
      }
      this.node.addChild(sprite);
      this.layers.push({ sprite, wing: d.wing, pivot: d.pivot });
      if (d.name === 'Head') this.head = sprite;
    }
    this.node.pivot.set(cfg.body.x, cfg.body.y);
    this.container.addChild(this.node);
    this.react = new HitReaction(this.layers.map((l) => l.sprite));

    const ts = level.tileSize;
    this.pos = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 0.5) * ts };
    this.buildPlan();
    this.animate(0);
  }

  // ---------- Бой ----------

  /** Круги попадания в мировых координатах: поворот и зеркало птицы и взмах крыла учтены. */
  public hitCircles(): HitCircle[] {
    return this.hitDefs.map((h) => {
      let x = h.x;
      let y = h.y;
      const wing = h.part === 'wing_l' ? this.layerOf('left') : h.part === 'wing_r' ? this.layerOf('right') : null;
      if (wing?.pivot) {
        const a = wing.sprite.rotation;
        const dx = h.x - wing.pivot.x;
        const dy = h.y - wing.pivot.y;
        x = wing.pivot.x + dx * Math.cos(a) - dy * Math.sin(a);
        y = wing.pivot.y + dx * Math.sin(a) + dy * Math.cos(a);
      }
      const p = this.toWorld(x, y);
      return { x: p.x, y: p.y, r: h.r, part: PART[h.part] };
    });
  }

  public onHit(): void {
    this.react.trigger(0, 0);
  }

  public damageScale(part?: number): number {
    const k = this.state === 'sit' ? 1 : AIR_DAMAGE;
    return part === PART.wing_l || part === PART.wing_r ? k * WING_DAMAGE : k;
  }

  public damagePart(_part: number, amount: number): PartDamageResult {
    this.hp -= amount;
    if (this.state === 'sit') this.sitHit += amount;
    if (this.hp <= 0) return 'dead';
    if (!this.enraged && this.hp <= this.maxHp * ENRAGE_AT) {
      this.enraged = true;
      this.screech = true;
    }
    return 'hit';
  }

  /** Центр птицы и доля здоровья (для полосы здоровья, если игра захочет её рисовать). */
  public get health(): { hp: number; max: number } {
    return { hp: this.hp, max: this.maxHp };
  }

  // ---------- Геометрия ----------

  private layerOf(side: 'left' | 'right'): Layer | undefined {
    return this.layers.find((l) => l.wing === side);
  }

  private get mirror(): 1 | -1 {
    return this.facing === this.cfg.draw_facing ? 1 : -1;
  }

  /** Точка холста -> мир: от тела, с зеркалом, покачиванием и поворотом всей птицы. */
  private toWorld(cx: number, cy: number): Vec {
    const dx = (cx - this.cfg.body.x) * this.mirror;
    const dy = cy - this.cfg.body.y + this.bobY;
    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    return { x: this.pos.x + dx * c - dy * s, y: this.pos.y + dx * s + dy * c };
  }

  private get feetOffset(): number {
    return this.cfg.feet_y - this.cfg.body.y; // от центра тела до низа лап
  }

  private heroPoint(): Vec {
    const h = this.hooks.hero();
    return { x: (h.left + h.right) / 2, y: (h.top + h.bottom) / 2 };
  }

  /** Сколько «ядер» птицы увязло бы в тайлах в точке (мир); выход за комнату считается за одно. */
  private clash(x: number, y: number, r: number): number {
    let n = 0;
    if (this.leash && !this.leash.contains(x, y)) n++;
    for (let i = 0; i < CIRCLE_ARC; i++) {
      const a = (i / CIRCLE_ARC) * Math.PI * 2;
      if (this.level.isSolidAtPixel(x + Math.cos(a) * r, y + Math.sin(a) * r)) n++;
    }
    if (this.level.isSolidAtPixel(x, y)) n++;
    // лапки: не проваливаются в пол (на 2 px выше низа, чтобы сидящая на полу птица не считалась увязшей)
    const feet = y + this.feetOffset - 2;
    for (const dx of [-12, 12]) if (this.level.isSolidAtPixel(x + dx, feet)) n++;
    return n;
  }

  /** Куда выталкивать птицу из тайлов: сумма векторов от увязших точек «ядра» к центру (нулевой — не увязла). */
  private pushOut(x: number, y: number, r: number): Vec {
    const out = { x: 0, y: 0 };
    const probe = (px: number, py: number) => {
      if (!this.level.isSolidAtPixel(px, py)) return;
      out.x += x - px;
      out.y += y - py;
    };
    for (let i = 0; i < CIRCLE_ARC; i++) {
      const a = (i / CIRCLE_ARC) * Math.PI * 2;
      probe(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    for (const dx of [-12, 12]) probe(x + dx, y + this.feetOffset - 2);
    return out;
  }

  /** Шаг по осям с упором в тайлы: двигаться можно, если не становится хуже (из тесного места выбирается). Возвращает, в какую ось упёрлась. */
  private move(dt: number): { x: boolean; y: boolean } {
    const hit = { x: false, y: false };
    const r = this.radius;
    const stepAxis = (dx: number, dy: number) => {
      const nx = this.pos.x + dx;
      const ny = this.pos.y + dy;
      const before = this.clash(this.pos.x, this.pos.y, r);
      const after = this.clash(nx, ny, r);
      if (after === 0 || after <= before) {
        this.pos.x = nx;
        this.pos.y = ny;
      } else {
        if (dx) {
          hit.x = true;
          this.vel.x = 0;
        }
        if (dy) {
          hit.y = true;
          this.vel.y = 0;
        }
      }
    };
    // зажало между тайлами (угол платформы, щель) — мягко выдавливает наружу, чтобы не застрять
    const push = this.pushOut(this.pos.x, this.pos.y, r);
    const pl = Math.hypot(push.x, push.y);
    if (pl > 0.01) {
      this.pos.x += (push.x / pl) * 160 * dt;
      this.pos.y += (push.y / pl) * 160 * dt;
    }
    stepAxis(this.vel.x * dt, 0);
    stepAxis(0, this.vel.y * dt);
    this.pos.y = clamp(this.pos.y, BOUNDS_TOP, this.level.pixelHeight - BOUNDS_BOTTOM);
    return hit;
  }

  // ---------- План боя ----------

  private buildPlan(): void {
    this.plan = this.enraged
      ? ['dash', 'dash', 'dash', 'spit', 'dash', 'dash', 'dash', 'dash', 'spit', 'land']
      : ['dash', 'dash', 'spit', 'dash', 'dash', 'dash', 'spit', 'land'];
    this.planIdx = 0;
  }

  private nextAction(): Action {
    if (this.planIdx >= this.plan.length) this.buildPlan();
    let a = this.plan[this.planIdx++];
    if (a === 'spit' && this.hooks.birdsAlive() >= BIRDS_MAX_ALIVE - 2) a = 'dash'; // птичек и так хватает
    return a;
  }

  private enter(state: State): void {
    this.state = state;
    this.stateT = 0;
    this.radius = state === 'windup' || state === 'dash' ? DASH_RADIUS : HOVER_RADIUS;
    if (state === 'hover') this.hoverDur = rand(HOVER_TIME) * (this.enraged ? 0.75 : 1);
  }

  /** Куда зависнуть над героем: сбоку и выше, чтобы потом пролететь сквозь него; точка не в стене. */
  private pickHover(): void {
    const h = this.heroPoint();
    const W = this.level.pixelWidth;
    const H = this.level.pixelHeight;
    this.hoverSide = this.hoverSide === 1 ? -1 : 1;
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? this.hoverSide : (-this.hoverSide as 1 | -1);
      const x = clamp(h.x + side * (120 + Math.random() * 60), 110, W - 110); // камера узкая (≈340 px): держимся в кадре
      const y = clamp(h.y - (70 + Math.random() * 40), BOUNDS_TOP + 20, H - BOUNDS_BOTTOM - 80);
      if (this.clash(x, y, HOVER_RADIUS) === 0) {
        this.hoverGoal = { x, y };
        return;
      }
    }
    this.hoverGoal = { x: clamp(h.x, 110, W - 110), y: clamp(h.y - 100, BOUNDS_TOP + 20, H - BOUNDS_BOTTOM - 80) };
  }

  /** Место посадки: пол рядом с героем, где над ним свободно (лапки узкие, а крылья складываются). null — негде. */
  private pickLanding(): { x: number; floorY: number } | null {
    const h = this.hooks.hero();
    const ts = this.level.tileSize;
    const need = Math.ceil((this.feetOffset + 170 + HOVER_RADIUS) / ts); // свободный столб над полом: сверху птица спускается, платформа над местом посадки мешает
    const tries = [-1, 1].flatMap((s) => [150, 190, 120, 230].map((d) => h.x + s * d)).sort(() => Math.random() - 0.5);
    tries.push(h.x);
    for (const x of tries) {
      const cx = Math.floor(x / ts);
      if (cx < 2 || cx >= this.level.widthTiles - 2) continue;
      if (this.leash && !this.leash.contains(x, h.bottom - 8)) continue;
      // пол: первая твёрдая клетка вниз от уровня героя
      let row = Math.floor((h.top - 8) / ts);
      while (row < this.level.heightTiles && !this.level.isSolid(cx, row)) row++;
      if (row >= this.level.heightTiles) continue;
      let free = true;
      for (let k = 1; k <= need && free; k++) for (const dx of [-1, 0, 1]) if (this.level.isSolid(cx + dx, row - k)) free = false;
      if (free && this.level.isSolid(cx, row) && this.level.isSolid(cx - 1, row) && this.level.isSolid(cx + 1, row)) {
        return { x: (cx + 0.5) * ts, floorY: row * ts };
      }
    }
    return null;
  }

  // ---------- Ход боя ----------

  private engaged(): boolean {
    if (this.leash) return this.leash.hero();
    const h = this.heroPoint();
    if (Math.hypot(h.x - this.pos.x, h.y - this.pos.y) < 900) this.woken = true;
    return this.woken;
  }

  /** Плавно подгоняет скорость к желаемой (мягкое зависание). */
  private steer(goal: Vec, k: number, max: number, dt: number): void {
    const wx = clamp((goal.x - this.pos.x) * k, -max, max);
    const wy = clamp((goal.y - this.pos.y) * k, -max, max);
    const a = 1 - Math.exp(-6 * dt);
    this.vel.x += (wx - this.vel.x) * a;
    this.vel.y += (wy - this.vel.y) * a;
  }

  private brake(dt: number, rate = 5): void {
    const k = Math.exp(-rate * dt);
    this.vel.x *= k;
    this.vel.y *= k;
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.stateT += dt;
    this.touchCd = Math.max(0, this.touchCd - dt);
    const fast = this.enraged ? 0.75 : 1; // у разъярённой паузы короче

    if (this.screech) this.roar();

    const awake = this.engaged();
    if (!awake && (this.state === 'hover' || this.state === 'windup' || this.state === 'spit' || this.state === 'recover' || this.state === 'dash')) this.enter('idle');
    const hero = this.heroPoint();

    switch (this.state) {
      case 'idle':
        this.brake(dt, 3);
        if (awake && this.stateT > 1) {
          this.pickHover();
          this.enter('hover');
        }
        break;

      case 'hover': {
        this.steer(this.hoverGoal, 2.6, HOVER_SPEED, dt);
        if (this.stateT >= this.hoverDur) this.begin(this.nextAction());
        break;
      }

      case 'windup': {
        // отводит себя назад от героя (разгон перед броском), следит за ним до последних мгновений
        const dur = WINDUP * fast;
        if (this.stateT < dur - WINDUP_LOCK) this.aimDash(hero);
        const back = this.dashDir;
        const k = 1 - Math.exp(-7 * dt);
        this.vel.x += (-back.x * 90 - this.vel.x) * k;
        this.vel.y += (-back.y * 90 - this.vel.y) * k;
        if (this.stateT >= dur) this.launchDash();
        break;
      }

      case 'dash': {
        const step = Math.hypot(this.vel.x, this.vel.y) * dt;
        this.dashLeft -= step;
        this.trail(dt);
        const blocked = this.move(dt);
        if (blocked.x) this.bump(); // в стену — отскок
        else if (blocked.y) {
          // пол или потолок: скользит вдоль него, не теряя скорости
          const sp = DASH_SPEED * (this.enraged ? 1.2 : 1);
          this.dashDir = { x: this.dashDir.x >= 0 ? 1 : -1, y: 0 };
          this.vel = { x: this.dashDir.x * sp, y: 0 };
        } else if (this.dashLeft <= 0) this.enter('recover');
        break;
      }

      case 'recover':
        this.brake(dt, 6);
        if (this.stateT >= RECOVER * fast) {
          this.pickHover();
          this.enter('hover');
        }
        break;

      case 'spit':
        this.updateSpit(dt, hero);
        break;

      case 'descend':
        this.updateDescend(dt);
        break;

      case 'sit': {
        this.brake(dt, 8);
        if (this.stateT >= SIT_TIME || this.sitHit >= this.maxHp * SIT_STAGGER) this.takeOff();
        break;
      }

      case 'takeoff':
        this.vel.y += (-250 - this.vel.y) * (1 - Math.exp(-4 * dt));
        this.vel.x *= Math.exp(-3 * dt);
        if (this.stateT >= 0.9) {
          this.buildPlan();
          this.pickHover();
          this.enter('hover');
        }
        break;
    }

    if (this.state !== 'dash') this.move(dt);
    this.faceTo(hero);
    this.touch();
    this.animate(dt);
    this.react.update(dt);
  }

  private begin(a: Action): void {
    if (a === 'dash') {
      this.aimDash(this.heroPoint());
      this.enter('windup');
    } else if (a === 'spit') {
      this.spitShots = 0;
      this.enter('spit');
    } else {
      const land = this.pickLanding();
      if (!land) {
        this.pickHover();
        this.enter('hover');
        return;
      }
      this.landing = { ...land, phase: 'approach' };
      this.landT = 0;
      this.enter('descend');
    }
  }

  /** Направление броска на героя; дальность — до героя и ещё запас насквозь. */
  private aimDash(h: Vec): void {
    const dx = h.x - this.pos.x;
    const dy = h.y - this.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    this.dashDir = { x: dx / d, y: dy / d };
    this.dashLeft = clamp(d + DASH_OVERSHOOT, DASH_MIN, DASH_MAX);
  }

  private launchDash(): void {
    const sp = DASH_SPEED * (this.enraged ? 1.2 : 1);
    this.vel = { x: this.dashDir.x * sp, y: this.dashDir.y * sp };
    this.enter('dash');
    this.hooks.shake(1.2);
    this.hooks.fx.burst(this.pos.x, this.pos.y, { count: 10, colors: FEATHERS, speed: [60, 180], angle: Math.atan2(-this.dashDir.y, -this.dashDir.x), spread: 0.7, life: [0.15, 0.35], size: [1, 2], drag: 4 });
  }

  /** Врезалась в стену, пол или потолок на пролёте: отскок, перья, тряска. */
  private bump(): void {
    this.hooks.shake(2.6);
    this.hooks.fx.burst(this.pos.x, this.pos.y, { count: 16, colors: FEATHERS, speed: [40, 150], spread: Math.PI * 2, life: [0.2, 0.5], size: [1, 2], gravity: 100, drag: 3 });
    this.vel = { x: -this.dashDir.x * 140, y: -this.dashDir.y * 140 };
    this.enter('recover');
  }

  private trail(dt: number): void {
    this.trailT -= dt;
    if (this.trailT > 0) return;
    this.trailT = 0.025;
    this.hooks.fx.burst(this.pos.x, this.pos.y, { count: 3, colors: TRAIL, speed: [10, 50], spread: Math.PI * 2, life: [0.2, 0.42], size: [1, 2], drag: 3 });
  }

  private updateSpit(dt: number, hero: Vec): void {
    this.brake(dt, 4);
    const fast = this.enraged ? 0.75 : 1;
    const wind = SPIT_WIND * fast;
    const total = this.enraged ? 7 : 5;
    if (this.stateT < wind) {
      this.spitDir = Math.atan2(hero.y - this.pos.y, hero.x - this.pos.x);
      return;
    }
    const due = Math.min(total, 1 + Math.floor((this.stateT - wind) / (SPIT_GAP * fast)));
    while (this.spitShots < due) {
      const i = this.spitShots++;
      const a = this.spitDir + (i - (total - 1) / 2) * SPIT_FAN;
      const m = this.toWorld(66, 56); // кончик клюва
      this.hooks.spawnBird(m.x + Math.cos(a) * 8, m.y + Math.sin(a) * 8, a, this.enraged);
      this.vel.x -= Math.cos(a) * 28; // отдача
      this.vel.y -= Math.sin(a) * 28;
      this.hooks.fx.burst(m.x, m.y, { count: 5, colors: FEATHERS, speed: [30, 100], angle: a, spread: 0.6, life: [0.15, 0.3], size: [1, 2], drag: 4 });
    }
    if (this.spitShots >= total && this.stateT >= wind + total * SPIT_GAP * fast + 0.5) {
      this.pickHover();
      this.enter('hover');
    }
  }

  private updateDescend(dt: number): void {
    const l = this.landing;
    if (!l) return;
    this.landT += dt;
    const restY = l.floorY - this.feetOffset; // тело, когда лапки на полу
    if (l.phase === 'approach') {
      this.steer({ x: l.x, y: restY - 170 }, 3, 340, dt);
      if (Math.abs(this.pos.x - l.x) < 26 && this.pos.y < restY - 100) l.phase = 'drop';
    } else {
      this.vel.x += (clamp((l.x - this.pos.x) * 5, -120, 120) - this.vel.x) * (1 - Math.exp(-10 * dt));
      this.vel.y += (LAND_SPEED - this.vel.y) * (1 - Math.exp(-3 * dt));
      if (this.pos.y + this.vel.y * dt >= restY) {
        this.pos.x = l.x;
        this.pos.y = restY;
        this.vel = { x: 0, y: 0 };
        this.land(l.x, l.floorY);
        return;
      }
    }
    if (this.landT > 7) { // не получается сесть — возвращается к бою
      this.landing = null;
      this.pickHover();
      this.enter('hover');
    }
  }

  private land(x: number, floorY: number): void {
    this.landing = null;
    this.sitHit = 0;
    this.enter('sit');
    this.hooks.shake(3.4);
    for (const side of [-1, 1]) {
      this.hooks.fx.burst(x + side * 14, floorY - 2, {
        count: 12, colors: DUST, speed: [50, 170], angle: side > 0 ? -0.2 : Math.PI + 0.2, spread: 0.4, life: [0.25, 0.6], size: [1, 3], gravity: 110, drag: 3
      });
    }
    this.hooks.fx.burst(x, floorY - 30, { count: 14, colors: FEATHERS, speed: [40, 140], spread: Math.PI * 2, life: [0.25, 0.6], size: [1, 2], gravity: 90, drag: 2 });
    this.hooks.summon(x, floorY);
  }

  private takeOff(): void {
    this.enter('takeoff');
    this.hooks.shake(1.6);
    this.hooks.fx.burst(this.pos.x, this.pos.y + this.feetOffset, { count: 12, colors: DUST, speed: [60, 160], angle: -Math.PI / 2, spread: 1.2, life: [0.2, 0.5], size: [1, 3], gravity: 60, drag: 3 });
  }

  private roar(): void {
    this.screech = false;
    this.hooks.shake(2.4);
    this.hooks.fx.burst(this.pos.x, this.pos.y, { count: 26, colors: FEATHERS, speed: [80, 220], spread: Math.PI * 2, life: [0.25, 0.6], size: [1, 3], drag: 3 });
    if (this.state !== 'sit' && this.state !== 'descend') this.buildPlan();
  }

  // ---------- Касание героя ----------

  private touch(): void {
    if (this.touchCd > 0 || this.state === 'sit' || this.state === 'idle' || (this.state === 'takeoff' && this.stateT > 0.3)) return;
    const h = this.hooks.hero();
    const dashing = this.state === 'dash';
    for (const c of this.hitCircles()) {
      const nx = clamp(c.x, h.left, h.right);
      const ny = clamp(c.y, h.top, h.bottom);
      if (Math.hypot(c.x - nx, c.y - ny) > c.r * 0.8) continue;
      this.touchCd = dashing ? 1.4 : TOUCH_COOLDOWN;
      const dmg = dashing ? DASH_DAMAGE * (this.enraged ? 1.15 : 1) : TOUCH_DAMAGE;
      this.hooks.hurt(Math.round(dmg), h.x >= c.x ? 1 : -1, dashing);
      break;
    }
  }

  // ---------- Рисунок ----------

  /** Взгляд: на героя; в пролёте — по ходу. */
  private faceTo(hero: Vec): void {
    let dir = 0;
    if (this.state === 'dash' || this.state === 'windup') dir = this.dashDir.x;
    else dir = hero.x - this.pos.x;
    if (Math.abs(dir) > 8) this.facing = dir >= 0 ? 1 : -1;
  }

  private animate(dt: number): void {
    let base = 0.3;
    let amp = 0.45;
    let rate = 9;
    switch (this.state) {
      case 'windup': base = 1.0; amp = 0.07; rate = 34; break; // вскинутые трясущиеся крылья
      case 'dash': base = 0.8; amp = 0.1; rate = 5; break; // обтекаемо, крылья назад-вверх
      case 'spit': base = 0.4; amp = 0.75; rate = 13; break;
      case 'descend': base = 0.15; amp = 0.7; rate = 7; break;
      case 'takeoff': base = 0.15; amp = 0.85; rate = 12; break;
      case 'sit': base = -1.1; amp = 0.04; rate = 1.4; break; // крылья сложены вниз
      case 'idle': base = 0.25; amp = 0.3; rate = 5; break;
    }
    const k = dt > 0 ? 1 - Math.exp(-9 * dt) : 1;
    this.wingBase += (base - this.wingBase) * k;
    this.wingAmp += (amp - this.wingAmp) * k;
    this.flap += rate * dt;
    const swing = this.wingBase + this.wingAmp * Math.sin(this.flap);
    for (const l of this.layers) {
      if (l.wing === 'left') l.sprite.rotation = swing; // левое крыло поднимается положительным углом, правое — отрицательным
      else if (l.wing === 'right') l.sprite.rotation = -swing;
    }
    if (this.head) this.head.rotation = 0.06 * Math.sin(this.time * 2.3) + (this.state === 'windup' ? 0.1 * this.mirror : 0);

    // тело: качается вместе со взмахами, дышит сидя; в замахе дрожит
    const sitting = this.state === 'sit';
    this.bobY = sitting ? Math.sin(this.time * 2.2) * 0.8 : Math.cos(this.flap) * (this.state === 'dash' ? 0.8 : 2.6);
    let jx = 0;
    let jy = 0;
    if (this.state === 'windup') {
      jx = (Math.random() - 0.5) * 2.6;
      jy = (Math.random() - 0.5) * 2.6;
    }
    // зеркало: плавный разворот через ноль
    this.flip += (this.mirror - this.flip) * (dt > 0 ? 1 - Math.exp(-16 * dt) : 1);
    this.node.scale.x = this.flip;
    // наклон по скорости: носом по ходу
    const vx = this.vel.x;
    const want = this.state === 'dash' ? Math.atan2(this.vel.y, Math.abs(vx) + 1) * 0.5 * (vx >= 0 ? 1 : -1) : clamp(vx / 1400, -0.18, 0.18);
    this.tilt += (want - this.tilt) * (dt > 0 ? 1 - Math.exp(-10 * dt) : 1);
    this.container.rotation = this.tilt;
    this.container.position.set(Math.round(this.pos.x), Math.round(this.pos.y));
    this.node.position.set(jx, this.bobY + jy);
  }
}
