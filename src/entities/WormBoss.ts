import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { AttachmentDef, EnemyDef, EnemySpawnDef, FlightDef, RigDef, SegmentDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { Particles } from '../effects/Particles.ts';
import type { DynLight } from '../effects/Lightning.ts';
import { pal } from '../core/Palette.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';
import { SegmentChain } from './SegmentChain.ts';
import type { ChainPartDef, PartKind, Vec } from './SegmentChain.ts';
import { applySolidMask } from './solidMask.ts';
import type { Leash } from '../world/Rooms.ts';

const BOUNDS_MARGIN_X = 64; // px: дальше от краёв уровня голова разворачивается к центру
const BOUNDS_TOP = 50;
const BOUNDS_BOTTOM = 80; // ниже пола уходить можно (тело скрыто в блоках), но не слишком глубоко
const SPEED_RATE = 2.2; // 1/с: как быстро скорость догоняет желаемую
const WANDER = 0.35; // рад: голова чуть виляет по курсу, пока далеко от героя — траектория не прямая как линейка
const WANDER_RATE = 1.3; // рад/с
const WANDER_RANGE = 240; // px: дальше этого от цели голова виляет
const SWAY_LAG = 0.1; // сколько рад отклоняются щупальца на каждый рад/с поворота головы (отстают, как на ветру)
const SWAY_LAG_MAX = 0.4;
const PHASE_RATE = 5; // рад/с: волна тела

// ---- Атаки: цикл «таран -> отдых -> паучий дождь -> отдых -> ...»
const RAM_PASSES = 3; // сколько пролётов сквозь героя в одной серии тарана
const RAM_BOOST = 1.25; // добавка к boost рига: серия тарана быстрее обычного полёта
const RAM_TURN = 1.4; // во сколько раз круче разворачивается между пролётами в серии тарана (петли теснее — пролёты чаще)
const BODY_DAMAGE = 0.4; // доля урона тарана, которую наносит касание телом (головой — полный)
const HIT_CD = 1.2; // с: пауза между попаданиями по герою
const HIT_REACH = 0.8; // доля радиуса части, на которой герой считается задетым
const REST_TIME = 2.6; // с: передышка между атаками (герой в это время цел)
const REST_SPEED = 0.55; // доля скорости на передышке
const RAIN_TIME = 8; // с: паучий дождь
const RAIN_SPEED = 0.9; // доля скорости в дожде
const RAIN_TURN = 1.45; // во сколько раз круче поворачивает в дожде (держится над героем)
const RAIN_HEIGHT = 175; // px: на сколько выше героя летит в дожде
const RAIN_SWEEP = 230; // px: на сколько в стороны от героя размахивается
const RAIN_FIRST_BATCH = 4; // сколько паучков выкидывает разом в начале дождя
const RAIN_INTERVAL = 0.7; // с: потом по одному
const RAIN_TOP = 90; // px: выше этого над уровнем не летит
const SLOW = 0.85; // множитель скорости героя, пока идёт дождь (−15 %)
const ENRAGE = 0.5; // доля здоровья головы, ниже которой босс звереет
const NEON = [pal('virus', 4), pal('virus', 5), pal('virus', 6), pal('plasma', 4), pal('plasma', 5), pal('electric', 5), pal('electric', 6)];
const GOO = [pal('virus', 5), pal('virus', 6), pal('plasma', 5), pal('electric', 6)];

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Тело героя в мире (прямоугольник). */
export interface WormBossHero {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Связь босса с игрой: герой, урон ему, паучки из тела, тряска, частицы. */
export interface WormBossHooks {
  hero: () => WormBossHero;
  /** Урон герою; knock — сбить с ног. Возвращает true, если урон засчитан (не неуязвимость и не шанс брони). */
  hurt: (amount: number, dirX: number, knock: boolean) => boolean;
  /** Выкидывает паучка из точки с начальной скоростью; false — паучков уже слишком много. */
  spawnSpider: (x: number, y: number, vx: number, vy: number) => boolean;
  shake: (power: number) => void;
  fx: Particles;
}

type Phase = 'idle' | 'ram' | 'rest' | 'rain';

interface Tentacle {
  sprite: Sprite;
  attach: Vec;
  amp: number;
  speed: number;
  phase: number;
}

/**
 * Босс — большой червь, который летает, как в Террарии: голова доворачивает к герою с ограниченной скоростью поворота, проносится
 * мимо и делает широкие петли; тело едет по следу головы и извивается. Сквозь тайлы проходит (часть тела внутри блоков скрыта маской,
 * контейнер рисуется под тайлами). Состоит из частей — голова, звенья, хвост; у каждой своё здоровье (голова держит и щупальца):
 * выбитая часть исчезает, остальные смыкаются, а гибель головы — гибель босса.
 *
 * Две атаки по кругу, между ними — передышка, когда босс безопасен:
 *  1) Таран: серия пролётов прямо в героя, как у червей Террарии; касание головой — полный урон и сбивание с ног, телом — меньше.
 *  2) Паучий дождь: босс выкидывает из тела паучков (они падают и бегут на героя), летит поверху, размахиваясь над героем
 *     и распыляя неоновые частицы; пока идёт атака, герой бежит на 15 % медленнее.
 */
export class WormBoss implements PartDamageable {
  public readonly container = new Container();

  private readonly chain: SegmentChain;
  private readonly tentacles: Tentacle[] = [];
  private readonly flight: FlightDef;
  private readonly speed: number;

  private p: Vec;
  private heading: number;
  private speedNow: number;
  private phase = Math.random() * Math.PI * 2;
  private time = 0;
  private mode: 'seek' | 'pass' = 'seek';
  private passT = 0;
  private turnRate = 0; // сглаженная скорость поворота головы, рад/с

  // Атаки
  private attack: Phase = 'idle';
  private attackT = 0;
  private passes = 0; // сколько пролётов в серии тарана уже начато
  private next: 'ram' | 'rain' = 'ram'; // что за передышкой
  private hitCd = 0;
  private restSide: 1 | -1 = 1; // с какой стороны от героя кружит на передышке
  private sweepDir: 1 | -1 = 1; // куда размахивается в дожде
  private spiderT = 0;
  private sprayT = 0;
  private readonly ramDamage: number;
  private readonly maxHeadHp: number;
  /** Комната-«дом»: босс охотится за героем только в ней и не покидает её (null — без привязки). */
  public leash: Leash | null = null;

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly hooks: WormBossHooks
  ) {
    const seg = rig.segmented;
    if (!seg?.flight) throw new Error(`[WormBoss] в риге "${rig.id}" нет блока segmented.flight`);
    this.flight = seg.flight;
    this.speed = def.stats.movement_speed;
    this.speedNow = this.speed;
    this.ramDamage = def.attack.damage;

    const total = Math.max(seg.length_min, Math.min(seg.length_max, spawn.length ?? seg.length_max));
    const hp = seg.health ?? { body: def.stats.max_health, tail: def.stats.max_health };
    const radius = seg.thickness / 2;
    this.maxHeadHp = hp.head ?? def.stats.max_health;

    const parts: ChainPartDef[] = [this.makeHead(seg.head, hp.head ?? def.stats.max_health, radius, sprites)];
    for (let i = 0; i < total - 2; i++) parts.push(this.makePart('body', seg.body, hp.body, radius, sprites));
    parts.push(this.makePart('tail', seg.tail, hp.tail, radius, sprites));
    const gap = (prev: PartKind, kind: PartKind) =>
      kind === 'tail' ? (prev === 'head' ? seg.head_to_body : seg.body_to_tail) : prev === 'head' ? seg.head_to_body : seg.body_to_body;
    this.chain = new SegmentChain(this.container, parts, gap);

    applySolidMask(this.container, level);
    const ts = level.tileSize;
    this.p = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 0.5) * ts };
    this.heading = Math.random() < 0.5 ? Math.PI : 0; // вылетает вбок
    this.chain.reset(this.p, { x: Math.cos(this.heading), y: Math.sin(this.heading) }, this.phase, this.heading + Math.PI / 2);
  }

  private makePart(kind: PartKind, d: SegmentDef, hp: number, thickness: number, sprites: SpriteLibrary): ChainPartDef {
    const sprite = sprites.createSprite(d.sprite_id);
    sprite.pivot.set(d.center.x, d.center.y);
    return { kind, node: sprite, radius: d.hit_radius ?? thickness, hp, scale: d.scale ?? 1 };
  }

  /** Голова: рисунок + щупальца позади него + «шапки» поверх, всё на общем холсте рига; качаются щупальца вокруг своей точки крепления. */
  private makeHead(d: SegmentDef, hp: number, thickness: number, sprites: SpriteLibrary): ChainPartDef {
    const node = new Container();
    node.pivot.set(d.center.x, d.center.y);
    const add = (a: AttachmentDef, i: number) => {
      const sprite = sprites.createSprite(a.sprite_id);
      if (a.pivot && a.sway) {
        sprite.pivot.set(a.pivot.x, a.pivot.y);
        sprite.position.set(a.pivot.x, a.pivot.y);
        this.tentacles.push({
          sprite, attach: a.pivot, amp: a.sway, speed: a.speed ?? 2.5, phase: a.phase ?? i * 1.7
        });
      }
      node.addChild(sprite);
    };
    (d.under ?? []).forEach(add);
    const body = sprites.createSprite(d.sprite_id);
    node.addChild(body);
    (d.over ?? []).forEach(add);
    return { kind: 'head', node, radius: d.hit_radius ?? thickness, hp, scale: d.scale ?? 1 };
  }

  // ---------- Бой ----------

  /** За пределами уровня и в твёрдых клетках части скрыты и не бьются. */
  private hidden(x: number, y: number): boolean {
    const ts = this.level.tileSize;
    const cy = Math.floor(y / ts);
    if (cy < 0 || cy >= this.level.heightTiles) return true;
    const cx = Math.floor(x / ts);
    if (cx < 0 || cx >= this.level.widthTiles) return true;
    return this.level.isSolid(cx, cy);
  }

  public hitCircles(): HitCircle[] {
    return this.chain.circles((x, y) => this.hidden(x, y));
  }

  public onHit(dirX: number, dirY: number, part?: number): void {
    if (part !== undefined) this.chain.flash(part, dirX, dirY);
  }

  /** Урон части. Выбитая часть исчезает, остальные смыкаются; выбита голова — босс погиб целиком. */
  public damagePart(part: number, amount: number): PartDamageResult {
    const seg = this.chain.find(part);
    const result = this.chain.damage(part, amount);
    if (result !== 'killed') return 'hit';
    if (seg?.kind === 'head') return 'dead';
    this.chain.remove(part);
    return 'killed';
  }

  // ---------- Состояние для игры ----------

  /** Босс в бою (для полосы здоровья): герой в его комнате. */
  public get active(): boolean {
    return this.attack !== 'idle';
  }

  /** Здоровье головы: её гибель — гибель босса. */
  public get health(): { hp: number; max: number } {
    return { hp: this.chain.find(0)?.hp ?? 0, max: this.maxHeadHp };
  }

  /** Множитель скорости героя: во время паучьего дождя 0.85 (−15 %), иначе 1. */
  public get heroSlow(): number {
    return this.attack === 'rain' ? SLOW : 1;
  }

  /** Неоновое свечение в дожде: у головы и посередине тела. */
  public lights(): DynLight[] {
    if (this.attack !== 'rain') return [];
    const segs = this.chain.segments;
    const out: DynLight[] = [];
    for (const s of [segs[0], segs[Math.floor(segs.length / 2)]]) {
      if (!s) continue;
      out.push({ x: s.node.x, y: s.node.y, r: 120, i: 0.55 + 0.2 * Math.random(), c: [0.97, 0.42, 0.99] });
    }
    return out;
  }

  private get enraged(): boolean {
    return (this.chain.find(0)?.hp ?? 0) < this.maxHeadHp * ENRAGE;
  }

  // ---------- Атаки ----------

  /** Смена атаки: таран -> отдых -> дождь -> отдых -> ...; нет героя в комнате — босс затихает. */
  private updateAttack(dt: number, target: Vec | null): void {
    this.attackT += dt;
    this.hitCd -= dt;
    if (!target) {
      this.attack = 'idle';
      return;
    }
    if (this.attack === 'idle') this.startRam();
    if (this.attack === 'ram') {
      // серия закончена: последний пролёт отлетел -> передышка
      if (this.passes >= RAM_PASSES && this.mode === 'seek') this.startRest('rain');
    } else if (this.attack === 'rest') {
      if (this.attackT >= REST_TIME * (this.enraged ? 0.7 : 1)) {
        if (this.next === 'rain') this.startRain(); else this.startRam();
      }
    } else if (this.attack === 'rain') {
      this.updateRain(dt);
      if (this.attackT >= RAIN_TIME * (this.enraged ? 1.25 : 1)) this.startRest('ram');
    }
  }

  private startRam(): void {
    this.attack = 'ram';
    this.attackT = 0;
    this.passes = 0;
    this.mode = 'seek';
  }

  private startRest(next: 'ram' | 'rain'): void {
    this.attack = 'rest';
    this.attackT = 0;
    this.next = next;
    this.mode = 'seek';
    this.restSide = Math.random() < 0.5 ? -1 : 1;
  }

  private startRain(): void {
    this.attack = 'rain';
    this.attackT = 0;
    this.spiderT = 0.5;
    this.sprayT = 0;
    this.sweepDir = Math.random() < 0.5 ? -1 : 1;
    this.mode = 'seek';
    this.hooks.shake(2.5);
    const head = this.chain.segments[0];
    if (head) {
      this.hooks.fx.burst(head.node.x, head.node.y, { count: 26, colors: NEON, speed: [60, 190], spread: Math.PI * 2, life: [0.3, 0.7], size: [1, 3], drag: 2.5, grow: 0.4 });
    }
    for (let i = 0; i < RAIN_FIRST_BATCH; i++) this.dropSpider();
  }

  /** Дождь: из тела сыплются паучки, по всей длине тела распыляется неон, а у героя неоновая пыль (игра читает heroSlow и замедляет его). */
  private updateRain(dt: number): void {
    this.spiderT -= dt;
    if (this.spiderT <= 0) {
      this.spiderT = RAIN_INTERVAL * (this.enraged ? 0.65 : 1);
      this.dropSpider();
    }
    // неон: частицы падают с тела вниз и плывут, не гаснут мгновенно
    this.sprayT -= dt;
    while (this.sprayT <= 0) {
      this.sprayT += 0.014;
      const segs = this.chain.segments;
      const s = segs[Math.floor(Math.random() * segs.length)];
      if (!s || this.hidden(s.node.x, s.node.y)) continue;
      const a = Math.PI / 2 + (Math.random() - 0.5) * 1.5;
      const v = 25 + Math.random() * 85;
      this.hooks.fx.emit(
        s.node.x + (Math.random() - 0.5) * s.radius, s.node.y + (Math.random() - 0.5) * s.radius * 0.6,
        Math.cos(a) * v, Math.sin(a) * v, NEON[Math.floor(Math.random() * NEON.length)], 1.1 + Math.random() * 1,
        1 + Math.random() * 2, { gy: 45, drag: 0.9, grow: 0.3 }
      );
    }
    // неоновая пыль у героя: показывает, что он замедлен
    if (Math.random() < dt * 22) {
      const h = this.hooks.hero();
      this.hooks.fx.emit(
        lerp(h.left, h.right, Math.random()), lerp(h.top, h.bottom, Math.random()), (Math.random() - 0.5) * 20, -14 - Math.random() * 26,
        NEON[Math.floor(Math.random() * NEON.length)], 0.5 + Math.random() * 0.5, 1 + Math.random(), { grow: 0.2 }
      );
    }
  }

  /** Выкидывает паучка из случайной видимой части тела (не из скрытой в блоках). */
  private dropSpider(): void {
    const segs = this.chain.segments.filter((s) => !this.hidden(s.node.x, s.node.y));
    const s = segs[Math.floor(Math.random() * segs.length)];
    if (!s) return;
    const h = this.hooks.hero();
    const toHero = (h.left + h.right) / 2 > s.node.x ? 1 : -1;
    const vx = (Math.random() * 2 - 1) * 70 + toHero * 25;
    const vy = 20 + Math.random() * 80;
    if (!this.hooks.spawnSpider(s.node.x, s.node.y, vx, vy)) return;
    this.hooks.fx.burst(s.node.x, s.node.y, { count: 10, colors: GOO, speed: [30, 110], spread: Math.PI * 2, life: [0.2, 0.5], size: [1, 3], gravity: 160, drag: 2, grow: 0.4 });
  }

  /** Касание героя частью тела: урон (головой полный и с падением, телом меньше). Только в таране и дожде; передышка безопасна. */
  private checkRam(): void {
    if (this.hitCd > 0 || (this.attack !== 'ram' && this.attack !== 'rain')) return;
    const h = this.hooks.hero();
    for (const c of this.hitCircles()) {
      const nx = clamp(c.x, h.left, h.right);
      const ny = clamp(c.y, h.top, h.bottom);
      if (Math.hypot(c.x - nx, c.y - ny) > c.r * HIT_REACH) continue;
      const head = c.part === 0;
      const dirX = (h.left + h.right) / 2 >= c.x ? 1 : -1;
      if (this.hooks.hurt(Math.round(this.ramDamage * (head ? 1 : BODY_DAMAGE)), dirX, head)) {
        this.hitCd = HIT_CD;
        this.hooks.shake(head ? 5 : 3);
        this.hooks.fx.burst(nx, ny, { count: 12, colors: NEON, speed: [50, 150], spread: Math.PI * 2, life: [0.15, 0.4], size: [1, 2] });
      } else {
        this.hitCd = 0.3; // урон не засчитан (неуязвим / шанс брони) — повторим чуть позже
      }
      return;
    }
  }

  // ---------- Полёт ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.phase += PHASE_RATE * dt;
    const f = this.flight;
    const ts = this.level.tileSize;
    const W = this.level.widthTiles * ts;
    const H = this.level.heightTiles * ts;

    const hero = this.leash && !this.leash.hero() ? null : this.hooks.hero();
    const target: Vec | null = hero ? { x: (hero.left + hero.right) / 2, y: (hero.top + hero.bottom) / 2 } : null;
    this.updateAttack(dt, target);

    let want = this.heading;
    let steering = true;
    let turnMult = 1;
    const leaving = !!this.leash && !this.leash.contains(this.p.x, this.p.y);
    const outside = leaving || this.p.x < BOUNDS_MARGIN_X || this.p.x > W - BOUNDS_MARGIN_X || this.p.y < BOUNDS_TOP || this.p.y > H + BOUNDS_BOTTOM;
    if (outside) {
      // у края арены (или за границей комнаты) — назад к центру (не раздумывая о герое)
      const home = this.leash ? this.leash.center : { x: W / 2, y: H * 0.4 };
      want = Math.atan2(home.y - this.p.y, home.x - this.p.x);
      this.mode = 'seek';
    } else if (this.attack === 'ram' && this.mode === 'pass') {
      // пролёт мимо: держит курс (чуть виляет), пока не пройдёт время или не выйдет за дальность
      this.passT -= dt;
      steering = false;
      if (this.passT <= 0) this.mode = 'seek';
    } else if (target && this.attack === 'ram') {
      turnMult = RAM_TURN;
      const dx = target.x - this.p.x;
      const dy = target.y - this.p.y;
      const dist = Math.hypot(dx, dy);
      want = Math.atan2(dy, dx);
      if (dist > WANDER_RANGE) want += WANDER * Math.sin(this.time * WANDER_RATE);
      if (dist < f.pass_distance && Math.abs(wrap(want - this.heading)) < 1.2) {
        this.mode = 'pass';
        this.passT = rand(f.pass_time);
        this.passes++;
      }
    } else if (target && this.attack === 'rest') {
      // передышка: лениво кружит в стороне от героя
      const px = target.x + this.restSide * 280;
      const py = Math.max(RAIN_TOP, target.y - 150);
      want = Math.atan2(py - this.p.y, px - this.p.x) + 0.25 * Math.sin(this.time * 1.1);
    } else if (target && this.attack === 'rain') {
      // дождь: летит поверху, размахиваясь над героем из стороны в сторону
      const px = target.x + this.sweepDir * RAIN_SWEEP;
      const py = Math.max(RAIN_TOP, target.y - RAIN_HEIGHT) + 14 * Math.sin(this.time * 2.2);
      if (Math.abs(this.p.x - px) < 55) this.sweepDir = (-this.sweepDir) as 1 | -1;
      want = Math.atan2(py - this.p.y, px - this.p.x);
      turnMult = RAIN_TURN;
    }

    const maxTurn = f.turn_rate * turnMult * (this.enraged ? 1.15 : 1) * dt;
    const turn = steering ? clamp(wrap(want - this.heading), -maxTurn, maxTurn) : 0;
    this.heading = wrap(this.heading + turn);
    this.turnRate += (turn / Math.max(dt, 1e-3) - this.turnRate) * (1 - Math.exp(-8 * dt));

    const phaseSpeed = this.attack === 'rest' ? REST_SPEED : this.attack === 'rain' ? RAIN_SPEED : 1;
    const boost = this.attack === 'ram' && this.mode === 'pass' ? f.boost * RAM_BOOST : 1;
    const speedWant = this.speed * boost * phaseSpeed * (this.enraged ? 1.12 : 1);
    this.speedNow += (speedWant - this.speedNow) * (1 - Math.exp(-SPEED_RATE * dt));
    this.p = { x: this.p.x + Math.cos(this.heading) * this.speedNow * dt, y: this.p.y + Math.sin(this.heading) * this.speedNow * dt };

    // щупальца качаются и отстают при повороте головы
    const lag = clamp(-this.turnRate * SWAY_LAG, -SWAY_LAG_MAX, SWAY_LAG_MAX);
    for (const t of this.tentacles) t.sprite.rotation = t.amp * Math.sin(this.time * t.speed + t.phase) + lag;

    this.chain.update(dt, this.p, this.phase, f.wave, 0, this.heading + Math.PI / 2);
    this.checkRam();
  }
}
