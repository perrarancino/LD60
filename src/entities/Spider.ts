import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef } from '../data/types.ts';
import type { Particles } from '../effects/Particles.ts';
import type { Level } from '../world/Level.ts';
import type { Hittable, HitCircle } from './Hittable.ts';
import { HitReaction } from './HitReaction.ts';
import { TwoBoneLeg } from './TwoBoneLeg.ts';

// ---- Ползание по поверхностям
const BODY_FRONT = 9; // px: на таком расстоянии впереди центра проверяем стену (внутренний угол)
const WALL_PROBE_HEIGHT = 4; // px над поверхностью, на которой проверяем стену впереди
const EDGE_PROBE = 1.5; // px под поверхностью — проверка опоры под телом (внешний угол)
const EDGE_WRAP_DEPTH = 3; // px: на сколько паук «сползает» по грани за край
const FOLLOW_POS = 55; // 1/с: сглаживание видимой позиции (скругляет резкие переходы на углах)
const FOLLOW_ANGLE = 26; // 1/с: сглаживание поворота тела

// ---- Анимация бега (процедурная): стопы идут по замкнутой траектории, ноги — двухкостный IK (длина костей не меняется)
const STRIDE_HALF = 2.4; // px: полуразмах стопы вперёд-назад от нейтрального положения
const FOOT_LIFT = 2.6; // px: подъём стопы в махе
const BODY_BOB = 0.55; // px: покачивание тела на шаге
const HEAD_NOD = 0.07; // рад: кивок головы на шаге
const TORSO_ROCK = 0.03; // рад: покачивание торса
const SPRINT_BOOST = 1.9; // ускорение ног на поворотах у углов (паук «семенит»)

// ---- Поведение: бег рывками с остановками
const RUN_TIME: [number, number] = [1.6, 4.2];
const PAUSE_TIME: [number, number] = [0.5, 1.3];

// ---- Выплюнутый паучок: летит по дуге, потом садится на поверхность и ползёт как обычный
const GRAVITY = 520; // px/с²
const FLY_STEP = 2; // px: максимальный шаг интегрирования полёта (чтобы не пролететь сквозь тайл)
const FLY_GROW = 0.3; // с: паучок «вылетает из глубины» — вырастает от малого размера до своего
const FADE_TIME = 1.5; // с: плавное исчезновение перед концом жизни

// ---- Удар по пауку: круги попадания вдоль тела и реакция
const HIT_RADIUS = 8; // px (при scale = 1)
const HIT_SPREAD = 7; // px: круги разнесены вдоль тела (при scale = 1)
const HIT_LIFT = 7; // px: центр тела над поверхностью (при scale = 1)

export interface SpiderOptions {
  scale?: number; // размер относительно нарисованного (паучки меньше)
  lifetime?: number; // через сколько секунд исчезает (по умолчанию — не исчезает)
  fx?: Particles; // частицы: след в полёте и пыль при посадке
}

interface Vec {
  x: number;
  y: number;
}

interface Foot {
  leg: TwoBoneLeg;
  hip: Vec; // бедро в системе тела (начало — точка контакта, +x по рисунку)
  rest: Vec; // нейтральная стопа в системе тела (на поверхности)
  phase: number; // сдвиг фазы ноги в цикле (диагональные пары в противофазе)
}

const easeOutBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

/**
 * Паук-ползун. Тело ползёт по любой поверхности тайлов — полу, стенам, потолку, огибая внутренние и внешние углы
 * (ориентация тела — одна из четырёх: нормаль n смотрит от поверхности). Четыре ноги по две фаланги: настоящий двухкостный IK
 * (бедро -> колено -> стопа), колено смотрит вверх от тела, нарисованная форма и длина ног сохраняются. Бег анимируется
 * процедурно: диагональные пары ног в противофазе, стопа идёт назад по поверхности и взмахом возвращается вперёд,
 * тело и голова покачиваются; паук бегает рывками, замирает и «осматривается».
 */
export class Spider implements Hittable {
  public readonly container = new Container();

  private readonly bodyContainer = new Container();
  private torso: Sprite | null = null;
  private head: Sprite | null = null;
  private feet: Foot[] = [];

  // Истинное состояние: точка контакта S, нормаль n (от поверхности), направление движения t
  private s: Vec = { x: 0, y: 0 };
  private n: Vec = { x: 0, y: -1 };
  private t: Vec = { x: 1, y: 0 };

  // Видимое (сглаженное) состояние
  private visPos: Vec = { x: 0, y: 0 };
  private visAngle = 0;
  private mirror: 1 | -1 = 1;

  private readonly speed: number;
  private turnTimer: number;
  private cornerCooldown = 0;
  private sprint = 0; // время «семенящего» бега после угла

  // Анимация
  private phase = 0; // фаза цикла бега, рад
  private move = 0; // 0..1: насколько паук сейчас бежит (плавно)
  private running = true;
  private stateTimer: number;
  private idleTime = 0;

  // Размер, жизнь и полёт (для выплюнутых паучков)
  private readonly scale: number;
  private readonly lifetime: number;
  private age = 0;
  private flying = false;
  private pos: Vec = { x: 0, y: 0 };
  private vel: Vec = { x: 0, y: 0 };
  private flightTime = 0;
  private trailTimer = 0;
  private squash = 0; // 0..1: сплющивание при посадке (затухает)
  private readonly fx: Particles | null;
  public expired = false;
  private readonly react = new HitReaction(this.container);

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    options: SpiderOptions = {}
  ) {
    this.scale = options.scale ?? 1;
    this.lifetime = options.lifetime ?? Infinity;
    this.fx = options.fx ?? null;
    const crawler = rig.crawler;
    if (!crawler) throw new Error(`[Spider] в риге "${rig.id}" нет блока crawler`);
    const raise = crawler.body_raise;
    this.speed = def.stats.movement_speed;
    this.turnTimer = 3 + Math.random() * 5;
    this.stateTimer = rand(RUN_TIME);

    this.container.addChild(this.bodyContainer);

    // Торс и голова — обычные спрайты, вращаются вокруг своих точек (pivot из рига), приподняты на raise
    for (const p of rig.parts) {
      const sprite: Sprite = sprites.createSprite(p.sprite_id);
      sprite.pivot.set(p.pivot.x, p.pivot.y);
      sprite.position.set(p.pivot.x - rig.anchor.x, p.pivot.y - rig.anchor.y - raise);
      this.bodyContainer.addChild(sprite);
      if (p.role === 'torso') {
        this.torso = sprite;
      }
      if (p.role === 'head') {
        this.head = sprite;
      }
    }

    crawler.legs.forEach((d, i) => {
      const leg = new TwoBoneLeg(
        sprites.createSprite(d.upper_sprite_id), sprites.createSprite(d.lower_sprite_id), d.hip, d.knee, d.foot
      );
      const hip = { x: d.hip.x - rig.anchor.x, y: d.hip.y - rig.anchor.y - raise };
      // нейтральная стопа — там, где она нарисована (по x), на поверхности
      const rest = { x: d.foot.x - rig.anchor.x, y: d.foot.y - rig.anchor.y };
      // диагональные пары в противофазе, внутри пары — небольшой сдвиг (бегущая «волна» вдоль тела)
      this.feet.push({ leg, hip, rest, phase: (d.gait_group ? Math.PI : 0) + i * 0.35 });
      this.bodyContainer.addChild(leg.container);
    });

    this.placeOnSurface(spawn, level.tileSize);
    this.visPos = { ...this.s };
    this.visAngle = this.targetAngle();
    this.mirror = this.targetMirror();
    this.applyTransform();
    this.animate(0, 0);
  }

  /** Ставит паука на поверхность из спавна: пол (по умолчанию), потолок или стена слева/справа. */
  private placeOnSurface(spawn: EnemySpawnDef, ts: number): void {
    const surface = spawn.surface ?? 'floor';
    const dir = Math.random() < 0.5 ? 1 : -1;
    switch (surface) {
      case 'ceiling':
        this.s = { x: (spawn.x + 0.5) * ts, y: spawn.y * ts };
        this.n = { x: 0, y: 1 };
        this.t = { x: dir, y: 0 };
        break;
      case 'wall_right': // стена справа от клетки
        this.s = { x: (spawn.x + 1) * ts, y: (spawn.y + 0.5) * ts };
        this.n = { x: -1, y: 0 };
        this.t = { x: 0, y: dir };
        break;
      case 'wall_left': // стена слева от клетки
        this.s = { x: spawn.x * ts, y: (spawn.y + 0.5) * ts };
        this.n = { x: 1, y: 0 };
        this.t = { x: 0, y: dir };
        break;
      default:
        this.s = { x: (spawn.x + 0.5) * ts, y: (spawn.y + 1) * ts };
        this.n = { x: 0, y: -1 };
        this.t = { x: dir, y: 0 };
    }
  }

  // ---------- Мир ----------

  /** Твёрдая ли точка мира. Мир «замкнут»: за границами уровня тоже твёрдо (пол, потолок, стены). */
  private solid(x: number, y: number): boolean {
    const ts = this.level.tileSize;
    const cx = Math.floor(x / ts);
    const cy = Math.floor(y / ts);
    if (cy < 0 || cy >= this.level.heightTiles) return true;
    return this.level.isSolid(cx, cy);
  }

  /** Луч от точки в направлении dir до ближайшей твёрдой точки (шаг 0.5 px, уточнение бисекцией). null — не нашли. */
  private cast(from: Vec, dir: Vec, maxDist: number): Vec | null {
    if (this.solid(from.x, from.y)) return null; // старт внутри твёрдого
    let prev = 0;
    for (let d = 0.5; d <= maxDist; d += 0.5) {
      if (this.solid(from.x + dir.x * d, from.y + dir.y * d)) {
        let lo = prev;
        let hi = d;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          if (this.solid(from.x + dir.x * mid, from.y + dir.y * mid)) hi = mid; else lo = mid;
        }
        return { x: from.x + dir.x * lo, y: from.y + dir.y * lo };
      }
      prev = d;
    }
    return null;
  }

  // ---------- Преобразования ----------

  private targetAngle(): number {
    // локальный «вверх» (0,-1) должен смотреть вдоль нормали n: угол поворота = atan2(n.x, -n.y)
    return Math.atan2(this.n.x, -this.n.y);
  }

  private targetMirror(): 1 | -1 {
    // рисунок смотрит влево (голова слева), локальный +x = (cos, sin) угла тела; если идём вдоль +x — отражаем
    const a = this.targetAngle();
    return this.t.x * Math.cos(a) + this.t.y * Math.sin(a) > 0 ? -1 : 1;
  }

  private applyTransform(): void {
    this.container.position.set(this.visPos.x, this.visPos.y);
    this.container.rotation = this.visAngle;
    // «вылет из глубины»: быстро вырастает с лёгким перелётом (упругий выход), на посадке — сплющивается и пружинит обратно
    const grow = this.flying ? 0.2 + 0.8 * easeOutBack(Math.min(1, this.flightTime / FLY_GROW)) : 1;
    const sq = this.squash * this.squash;
    this.container.scale.set(this.mirror * this.scale * grow * (1 + 0.3 * sq), this.scale * grow * (1 - 0.4 * sq));
  }

  // ---------- Обновление ----------

  /** В полёте ли паучок и где он (мир) — чтобы матка вовремя перекладывала его на передний слой. */
  public get airborne(): boolean {
    return this.flying;
  }

  public get airTime(): number {
    return this.flightTime;
  }

  public get airPos(): { x: number; y: number } {
    return this.pos;
  }

  /** Выплёвывает паучка: он летит из точки (x, y) со скоростью (vx, vy) и садится на первую же поверхность. */
  public launch(x: number, y: number, vx: number, vy: number): void {
    this.flying = true;
    this.flightTime = 0;
    this.pos = { x, y };
    this.vel = { x: vx, y: vy };
    this.visPos = { x, y };
    this.s = { x, y };
    this.mirror = vx >= 0 ? -1 : 1; // рисунок смотрит влево
    this.visAngle = 0;
    this.applyTransform();
  }

  /** Полёт по дуге; при касании тайла — посадка на поверхность (нормаль — ось грани, повёрнутая к летящему). */
  private fly(dt: number): void {
    this.flightTime += dt;
    this.trailTimer -= dt;
    if (this.fx && this.trailTimer <= 0) {
      // след из капелек «сока»
      this.trailTimer = 0.03;
      this.fx.emit(
        this.pos.x + (Math.random() - 0.5) * 3, this.pos.y + 4 + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 18, 8 + Math.random() * 14,
        Math.random() < 0.6 ? 0x56f436 : 0x9667f2, 0.3 + Math.random() * 0.25, 1 + Math.random() * 1.5, { gy: 160, grow: 0.3 }
      );
    }
    this.vel.y += GRAVITY * dt;
    const total = Math.hypot(this.vel.x, this.vel.y) * dt;
    const steps = Math.max(1, Math.ceil(total / FLY_STEP));
    const dx = (this.vel.x * dt) / steps;
    const dy = (this.vel.y * dt) / steps;
    for (let i = 0; i < steps; i++) {
      const nx = this.pos.x + dx;
      const ny = this.pos.y + dy;
      if (this.solid(nx, ny)) {
        this.land(this.pos, { x: dx, y: dy });
        return;
      }
      this.pos = { x: nx, y: ny };
    }
    // в полёте паучок кувыркается слегка по ходу и держит лапки в нарисованной позе
    this.visPos = { x: this.pos.x, y: this.pos.y + 8 * this.scale }; // тело паучка — над точкой «ног»
    this.visAngle = Math.max(-0.5, Math.min(0.5, this.vel.x * 0.004)) + Math.sin(this.flightTime * 14) * 0.12;
    this.mirror = this.vel.x >= 0 ? -1 : 1;
    this.applyTransform();
    this.animate(dt, 0);
  }

  private land(from: Vec, step: Vec): void {
    const len = Math.hypot(step.x, step.y) || 1;
    const dir = { x: step.x / len, y: step.y / len };
    const hit = this.cast(from, dir, len + 2) ?? from;
    // нормаль: ось, вдоль которой от точки удара есть свободное место, а за ней — твёрдое; берём ту, что смотрит против полёта
    let best: Vec | null = null;
    let bestScore = -Infinity;
    for (const a of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const out = { x: hit.x + a.x * 1.5, y: hit.y + a.y * 1.5 };
      const inn = { x: hit.x - a.x * 1.5, y: hit.y - a.y * 1.5 };
      if (this.solid(out.x, out.y) || !this.solid(inn.x, inn.y)) continue;
      const score = -(a.x * dir.x + a.y * dir.y);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    this.n = best ?? { x: 0, y: -1 };
    const side = this.vel.x >= 0 ? 1 : -1;
    this.t = Math.abs(this.n.x) > 0.5 ? { x: 0, y: side } : { x: side, y: 0 };
    this.s = { x: hit.x, y: hit.y };
    this.flying = false;
    this.cornerCooldown = 0.12;
    this.squash = 1;
    this.snapToSurface();
    this.fx?.burst(hit.x, hit.y, {
      count: 9, colors: [0xb9ff97, 0x56f436, 0xc095fc], speed: [25, 85], angle: Math.atan2(this.n.y, this.n.x), spread: 1.1,
      life: [0.2, 0.45], size: [1, 2], gravity: 220, drag: 2
    });
    this.visPos = { ...this.s };
    this.visAngle = this.targetAngle();
    this.mirror = this.targetMirror();
    this.applyTransform();
  }

  /** Два круга попадания вдоль тела: тело лежит на поверхности и вытянуто по направлению движения. */
  public hitCircles(): HitCircle[] {
    const k = this.scale;
    const c = this.flying
      ? { x: this.pos.x, y: this.pos.y + 4 * k }
      : { x: this.visPos.x + this.n.x * HIT_LIFT * k, y: this.visPos.y + this.n.y * HIT_LIFT * k };
    if (this.flying) return [{ ...c, r: HIT_RADIUS * k }];
    const sp = HIT_SPREAD * k;
    return [
      { x: c.x + this.t.x * sp, y: c.y + this.t.y * sp, r: HIT_RADIUS * k },
      { x: c.x - this.t.x * sp, y: c.y - this.t.y * sp, r: HIT_RADIUS * k }
    ];
  }

  /** Удар: белая вспышка и сплющивание (как при посадке). */
  public onHit(): void {
    this.react.trigger(0, 0);
    this.squash = 1;
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.react.update(dt);
    this.age += dt;
    if (this.age >= this.lifetime) {
      this.expired = true;
    } else if (this.lifetime - this.age < FADE_TIME) {
      this.container.alpha = (this.lifetime - this.age) / FADE_TIME;
    }
    if (this.flying) {
      this.fly(dt);
      return;
    }
    this.cornerCooldown -= dt;
    this.sprint -= dt;
    this.squash = Math.max(0, this.squash - dt / 0.35);

    // Поведение: бежит рывками, замирает; иногда разворачивается
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.running = !this.running;
      this.stateTimer = this.running ? rand(RUN_TIME) : rand(PAUSE_TIME);
    }
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      this.t = { x: -this.t.x, y: -this.t.y };
      this.turnTimer = 4 + Math.random() * 6;
    }
    // плавный разгон и торможение
    const moveTarget = this.running ? 1 : 0;
    this.move += (moveTarget - this.move) * (1 - Math.exp(-(this.running ? 9 : 14) * dt));
    const speedNow = this.speed * this.move;

    this.crawl(dt, speedNow);

    // Видимое состояние догоняет истинное: переходы на углах получаются скруглёнными
    const kp = 1 - Math.exp(-FOLLOW_POS * dt);
    this.visPos.x += (this.s.x - this.visPos.x) * kp;
    this.visPos.y += (this.s.y - this.visPos.y) * kp;
    this.visAngle += wrapAngle(this.targetAngle() - this.visAngle) * (1 - Math.exp(-FOLLOW_ANGLE * dt));
    this.mirror = this.targetMirror();
    this.applyTransform();

    this.animate(dt, speedNow);
  }

  /** Движение тела вдоль поверхности, огибание внутренних и внешних углов. */
  private crawl(dt: number, speedNow: number): void {
    const step = speedNow * dt;
    this.s = { x: this.s.x + this.t.x * step, y: this.s.y + this.t.y * step };

    if (this.cornerCooldown > 0) {
      this.snapToSurface();
      return;
    }

    // Внутренний угол: впереди стена — поворачиваем «на стену»
    const front0 = BODY_FRONT * this.scale;
    const probeH = Math.max(2, WALL_PROBE_HEIGHT * this.scale);
    const base = { x: this.s.x + this.n.x * probeH, y: this.s.y + this.n.y * probeH };
    const front = { x: base.x + this.t.x * front0, y: base.y + this.t.y * front0 };
    if (this.solid(front.x, front.y)) {
      const wall = this.cast(base, this.t, front0 + 2);
      const d = wall ? Math.hypot(wall.x - base.x, wall.y - base.y) : front0;
      // новая точка контакта — в углу, где поверхность упирается в стену
      this.s = { x: this.s.x + this.t.x * d, y: this.s.y + this.t.y * d };
      const oldN = this.n;
      this.n = { x: -this.t.x, y: -this.t.y };
      this.t = { x: oldN.x, y: oldN.y };
      this.cornerCooldown = 0.12;
      this.sprint = 0.25;
      this.snapToSurface();
      return;
    }

    // Внешний угол: центр потерял опору — оборачиваемся вокруг ребра
    const underCentre = { x: this.s.x - this.n.x * EDGE_PROBE, y: this.s.y - this.n.y * EDGE_PROBE };
    if (!this.solid(underCentre.x, underCentre.y)) {
      // откатываемся назад по поверхности до последней опоры — это и есть ребро
      let e = { x: this.s.x, y: this.s.y };
      for (let i = 0; i < 40; i++) {
        const probe = { x: e.x - this.n.x * EDGE_PROBE, y: e.y - this.n.y * EDGE_PROBE };
        if (this.solid(probe.x, probe.y)) break;
        e = { x: e.x - this.t.x * 0.5, y: e.y - this.t.y * 0.5 };
      }
      const oldN = this.n;
      const oldT = this.t;
      // новая поверхность — грань за ребром: нормаль смотрит туда, куда мы ползли, движение — «вниз» вдоль грани
      this.n = { x: oldT.x, y: oldT.y };
      this.t = { x: -oldN.x, y: -oldN.y };
      this.s = { x: e.x - oldN.x * EDGE_WRAP_DEPTH, y: e.y - oldN.y * EDGE_WRAP_DEPTH };
      this.cornerCooldown = 0.12;
      this.sprint = 0.25;
    }
    this.snapToSurface();
  }

  /** Прижимает точку контакта к поверхности (бегущий по тайлам паук всегда касается её). */
  private snapToSurface(): void {
    const up = 3;
    const start = { x: this.s.x + this.n.x * up, y: this.s.y + this.n.y * up };
    const hit = this.cast(start, { x: -this.n.x, y: -this.n.y }, up + 4);
    if (hit) this.s = hit;
  }

  // ---------- Анимация ----------

  /** Процедурная анимация бега и «осматривания» (тело, голова, ноги). */
  private animate(dt: number, speedNow: number): void {
    // Фаза цикла идёт по пройденному пути: стопа в опоре едет назад ровно со скоростью тела (нет «скольжения»)
    const stride = 4 * STRIDE_HALF; // путь тела за полный цикл (опора + мах)
    const boost = this.sprint > 0 ? SPRINT_BOOST : 1;
    this.phase += ((Math.PI * 2 * (speedNow / this.scale) * dt) / stride) * boost;
    this.idleTime += dt;
    const m = this.move; // амплитуда шагов: на остановке ноги сходятся в нарисованную позу

    // Покачивание тела: два толчка за цикл + дыхание
    const bob = BODY_BOB * m * Math.sin(this.phase * 2) + 0.2 * Math.sin(this.idleTime * 2.4) * (1 - m);
    this.bodyContainer.position.set(0, -bob);

    if (this.torso) this.torso.rotation = TORSO_ROCK * m * Math.sin(this.phase);
    if (this.head) {
      // на бегу кивает; на остановке осматривается из стороны в сторону
      const look = 0.13 * Math.sin(this.idleTime * 1.7) * Math.sin(this.idleTime * 0.6) * (1 - m);
      this.head.rotation = HEAD_NOD * m * Math.sin(this.phase * 2 + 0.9) + look;
    }

    for (const [i, foot] of this.feet.entries()) {
      const u = (((this.phase + foot.phase) / (Math.PI * 2)) % 1 + 1) % 1;
      let fwd: number; // смещение стопы вперёд (по ходу), px
      let lift = 0;
      if (u < 0.5) {
        fwd = STRIDE_HALF * (1 - 4 * u); // опора: стопа едет назад относительно тела
      } else {
        const t = (u - 0.5) * 2;
        const k = t * t * (3 - 2 * t);
        fwd = STRIDE_HALF * (-1 + 2 * k); // мах: возвращается вперёд
        lift = FOOT_LIFT * Math.sin(Math.PI * t);
      }
      // на остановке — лёгкое подёргивание ног
      const twitch = Math.sin(this.idleTime * 5.3 + i * 1.9) * 0.35 * (1 - m);
      // рисунок смотрит влево: «вперёд» — это −x тела
      const footX = foot.rest.x - (fwd * m + twitch);
      const footY = foot.rest.y + bob - lift * m; // стопа на поверхности (тело качается, стопа — нет)
      foot.leg.update(foot.hip, { x: footX, y: footY });
    }
  }
}
