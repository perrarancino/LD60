import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { AttachmentDef, EnemyDef, EnemySpawnDef, FlightDef, RigDef, SegmentDef } from '../data/types.ts';
import type { Level } from '../world/Level.ts';
import type { HitCircle, PartDamageable, PartDamageResult } from './Hittable.ts';
import { SegmentChain } from './SegmentChain.ts';
import type { ChainPartDef, PartKind, Vec } from './SegmentChain.ts';
import { applySolidMask } from './solidMask.ts';

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

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
 * выбитая часть исчезает, остальные смыкаются, а гибель головы — гибель босса. Пока никого не бьёт.
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

  constructor(
    def: EnemyDef, spawn: EnemySpawnDef, private readonly level: Level, rig: RigDef, sprites: SpriteLibrary,
    private readonly target: () => Vec | null // за кем летит (герой)
  ) {
    const seg = rig.segmented;
    if (!seg?.flight) throw new Error(`[WormBoss] в риге "${rig.id}" нет блока segmented.flight`);
    this.flight = seg.flight;
    this.speed = def.stats.movement_speed;
    this.speedNow = this.speed;

    const total = Math.max(seg.length_min, Math.min(seg.length_max, spawn.length ?? seg.length_max));
    const hp = seg.health ?? { body: def.stats.max_health, tail: def.stats.max_health };
    const radius = seg.thickness / 2;

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

  // ---------- Полёт ----------

  public update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.phase += PHASE_RATE * dt;
    const f = this.flight;
    const ts = this.level.tileSize;
    const W = this.level.widthTiles * ts;
    const H = this.level.heightTiles * ts;

    const target = this.target();
    let want = this.heading;
    let steering = true;
    const outside = this.p.x < BOUNDS_MARGIN_X || this.p.x > W - BOUNDS_MARGIN_X || this.p.y < BOUNDS_TOP || this.p.y > H + BOUNDS_BOTTOM;
    if (outside) {
      // у края арены — назад к центру (не раздумывая о герое)
      want = Math.atan2(H * 0.4 - this.p.y, W / 2 - this.p.x);
      this.mode = 'seek';
    } else if (this.mode === 'pass') {
      // пролёт мимо: держит курс (чуть виляет), пока не пройдёт время или не выйдет за дальность
      this.passT -= dt;
      steering = false;
      if (this.passT <= 0) this.mode = 'seek';
    } else if (target) {
      const dx = target.x - this.p.x;
      const dy = target.y - this.p.y;
      const dist = Math.hypot(dx, dy);
      want = Math.atan2(dy, dx);
      if (dist > WANDER_RANGE) want += WANDER * Math.sin(this.time * WANDER_RATE);
      if (dist < f.pass_distance && Math.abs(wrap(want - this.heading)) < 1.2) {
        this.mode = 'pass';
        this.passT = rand(f.pass_time);
      }
    }

    const maxTurn = f.turn_rate * dt;
    const turn = steering ? clamp(wrap(want - this.heading), -maxTurn, maxTurn) : 0;
    this.heading = wrap(this.heading + turn);
    this.turnRate += (turn / Math.max(dt, 1e-3) - this.turnRate) * (1 - Math.exp(-8 * dt));

    const speedWant = this.speed * (this.mode === 'pass' ? f.boost : 1);
    this.speedNow += (speedWant - this.speedNow) * (1 - Math.exp(-SPEED_RATE * dt));
    this.p = { x: this.p.x + Math.cos(this.heading) * this.speedNow * dt, y: this.p.y + Math.sin(this.heading) * this.speedNow * dt };

    // щупальца качаются и отстают при повороте головы
    const lag = clamp(-this.turnRate * SWAY_LAG, -SWAY_LAG_MAX, SWAY_LAG_MAX);
    for (const t of this.tentacles) t.sprite.rotation = t.amp * Math.sin(this.time * t.speed + t.phase) + lag;

    this.chain.update(dt, this.p, this.phase, f.wave, 0, this.heading + Math.PI / 2);
  }
}
