import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef, SegmentDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';
import { SegmentChain } from './SegmentChain.ts';
import type { PartKind, Vec } from './SegmentChain.ts';
import { applySolidMask } from './solidMask.ts';
import type { Leash } from '../world/Rooms.ts';

// ---- Ползание по поверхностям (как у паука, но тело толстое: центр головы идёт на радиусе от поверхности)
const WALL_PROBE_HEIGHT = 4; // px над поверхностью, на которой проверяем стену впереди
const EDGE_PROBE = 1.5; // px под поверхностью — проверка опоры под головой (внешний угол)
const EDGE_WRAP_DEPTH = 1; // px: на сколько голова «сползает» по грани за край
const FOLLOW_POS = 12; // 1/с: сглаживание видимой позиции головы (скругляет углы и стыки с туннелем)

// ---- Походка: волна сжатия бежит от хвоста к голове
const INCH_RATE = 1.1; // циклов в секунду
const INCH_SPEED = 0.7; // амплитуда колебания скорости (0 — ровно)

// ---- Поведение
const CRAWL_TIME: [number, number] = [5, 11]; // сколько ползёт по поверхности перед тем, как зарыться
const MIN_GAP = 30; // px: ближе этого центры сегментов разных частей (и чужих червей) не сходятся
const STUCK_TIME = 0.5; // с: столько голова упирается в тело, прежде чем червь зароется, чтобы уйти
const DIG_SPEED = 2.2; // множитель скорости под землёй
const TUNNEL_MIN = 2; // длина подземного хода в клетках (от входа до выхода)
const TUNNEL_MAX = 14;
const TUNNEL_WAIT = 1.5; // с: у выхода кто-то ползает — ждём не дольше (иначе два червя ждут друг друга вечно)
const DIVE_TIME = 2; // с: столько ныряем без найденного хода — потом обратно в воздух
const HIDDEN_MAX = 10; // с: дольше этого голова не должна торчать в блоках (червь недосягаем для удара)
const IDLE_MAX = 4; // с: столько стоять без движения нельзя — выбираемся из застревания

// ---- Укус: заметил героя — ползёт к нему, у цели замирает, отводит голову назад и рывком бросается вперёд
const SIGHT = 190; // px: на таком расстоянии червь замечает героя и ползёт к нему
const CHASE_BOOST = 1.7; // во сколько раз быстрее ползёт за героем
const CHASE_TURN_CD = 0.9; // с: не чаще раза за это время разворачивается к герою
const CHASE_BEHIND = 18; // px: герой должен остаться позади на столько, чтобы червь развернулся
const BITE_RANGE = 54; // px: с такого расстояния (до тела героя) червь начинает кусать
const BITE_WINDUP = 0.42; // с: отвод головы назад
const BITE_RECOIL = 7; // px: на сколько голова отводится назад
const BITE_DASH = 0.26; // с: рывок вперёд
const BITE_SPEED = 6.5; // во сколько раз быстрее обычной скорости рывок
const BITE_REACH = 10; // px: запас к радиусу головы при проверке укуса
const BITE_REST = 0.55; // с: после рывка червь «выдыхается»

// ---- Полёт: червь вылетает из-под земли и летает по воздуху плавными дугами (поворот ограничен), потом ныряет обратно в землю
const FLY_TURN = 3.0; // рад/с: как круто голова поворачивает
const FLY_BOOST = 3.4; // во сколько раз быстрее ползания летит
const FLY_PASS_BOOST = 1.25; // добавка скорости на пролёте сквозь героя
const FLY_ACCEL = 3; // 1/с: как быстро скорость догоняет желаемую
const FLY_PASSES = 2; // сколько пролётов у героя за один вылет
const FLY_PASS_DIST = 44; // px: ближе этого к цели голова перестаёт доворачивать и проносится мимо
const FLY_PASS_TIME: [number, number] = [0.6, 0.95]; // с: сколько длится пролёт
const FLY_TIME_HERO = 5; // с: вылет за героем длится не дольше
const FLY_TIME_IDLE: [number, number] = [2, 3.4]; // с: вылет «для разминки»
const FLY_SIGHT: [number, number] = [90, 300]; // px: на таком расстоянии от героя червь решается лететь на него
const FLY_COOLDOWN: [number, number] = [5, 9]; // с: пауза между вылетами
const FLY_HIT_CD = 1.1; // с: пауза между попаданиями в полёте
const SMOOTH_MOVE = 9; // 1/с: плавность разгона и торможения ползания
const AXES: Vec[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

/**
 * Червь-землерой. Длина 3–5 сегментов: голова, 1–3 туловища, хвост. Голова ползёт по любой поверхности тайлов (пол, стены, потолок,
 * внутренние и внешние углы — модель контакта та же, что у паука), остальные сегменты едут по её следу. Время от времени червь
 * зарывается в блок: голова уходит в твёрдые клетки, прокладывает ход через соседние твёрдые клетки (поиск в ширину) и выныривает
 * из другой поверхности. Часть тела внутри твёрдых клеток скрыта инвертированной маской (тела не просвечивают сквозь углы тайлов);
 * контейнер рисуется под тайлами.
 */
export class Worm implements PartDamageable {
  public readonly container = new Container();

  private readonly chain: SegmentChain;
  private readonly radius: number; // половина толщины
  private readonly speed: number;

  private state: 'crawl' | 'tunnel' | 'fly' = 'crawl';

  // Ползание: точка контакта S, нормаль n (от поверхности), направление t; центр головы P = S + n * radius
  private s: Vec = { x: 0, y: 0 };
  private n: Vec = { x: 0, y: -1 };
  private t: Vec = { x: 1, y: 0 };
  private p: Vec = { x: 0, y: 0 };
  private cornerCooldown = 0;

  // Подземный ход: ломаная из центров клеток и направление выхода
  private waypoints: Vec[] = [];
  private exitDir: Vec = { x: 0, y: -1 };

  private vis: Vec = { x: 0, y: 0 }; // видимая (сглаженная) позиция головы

  private phase = Math.random() * Math.PI * 2;
  private stuck = 0; // сколько секунд голова упирается в чужое/своё тело
  private burrowTimer = rand(CRAWL_TIME);
  /** Комната-«дом»: ползает и выныривает только в её клетках (null — без привязки). */
  public leash: Leash | null = null;

  // Укус
  /** Тело героя (прямоугольник мира): червь его чует и кусает. */
  public hero: (() => { left: number; right: number; top: number; bottom: number } | null) | null = null;
  /** Укус достал героя: (x, y, сторона отбрасывания, урон). Возвращает true, если урон засчитан. */
  public onBite: ((x: number, y: number, dirX: number, damage: number) => boolean) | null = null;
  private readonly biteDamage: number;
  private readonly biteCooldown: number;
  private biteState: 'none' | 'windup' | 'dash' | 'rest' = 'none';
  private biteT = 0;
  private biteCd = rand([0.5, 1.6]);
  private biteDone = false;
  private chaseCd = 0;
  private chasing = false;
  private recoil = 0; // 0..1: насколько голова отведена назад (только вид)
  private mul = 1; // сглаженный множитель скорости ползания (рывок, замирание, погоня — без щелчков)

  // Полёт
  private heading = 0;
  private flySpeed = 0;
  private flyT = 0;
  private flyLimit = 0;
  private flyMode: 'seek' | 'pass' = 'seek';
  private flyPassT = 0;
  private flyPasses = 0;
  private flyHitCd = 0;
  private flyCd = rand(FLY_COOLDOWN);
  private flyDiving = false;

  // ---- Сторож: червь не должен уползти из уровня или застрять в блоках навсегда (иначе волна не зачищается)
  private hiddenT = 0; // с: голова подряд сидит в твёрдых клетках
  private idleT = 0; // с: голова не сдвинулась с места
  private idleRef: Vec = { x: 0, y: 0 };
  private diveT = 0; // с: ныряем в землю без найденного хода
  private planCd = 0; // с: пауза между попытками проложить ход
  private waitT = 0; // с: ждём у выхода из туннеля

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly flock: Worm[] = [] // все черви уровня (включая этого): чтобы не пересекаться
  ) {
    const seg = rig.segmented;
    if (!seg) throw new Error(`[Worm] в риге "${rig.id}" нет блока segmented`);
    this.radius = seg.thickness / 2;
    this.speed = def.stats.movement_speed;
    this.biteDamage = def.attack.damage;
    this.biteCooldown = def.attack.cooldown_seconds;

    // Длина: голова + туловища + хвост, всего 3–5 (или как задано в спавне)
    const total = Math.max(seg.length_min, Math.min(seg.length_max, spawn.length ?? Math.round(rand([seg.length_min, seg.length_max]))));
    const bodies = total - 2;
    // здоровье частей: голова — своё (её гибель — гибель червя), у остальных — из рига (или как у головы)
    const hp = seg.health ?? { body: def.stats.max_health, tail: def.stats.max_health };
    const part = (d: SegmentDef, kind: PartKind, health: number) => {
      const sprite = sprites.createSprite(d.sprite_id);
      sprite.pivot.set(d.center.x, d.center.y);
      return { kind, node: sprite as Container, radius: this.radius, hp: health, scale: 1 };
    };
    const parts = [part(seg.head, 'head', hp.head ?? def.stats.max_health)];
    for (let i = 0; i < bodies; i++) parts.push(part(seg.body, 'body', hp.body));
    parts.push(part(seg.tail, 'tail', hp.tail));
    const gap = (prev: PartKind, kind: PartKind) =>
      kind === 'tail' ? (prev === 'head' ? seg.head_to_body : seg.body_to_tail) : prev === 'head' ? seg.head_to_body : seg.body_to_body;
    this.chain = new SegmentChain(this.container, parts, gap);

    applySolidMask(this.container, level);
    this.placeOnSurface(spawn, level.tileSize);
    this.p = { x: this.s.x + this.n.x * this.radius, y: this.s.y + this.n.y * this.radius };
    this.vis = { ...this.p };
    this.idleRef = { ...this.p };
    this.chain.reset(this.p, this.t); // след изначально — прямая за головой
  }

  /** Ставит червя на поверхность из спавна: пол (по умолчанию), потолок или стена слева/справа. */
  private placeOnSurface(spawn: EnemySpawnDef, ts: number): void {
    const surface = spawn.surface ?? 'floor';
    const dir = Math.random() < 0.5 ? 1 : -1;
    switch (surface) {
      case 'ceiling':
        this.s = { x: (spawn.x + 0.5) * ts, y: spawn.y * ts };
        this.n = { x: 0, y: 1 };
        this.t = { x: dir, y: 0 };
        break;
      case 'wall_right':
        this.s = { x: (spawn.x + 1) * ts, y: (spawn.y + 0.5) * ts };
        this.n = { x: -1, y: 0 };
        this.t = { x: 0, y: dir };
        break;
      case 'wall_left':
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

  /** Твёрдая ли точка мира. Мир «замкнут»: за границами уровня тоже твёрдо. */
  private solid(x: number, y: number): boolean {
    const ts = this.level.tileSize;
    const cy = Math.floor(y / ts);
    if (cy < 0 || cy >= this.level.heightTiles) return true;
    return this.level.isSolid(Math.floor(x / ts), cy);
  }

  /** Луч от точки в направлении dir до ближайшей твёрдой точки (шаг 0.5 px, уточнение бисекцией). */
  private cast(from: Vec, dir: Vec, maxDist: number): Vec | null {
    if (this.solid(from.x, from.y)) return null;
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

  /** Твёрдая ли клетка для подземного хода: тайлы уровня плюс «невидимая» рамка в одну клетку вокруг мира (мир замкнут). */
  private cellSolid(cx: number, cy: number): boolean {
    const W = this.level.widthTiles;
    const H = this.level.heightTiles;
    if (cx < -1 || cy < -1 || cx > W || cy > H) return false;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return true;
    return this.level.isSolid(cx, cy);
  }

  private cellFree(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.level.widthTiles && cy < this.level.heightTiles && !this.level.isSolid(cx, cy);
  }

  // ---------- Обновление ----------

  /** Круг на каждую часть тела; те, что сейчас внутри твёрдых клеток (червь в земле), не бьются. */
  public hitCircles(): HitCircle[] {
    const ts = this.level.tileSize;
    return this.chain.circles((x, y) => this.level.isSolid(Math.floor(x / ts), Math.floor(y / ts)));
  }

  /** Удар: белая вспышка той части, в которую попали. */
  public onHit(dirX: number, dirY: number, part?: number): void {
    if (part !== undefined) this.chain.flash(part, dirX, dirY);
  }

  /** Урон части. Выбитая часть исчезает, остальные смыкаются; выбита голова — червь погиб целиком. */
  public damagePart(part: number, amount: number): PartDamageResult {
    const seg = this.chain.find(part);
    const result = this.chain.damage(part, amount);
    if (result !== 'killed') return 'hit';
    if (seg?.kind === 'head') return 'dead';
    this.chain.remove(part);
    return 'killed';
  }

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.phase += Math.PI * 2 * INCH_RATE * dt;

    if (this.state === 'crawl') this.updateCrawl(dt);
    else if (this.state === 'fly') this.updateFly(dt);
    else this.updateTunnel(dt);

    // Голова не покидает уровень: иначе червь уходит в пустоту, его не достать и волна не заканчивается
    const W = this.level.pixelWidth;
    const H = this.level.pixelHeight;
    this.p.x = Math.max(1, Math.min(W - 1, this.p.x));
    this.p.y = Math.max(1, Math.min(H - 1, this.p.y));

    this.updateWatchdog(dt);

    // Видимая голова догоняет истинную: углы и стыки с туннелем скругляются; перед укусом голова отводится назад
    const kp = 1 - Math.exp(-FOLLOW_POS * dt);
    this.vis.x += (this.p.x - this.vis.x) * kp;
    this.vis.y += (this.p.y - this.vis.y) * kp;
    const back = this.recoil * BITE_RECOIL;
    this.chain.update(dt, { x: this.vis.x - this.t.x * back, y: this.vis.y - this.t.y * back }, this.phase);
  }

  /**
   * Сторож: голова не должна подолгу сидеть в блоках (червя нельзя ударить) или стоять на месте
   * (упёрся в угол/тело и зациклился). Выбираемся — иначе волна не добивается и уровень не заканчивается.
   */
  private updateWatchdog(dt: number): void {
    const ts = this.level.tileSize;
    const hidden = this.cellSolid(Math.floor(this.p.x / ts), Math.floor(this.p.y / ts));
    this.hiddenT = hidden ? this.hiddenT + dt : 0;
    if (this.hiddenT > HIDDEN_MAX) {
      this.hiddenT = 0;
      this.unstick();
      return;
    }

    // В укусе и погоне червь может стоять на месте законно — это не застревание
    if (this.biteState !== 'none' || (this.state === 'crawl' && this.chasing)) {
      this.idleT = 0;
      this.idleRef = { x: this.p.x, y: this.p.y };
      return;
    }
    if (Math.hypot(this.p.x - this.idleRef.x, this.p.y - this.idleRef.y) > 10) {
      this.idleRef = { x: this.p.x, y: this.p.y };
      this.idleT = 0;
    } else {
      this.idleT += dt;
    }
    if (this.idleT > IDLE_MAX) this.unstick();
  }

  /** Принудительно выбирается из застревания: пробует зарыться, а если не вышло — вылетает к дому. */
  private unstick(): void {
    this.idleT = 0;
    this.idleRef = { x: this.p.x, y: this.p.y };
    if (this.state === 'crawl' && this.tryBurrow(0, true)) return;
    this.takeOff();
  }

  /** Взлёт из любого состояния: разворачивается к центру комнаты/арены и летит туда, выходя из блоков на свет. */
  private takeOff(): void {
    const home = this.leash ? this.leash.center : { x: this.level.pixelWidth / 2, y: this.level.pixelHeight / 2 };
    const dx = home.x - this.p.x;
    const dy = home.y - this.p.y;
    this.heading = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : -Math.PI / 2;
    this.flySpeed = this.speed * FLY_BOOST;
    this.flyT = 0;
    this.flyLimit = 2;
    this.flyMode = 'seek';
    this.flyPasses = 0;
    this.flyHitCd = 0.4;
    this.flyDiving = false;
    this.diveT = 0;
    this.planCd = 0;
    this.biteState = 'none';
    this.stuck = 0;
    this.hiddenT = 0;
    this.flyCd = rand(FLY_COOLDOWN);
    this.state = 'fly';
  }

  /** Нырок не нашёл хода — выныриваем обратно к дому, а не уходим глубже в пустоту. */
  private abortDive(): void {
    this.flyDiving = false;
    this.diveT = 0;
    this.flyT = 0;
    this.flyLimit = 1.6;
    this.flyPasses = 0;
    this.flyMode = 'seek';
  }

  private updateCrawl(dt: number): void {
    this.cornerCooldown -= dt;
    this.burrowTimer -= dt;
    this.flyCd -= dt;

    // Ползёт «гусеницей»: скорость пульсирует, в среднем равна movement_speed; заметив героя — быстрее и к нему
    this.stepBite(dt);
    const mulTarget = this.biteState === 'windup' || this.biteState === 'rest' ? 0 : this.biteState === 'dash' ? BITE_SPEED : this.chasing ? CHASE_BOOST : 1;
    this.mul += (mulTarget - this.mul) * (1 - Math.exp(-(this.biteState === 'dash' ? 30 : SMOOTH_MOVE) * dt));
    let step = this.speed * (this.biteState === 'dash' ? 1 : 1 + INCH_SPEED * Math.sin(this.phase)) * this.mul * dt;

    // Голова не лезет в тело (своё или чужого червя): стоит, а если не отпускает — зарывается и уходит
    const ahead = { x: this.p.x + this.t.x * (step + 3), y: this.p.y + this.t.y * (step + 3) };
    const blocker = this.nearestBody(ahead);
    let yielding = false; // упёрлись в червя, у которого приоритет: ждём, а не зарываемся одновременно с ним
    if (blocker.gap < MIN_GAP && blocker.gap < this.gapTo(this.p)) {
      step = 0;
      this.stuck += dt;
      yielding = blocker.owner !== null && blocker.owner !== this && this.flock.indexOf(blocker.owner) < this.flock.indexOf(this);
    } else {
      this.stuck = 0;
    }

    this.crawl(step);
    this.p = { x: this.s.x + this.n.x * this.radius, y: this.s.y + this.n.y * this.radius };

    if (this.biteState !== 'none') {
      this.stuck = 0; // в укусе червь не зарывается
    } else if (this.stuck > STUCK_TIME && !yielding) {
      this.tryBurrow(0, true);
      if (this.state === 'crawl') this.stuck = 0; // не вышло — подождём ещё
    } else if (this.flyCd <= 0 && this.tryFly()) {
      return;
    } else if (this.burrowTimer <= 0 && !this.chasing) {
      if (Math.random() < 0.4 && this.tryFly(true)) return; // иногда вместо зарывания — вылет в воздух
      this.tryBurrow(step, false);
    }
  }

  /** Герой (прямоугольник мира), если червь его видит: в одной комнате. */
  private heroBox(): { left: number; right: number; top: number; bottom: number } | null {
    return this.leash && !this.leash.hero() ? null : this.hero?.() ?? null;
  }

  /** Вылет из-под поверхности: голова уходит от неё по нормали с доворотом к герою и летит по воздуху. idle — без цели (разминка). */
  private tryFly(idle = false): boolean {
    this.flyCd = rand(FLY_COOLDOWN);
    const box = this.heroBox();
    let dx = this.n.x * 0.9;
    let dy = this.n.y * 0.9;
    if (box && !idle) {
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const gap = Math.hypot(this.p.x - cx, this.p.y - cy);
      if (gap < FLY_SIGHT[0] || gap > FLY_SIGHT[1]) return false;
      dx += ((cx - this.p.x) / gap) * 0.7;
      dy += ((cy - this.p.y) / gap) * 0.7;
      this.flyLimit = FLY_TIME_HERO;
    } else {
      if (!idle) return false;
      dx += (Math.random() - 0.5) * 1.2;
      this.flyLimit = rand(FLY_TIME_IDLE);
    }
    this.heading = Math.atan2(dy, dx);
    this.flySpeed = this.speed * Math.max(1, this.mul);
    this.flyT = 0;
    this.flyMode = 'seek';
    this.flyPasses = 0;
    this.flyHitCd = 0.3;
    this.flyDiving = false;
    this.biteState = 'none';
    this.state = 'fly';
    return true;
  }

  /**
   * Полёт: голова доворачивает к герою с ограниченной скоростью поворота (плавные дуги, не по тайлам), проносится сквозь него и снова заходит;
   * после FLY_PASSES пролётов или по таймеру ныряет вниз — войдя в твёрдую клетку, прокладывает ход и выныривает. Тело внутри блоков скрыто маской.
   */
  private updateFly(dt: number): void {
    this.flyT += dt;
    this.flyHitCd -= dt;
    this.planCd -= dt;
    const ts = this.level.tileSize;
    const box = this.heroBox();
    const hx = box ? (box.left + box.right) / 2 : this.p.x + Math.cos(this.heading) * 100;
    const hy = box ? (box.top + box.bottom) / 2 : this.p.y + Math.sin(this.heading) * 100;
    if (!this.flyDiving && (this.flyT > this.flyLimit || this.flyPasses > FLY_PASSES)) {
      this.flyDiving = true;
      this.diveT = 0;
    }
    // нырок затянулся, а хода всё нет — обратно в воздух (иначе червь уходит в пустоту под уровнем)
    if (this.flyDiving) {
      this.diveT += dt;
      if (this.diveT > DIVE_TIME) this.abortDive();
    }

    let tx = hx;
    let ty = hy;
    let steer = true;
    if (this.flyDiving) {
      tx = this.p.x;
      ty = this.p.y + 200; // вниз, в землю
    } else if (this.flyMode === 'pass') {
      this.flyPassT -= dt;
      steer = false; // проносится мимо без доворота
      if (this.flyPassT <= 0) this.flyMode = 'seek';
    } else if (box && Math.hypot(hx - this.p.x, hy - this.p.y) < FLY_PASS_DIST) {
      this.flyMode = 'pass';
      this.flyPassT = rand(FLY_PASS_TIME);
      this.flyPasses++;
    } else if (!box) {
      // без цели: лёгкое виляние по курсу
      tx = this.p.x + Math.cos(this.heading + Math.sin(this.flyT * 1.7) * 0.8) * 100;
      ty = this.p.y + Math.sin(this.heading + Math.sin(this.flyT * 1.7) * 0.8) * 100;
    }
    // края арены и чужая комната: разворачиваемся к центру комнаты, а не улетаем из уровня
    const W = this.level.pixelWidth;
    const H = this.level.pixelHeight;
    const home = this.leash ? this.leash.center : { x: W / 2, y: H / 2 };
    const outsideRoom = !!this.leash && !this.leash.contains(this.p.x, this.p.y);
    if (this.p.x < 40 || this.p.x > W - 40 || this.p.y < 24 || outsideRoom) {
      tx = home.x;
      ty = home.y;
      steer = true;
      if (outsideRoom) this.abortDive();
    }
    if (steer) {
      const want = Math.atan2(ty - this.p.y, tx - this.p.x);
      const d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      const lim = FLY_TURN * dt * (this.flyDiving ? 1.4 : 1);
      this.heading += Math.max(-lim, Math.min(lim, d));
    }
    const boost = FLY_BOOST * (this.flyMode === 'pass' ? FLY_PASS_BOOST : 1) * (this.flyDiving ? 0.8 : 1);
    this.flySpeed += (this.speed * boost - this.flySpeed) * (1 - Math.exp(-FLY_ACCEL * dt));
    this.p = { x: this.p.x + Math.cos(this.heading) * this.flySpeed * dt, y: this.p.y + Math.sin(this.heading) * this.flySpeed * dt };
    this.t = { x: Math.cos(this.heading), y: Math.sin(this.heading) };

    // укус на лету: голова задела героя
    if (box && this.flyHitCd <= 0 && this.onBite) {
      const gap = Math.hypot(this.p.x - Math.max(box.left, Math.min(this.p.x, box.right)), this.p.y - Math.max(box.top, Math.min(this.p.y, box.bottom)));
      if (gap < this.radius + BITE_REACH) {
        this.flyHitCd = FLY_HIT_CD;
        this.onBite(this.p.x, this.p.y, (box.left + box.right) / 2 >= this.p.x ? 1 : -1, this.biteDamage);
      }
    }

    // нырнул в землю: ход под землёй и выход (пробуем не каждый кадр, а с паузой — поиск хода не бесплатный)
    if (this.flyDiving && this.planCd <= 0 && this.cellSolid(Math.floor(this.p.x / ts), Math.floor(this.p.y / ts))) {
      this.planCd = 0.3;
      const plan = this.planTunnel(Math.floor(this.p.x / ts), Math.floor(this.p.y / ts));
      if (plan) {
        this.waypoints = plan.points;
        this.exitDir = plan.dir;
        this.waitT = 0;
        this.state = 'tunnel';
        this.flyCd = rand(FLY_COOLDOWN);
      }
    }
  }

  /** Укус: ползёт к герою, у цели замирает, отводит голову и бросается вперёд по поверхности; задел — урон, потом передышка. */
  private stepBite(dt: number): void {
    this.biteCd -= dt;
    this.chaseCd -= dt;
    const box = this.leash && !this.leash.hero() ? null : this.hero?.() ?? null;
    // расстояние от головы до тела героя
    const gap = box ? Math.hypot(this.p.x - Math.max(box.left, Math.min(this.p.x, box.right)), this.p.y - Math.max(box.top, Math.min(this.p.y, box.bottom))) : Infinity;
    this.chasing = !!box && gap < SIGHT && this.biteState === 'none';
    switch (this.biteState) {
      case 'none': {
        this.recoil = Math.max(0, this.recoil - dt * 6);
        if (!box || !this.chasing) break;
        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const along = (cx - this.p.x) * this.t.x + (cy - this.p.y) * this.t.y;
        if (this.chaseCd <= 0 && along < -CHASE_BEHIND) {
          this.t = { x: -this.t.x, y: -this.t.y };
          this.chaseCd = CHASE_TURN_CD;
        }
        // герой в пределах укуса и впереди (рывок идёт вдоль поверхности): отводим голову
        if (gap < BITE_RANGE && along > -4 && this.biteCd <= 0) {
          this.biteState = 'windup';
          this.biteT = 0;
          this.biteDone = false;
        }
        break;
      }
      case 'windup':
        this.biteT += dt;
        { const k = Math.min(1, this.biteT / BITE_WINDUP); this.recoil = k * k * (3 - 2 * k); } // плавный отвод головы назад
        if (this.biteT >= BITE_WINDUP) {
          this.biteState = 'dash';
          this.biteT = 0;
        }
        break;
      case 'dash':
        this.biteT += dt;
        this.recoil = Math.max(0, this.recoil - dt * 14); // голова выстреливает вперёд из отвода
        if (!this.biteDone && box && this.onBite && gap < this.radius + BITE_REACH) {
          this.biteDone = true;
          const dirX = (box.left + box.right) / 2 >= this.p.x ? 1 : -1;
          this.onBite(this.p.x, this.p.y, dirX, this.biteDamage);
        }
        if (this.biteT >= BITE_DASH) {
          this.biteState = 'rest';
          this.biteT = 0;
        }
        break;
      default:
        this.biteT += dt;
        if (this.biteT >= BITE_REST) {
          this.biteState = 'none';
          this.biteCd = this.biteCooldown * (0.8 + Math.random() * 0.5);
        }
    }
  }

  /** Движение головы вдоль поверхности, огибание внутренних и внешних углов. */
  private crawl(step: number): void {
    // граница комнаты: впереди чужая клетка — разворот
    if (this.leash && !this.leash.contains(this.s.x + this.n.x * 4 + this.t.x * (step + this.radius + 6), this.s.y + this.n.y * 4 + this.t.y * (step + this.radius + 6))) {
      this.t = { x: -this.t.x, y: -this.t.y };
    }
    this.s = { x: this.s.x + this.t.x * step, y: this.s.y + this.t.y * step };
    if (this.cornerCooldown > 0) {
      this.snapToSurface();
      return;
    }
    const r = this.radius;

    // Внутренний угол: впереди стена — голова встаёт на неё; контакт поднимается на радиус над прежней поверхностью
    const base = { x: this.s.x + this.n.x * WALL_PROBE_HEIGHT, y: this.s.y + this.n.y * WALL_PROBE_HEIGHT };
    const front = { x: base.x + this.t.x * r, y: base.y + this.t.y * r };
    if (this.solid(front.x, front.y)) {
      const wall = this.cast(base, this.t, r + 2);
      const d = wall ? Math.hypot(wall.x - base.x, wall.y - base.y) : r;
      const oldN = this.n;
      this.s = { x: this.s.x + this.t.x * d + oldN.x * r, y: this.s.y + this.t.y * d + oldN.y * r };
      this.n = { x: -this.t.x, y: -this.t.y };
      this.t = { x: oldN.x, y: oldN.y };
      this.cornerCooldown = 0.12;
      this.snapToSurface();
      return;
    }

    // Внешний угол: голова потеряла опору — обходит ребро
    const under = { x: this.s.x - this.n.x * EDGE_PROBE, y: this.s.y - this.n.y * EDGE_PROBE };
    if (!this.solid(under.x, under.y)) {
      let e = { x: this.s.x, y: this.s.y };
      for (let i = 0; i < 80; i++) {
        const probe = { x: e.x - this.n.x * EDGE_PROBE, y: e.y - this.n.y * EDGE_PROBE };
        if (this.solid(probe.x, probe.y)) break;
        e = { x: e.x - this.t.x * 0.5, y: e.y - this.t.y * 0.5 };
      }
      const oldN = this.n;
      const oldT = this.t;
      this.n = { x: oldT.x, y: oldT.y };
      this.t = { x: -oldN.x, y: -oldN.y };
      this.s = { x: e.x - oldN.x * EDGE_WRAP_DEPTH, y: e.y - oldN.y * EDGE_WRAP_DEPTH };
      this.cornerCooldown = 0.12;
    }
    this.snapToSurface();
  }

  private snapToSurface(): void {
    const up = 3;
    const start = { x: this.s.x + this.n.x * up, y: this.s.y + this.n.y * up };
    const hit = this.cast(start, { x: -this.n.x, y: -this.n.y }, up + 4);
    if (hit) this.s = hit;
  }

  // ---------- Зарывание ----------

  /** Начинает зарываться, когда голова встала ровно над серединой клетки под ней. Возвращает true, если ход начат. */
  private tryBurrow(step: number, force: boolean): boolean {
    const ts = this.level.tileSize;
    const horizontal = Math.abs(this.t.x) > 0.5;
    const along = horizontal ? this.s.x : this.s.y;
    const off = along - (Math.floor(along / ts) + 0.5) * ts;
    if (!force && Math.abs(off) > Math.max(1.5, step)) return false;

    const under = { x: this.s.x - this.n.x * 2, y: this.s.y - this.n.y * 2 };
    const entry = { cx: Math.floor(under.x / ts), cy: Math.floor(under.y / ts) };
    const plan = this.planTunnel(entry.cx, entry.cy);
    if (!plan) {
      this.burrowTimer = 2; // подходящего хода нет — попробуем чуть позже
      return false;
    }
    this.waypoints = plan.points;
    this.exitDir = plan.dir;
    this.waitT = 0;
    this.hiddenT = 0;
    this.state = 'tunnel';
    return true;
  }

  /**
   * Ход под землёй: поиск в ширину по твёрдым клеткам от входа; выход — клетка с свободным соседом.
   * Возвращает ломаную из центров клеток (последняя точка — центр свободной клетки за выходом).
   */
  private planTunnel(startCx: number, startCy: number): { points: Vec[]; dir: Vec } | null {
    if (!this.cellSolid(startCx, startCy)) return null;
    const W = this.level.widthTiles;
    const ts = this.level.tileSize;
    const stride = W + 2; // рамка шире уровня на клетку с каждой стороны
    const key = (cx: number, cy: number) => (cy + 1) * stride + cx + 1;
    const dist = new Map<number, number>([[key(startCx, startCy), 0]]);
    const parent = new Map<number, number>();
    const queue: Array<[number, number]> = [[startCx, startCy]];
    const exits: Array<{ cx: number; cy: number; dir: Vec }> = [];

    for (let qi = 0; qi < queue.length; qi++) {
      const [cx, cy] = queue[qi];
      const dcur = dist.get(key(cx, cy)) ?? 0;
      if (dcur >= TUNNEL_MIN) {
        for (const a of AXES) {
          const ex = (cx + a.x + 0.5) * ts;
          const ey = (cy + a.y + 0.5) * ts;
          if (this.cellFree(cx + a.x, cy + a.y) && !this.occupied(ex, ey, 34) && (!this.leash || this.leash.contains(ex, ey))) exits.push({ cx, cy, dir: a });
        }
      }
      if (dcur >= TUNNEL_MAX) continue;
      for (const a of AXES) {
        const nx = cx + a.x;
        const ny = cy + a.y;
        if (!this.cellSolid(nx, ny) || dist.has(key(nx, ny))) continue;
        dist.set(key(nx, ny), dcur + 1);
        parent.set(key(nx, ny), key(cx, cy));
        queue.push([nx, ny]);
      }
    }
    if (exits.length === 0) return null;

    const ex = exits[Math.floor(Math.random() * exits.length)];
    const cells: Array<[number, number]> = [];
    for (let k: number | undefined = key(ex.cx, ex.cy); k !== undefined; k = parent.get(k)) {
      cells.push([(k % stride) - 1, Math.floor(k / stride) - 1]);
    }
    cells.reverse();
    const points = cells.map(([cx, cy]) => ({ x: (cx + 0.5) * ts, y: (cy + 0.5) * ts }));
    points.push({ x: (ex.cx + ex.dir.x + 0.5) * ts, y: (ex.cy + ex.dir.y + 0.5) * ts });
    return { points: this.smoothPath(points), dir: ex.dir };
  }

  /** Скругляет углы хода (срезание углов Чайкина): червь едет плавными дугами, а не ломаной по центрам клеток; срезы остаются внутри угловой клетки. */
  private smoothPath(pts: Vec[]): Vec[] {
    let cur = pts;
    for (let it = 0; it < 2 && cur.length > 2; it++) {
      const out: Vec[] = [cur[0]];
      for (let i = 0; i < cur.length - 1; i++) {
        const a = cur[i];
        const b = cur[i + 1];
        out.push({ x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 }, { x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75 });
      }
      out.push(cur[cur.length - 1]);
      cur = out;
    }
    return cur;
  }

  private updateTunnel(dt: number): void {
    let budget = this.speed * DIG_SPEED * dt;
    while (budget > 0 && this.waypoints.length > 0) {
      const w = this.waypoints[0];
      // перед выходом наружу ждём в ходу, пока у выхода кто-то ползает
      // (пока голова ещё внутри блока; уже вышедшая наружу не останавливается)
      const ts = this.level.tileSize;
      const hidden = this.cellSolid(Math.floor(this.p.x / ts), Math.floor(this.p.y / ts));
      if (this.waypoints.length === 1 && hidden && this.occupied(w.x, w.y, MIN_GAP + 8, true)) {
        this.waitT += dt;
        if (this.waitT < TUNNEL_WAIT) break; // ждём, но не вечно: иначе два червя могут ждать друг друга навсегда
      } else {
        this.waitT = 0;
      }
      const dx = w.x - this.p.x;
      const dy = w.y - this.p.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.p = { x: w.x, y: w.y };
        budget -= d;
        this.waypoints.shift();
      } else {
        this.p = { x: this.p.x + (dx / d) * budget, y: this.p.y + (dy / d) * budget };
        budget = 0;
      }
    }
    if (this.waypoints.length === 0) this.emerge();
  }

  /** Голова вышла наружу целиком — переходим к ползанию по поверхности, из которой вынырнули. */
  private emerge(): void {
    this.n = { x: this.exitDir.x, y: this.exitDir.y };
    this.s = { x: this.p.x - this.n.x * this.radius, y: this.p.y - this.n.y * this.radius };
    const side = Math.random() < 0.5 ? 1 : -1;
    this.t = { x: -this.n.y * side, y: this.n.x * side };
    this.cornerCooldown = 0.3;
    this.state = 'crawl';
    this.burrowTimer = rand(CRAWL_TIME);
    this.mul = 0.6;
    this.waitT = 0;
    this.hiddenT = 0;
    this.idleT = 0;
    this.idleRef = { x: this.p.x, y: this.p.y };
  }

  // ---------- Столкновения с телами ----------

  /** Все точки тел червей (центры сегментов); у себя пропускаем голову и первый сегмент за ней — они всегда рядом. */
  private bodies(skipSelfNear: boolean, othersOnly = false): Array<Vec & { owner: Worm }> {
    const pts: Array<Vec & { owner: Worm }> = [];
    for (const w of this.flock) {
      if (othersOnly && w === this) continue;
      w.chain.segments.forEach((seg, i) => {
        if (w === this && (i === 0 || (skipSelfNear && i === 1))) return;
        pts.push({ x: seg.node.x, y: seg.node.y, owner: w });
      });
    }
    return pts;
  }

  /** Расстояние от точки до ближайшего сегмента другого червя или заднего сегмента этого. */
  private gapTo(pt: Vec): number {
    return this.nearestBody(pt).gap;
  }

  /** Ближайший сегмент (чужой или свой задний) к точке и чей он. */
  private nearestBody(pt: Vec): { gap: number; owner: Worm | null } {
    let gap = Infinity;
    let owner: Worm | null = null;
    for (const b of this.bodies(true)) {
      const d = Math.hypot(b.x - pt.x, b.y - pt.y);
      if (d < gap) {
        gap = d;
        owner = b.owner;
      }
    }
    return { gap, owner };
  }

  /**
   * Есть ли чьё-то тело (кроме головы самого червя и сегмента за ней) ближе r к точке. Учитываются только части вне блоков:
   * спрятанные в блоках (под маской) друг другу не мешают. othersOnly — только чужие черви.
   */
  private occupied(x: number, y: number, r: number, othersOnly = false): boolean {
    const ts = this.level.tileSize;
    for (const b of this.bodies(true, othersOnly)) {
      if (this.cellSolid(Math.floor(b.x / ts), Math.floor(b.y / ts))) continue;
      if (Math.hypot(b.x - x, b.y - y) < r) return true;
    }
    return false;
  }
}
