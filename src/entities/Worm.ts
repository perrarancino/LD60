import { Container } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { EnemyDef, EnemySpawnDef, RigDef, SegmentDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';
import { SegmentChain } from './SegmentChain.ts';
import type { PartKind, Vec } from './SegmentChain.ts';
import { applySolidMask } from './solidMask.ts';

// ---- Ползание по поверхностям (как у паука, но тело толстое: центр головы идёт на радиусе от поверхности)
const WALL_PROBE_HEIGHT = 4; // px над поверхностью, на которой проверяем стену впереди
const EDGE_PROBE = 1.5; // px под поверхностью — проверка опоры под головой (внешний угол)
const EDGE_WRAP_DEPTH = 1; // px: на сколько голова «сползает» по грани за край
const FOLLOW_POS = 20; // 1/с: сглаживание видимой позиции головы (скругляет углы и стыки с туннелем)

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

  private state: 'crawl' | 'tunnel' = 'crawl';

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

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly flock: Worm[] = [] // все черви уровня (включая этого): чтобы не пересекаться
  ) {
    const seg = rig.segmented;
    if (!seg) throw new Error(`[Worm] в риге "${rig.id}" нет блока segmented`);
    this.radius = seg.thickness / 2;
    this.speed = def.stats.movement_speed;

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

    if (this.state === 'crawl') {
      this.updateCrawl(dt);
    } else {
      this.updateTunnel(dt);
    }

    // Видимая голова догоняет истинную: углы и стыки с туннелем скругляются
    const kp = 1 - Math.exp(-FOLLOW_POS * dt);
    this.vis.x += (this.p.x - this.vis.x) * kp;
    this.vis.y += (this.p.y - this.vis.y) * kp;
    this.chain.update(dt, this.vis, this.phase);
  }

  private updateCrawl(dt: number): void {
    this.cornerCooldown -= dt;
    this.burrowTimer -= dt;

    // Ползёт «гусеницей»: скорость пульсирует, в среднем равна movement_speed
    let step = this.speed * (1 + INCH_SPEED * Math.sin(this.phase)) * dt;

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

    if (this.stuck > STUCK_TIME && !yielding) {
      this.tryBurrow(0, true);
      if (this.state === 'crawl') this.stuck = 0; // не вышло — подождём ещё
    } else if (this.burrowTimer <= 0) {
      this.tryBurrow(step, false);
    }
  }

  /** Движение головы вдоль поверхности, огибание внутренних и внешних углов. */
  private crawl(step: number): void {
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

  /** Начинает зарываться, когда голова встала ровно над серединой клетки под ней. */
  private tryBurrow(step: number, force: boolean): void {
    const ts = this.level.tileSize;
    const horizontal = Math.abs(this.t.x) > 0.5;
    const along = horizontal ? this.s.x : this.s.y;
    const off = along - (Math.floor(along / ts) + 0.5) * ts;
    if (!force && Math.abs(off) > Math.max(1.5, step)) return;

    const under = { x: this.s.x - this.n.x * 2, y: this.s.y - this.n.y * 2 };
    const entry = { cx: Math.floor(under.x / ts), cy: Math.floor(under.y / ts) };
    const plan = this.planTunnel(entry.cx, entry.cy);
    if (!plan) {
      this.burrowTimer = 2; // подходящего хода нет — попробуем чуть позже
      return;
    }
    this.waypoints = plan.points;
    this.exitDir = plan.dir;
    this.state = 'tunnel';
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
          if (this.cellFree(cx + a.x, cy + a.y) && !this.occupied((cx + a.x + 0.5) * ts, (cy + a.y + 0.5) * ts, 34)) exits.push({ cx, cy, dir: a });
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
    return { points, dir: ex.dir };
  }

  private updateTunnel(dt: number): void {
    let budget = this.speed * DIG_SPEED * dt;
    while (budget > 0 && this.waypoints.length > 0) {
      const w = this.waypoints[0];
      // перед выходом наружу ждём в ходу, пока у выхода кто-то ползает
      // (пока голова ещё внутри блока; уже вышедшая наружу не останавливается)
      const ts = this.level.tileSize;
      const hidden = this.cellSolid(Math.floor(this.p.x / ts), Math.floor(this.p.y / ts));
      if (this.waypoints.length === 1 && hidden && this.occupied(w.x, w.y, MIN_GAP + 8, true)) break;
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
