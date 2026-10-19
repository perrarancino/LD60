import { Container, Graphics } from 'pixi.js';
import type { Level } from '../world/Level.ts';
import type { Particles } from './Particles.ts';
import { BLUE, drawBolts, fractalBolt } from './Lightning.ts';
import type { BoltPt, DynLight } from './Lightning.ts';

const STEP = 2; // px: шаг движения (молния не пролетает сквозь тонкую стену)
const TRAIL_LEN = 38; // px: длина видимого хвоста
const REDRAW = 0.045; // с: как часто молния «перерисовывается»
const HERO_PAD = 3; // px: молния задевает героя на таком расстоянии от его тела
const RETRY = 0.45; // с: пауза до следующей попытки попасть, если урон не засчитан (неуязвимость, шанс брони)
const MAX_LIGHTS = 8;

/** Тело героя в мире (прямоугольник). */
export interface BoltHeroRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EnemyBoltOpts {
  speed: number; // px/с
  bounces: number; // сколько раз отражается от стен; на следующем ударе рассыпается
  life: number; // с
  damage: number;
}

interface Bolt extends EnemyBoltOpts {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  pts: { x: number; y: number }[]; // след: от головы к хвосту, излом — на отражениях
  lines: BoltPt[][];
  ghost: BoltPt[][];
  redraw: number;
  retry: number;
}

/**
 * Синие молнии врагов (страж). Молния летит сгустком с коротким хвостом, отражается от стен как луч героя (угол падения = углу отражения),
 * рассыпается искрами после последнего отражения и бьёт героя при касании. Рисуется единым стилем молний игры (fractalBolt + drawBolts, BLUE) и светит.
 */
export class EnemyBolts {
  public readonly container = new Container();
  /** Источники света молний (мир) — отдаются освещению. */
  public lights: DynLight[] = [];

  private readonly g = new Graphics();
  private bolts: Bolt[] = [];

  constructor(private readonly fx: Particles) {
    this.container.addChild(this.g);
  }

  /** Пускает молнию из точки под углом (рад). */
  public fire(x: number, y: number, angle: number, o: EnemyBoltOpts): void {
    this.bolts.push({
      ...o, x, y, vx: Math.cos(angle) * o.speed, vy: Math.sin(angle) * o.speed, age: 0,
      pts: [{ x, y }, { x, y }], lines: [], ghost: [], redraw: 0, retry: 0
    });
    this.sparks(x, y, 5);
  }

  public get count(): number {
    return this.bolts.length;
  }

  /** onHero(x, y, сторона отбрасывания, урон) -> засчитан ли урон; засчитанный рассыпает молнию. */
  public update(dt: number, level: Level, hero: BoltHeroRect, onHero: (x: number, y: number, dirX: number, damage: number) => boolean): void {
    this.g.clear();
    this.lights = [];
    const lines: BoltPt[][] = [];
    const ghost: BoltPt[][] = [];
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      b.retry -= dt;
      if (b.age >= b.life || !this.advance(b, dt, level)) {
        this.sparks(b.x, b.y, 7);
        this.bolts.splice(i, 1);
        continue;
      }
      // касание героя
      if (b.retry <= 0) {
        const cx = Math.max(hero.left - HERO_PAD, Math.min(b.x, hero.right + HERO_PAD));
        const cy = Math.max(hero.top - HERO_PAD, Math.min(b.y, hero.bottom + HERO_PAD));
        if (cx === b.x && cy === b.y) {
          if (onHero(b.x, b.y, b.vx >= 0 ? 1 : -1, b.damage)) {
            this.sparks(b.x, b.y, 10);
            this.bolts.splice(i, 1);
            continue;
          }
          b.retry = RETRY;
        }
      }
      b.redraw -= dt;
      if (b.redraw <= 0) {
        b.redraw = REDRAW * (0.7 + Math.random() * 0.6);
        b.ghost = b.lines;
        b.lines = this.shape(b);
      }
      lines.push(...b.lines);
      ghost.push(...b.ghost);
      if (this.lights.length < MAX_LIGHTS) {
        this.lights.push({ x: b.x, y: b.y, r: 78, i: 0.9 + 0.3 * Math.random(), c: BLUE.light });
      }
    }
    if (lines.length) drawBolts(this.g, lines, BLUE, ghost);
  }

  public clear(): void {
    this.bolts = [];
    this.lights = [];
    this.g.clear();
  }

  // ---------- Движение ----------

  private solid(level: Level, x: number, y: number): boolean {
    const ts = level.tileSize;
    const cx = Math.floor(x / ts);
    const cy = Math.floor(y / ts);
    if (cx < 0 || cy < 0 || cx >= level.widthTiles || cy >= level.heightTiles) return true;
    return level.isSolid(cx, cy);
  }

  /** Двигает голову молнии шагами; false — молния рассыпалась (отразилась больше, чем разрешено). */
  private advance(b: Bolt, dt: number, level: Level): boolean {
    const total = Math.hypot(b.vx, b.vy) * dt;
    const steps = Math.max(1, Math.ceil(total / STEP));
    const sx = (b.vx * dt) / steps;
    const sy = (b.vy * dt) / steps;
    for (let i = 0; i < steps; i++) {
      const nx = b.x + sx;
      const ny = b.y + sy;
      if (this.solid(level, nx, ny)) {
        const hx = this.solid(level, nx, b.y);
        const hy = this.solid(level, b.x, ny);
        if (hx && !hy) b.vx = -b.vx; else if (hy && !hx) b.vy = -b.vy; else { b.vx = -b.vx; b.vy = -b.vy; }
        if (b.bounces-- <= 0) return false;
        this.sparks(b.x, b.y, 6);
        b.pts.unshift({ x: b.x, y: b.y }); // излом следа
        continue;
      }
      b.x = nx;
      b.y = ny;
    }
    b.pts[0] = { x: b.x, y: b.y };
    // хвост: оставляем только TRAIL_LEN px пути за головой
    let acc = 0;
    for (let k = 0; k < b.pts.length - 1; k++) {
      const seg = Math.hypot(b.pts[k + 1].x - b.pts[k].x, b.pts[k + 1].y - b.pts[k].y);
      if (acc + seg >= TRAIL_LEN) {
        const f = seg > 0 ? (TRAIL_LEN - acc) / seg : 0;
        b.pts[k + 1] = { x: b.pts[k].x + (b.pts[k + 1].x - b.pts[k].x) * f, y: b.pts[k].y + (b.pts[k + 1].y - b.pts[k].y) * f };
        b.pts.length = k + 2;
        break;
      }
      acc += seg;
    }
    // хвост ещё не вытянулся (только выпущена): тянем от точки выстрела
    if (b.pts.length === 2 && Math.hypot(b.pts[0].x - b.pts[1].x, b.pts[0].y - b.pts[1].y) < 1) {
      const len = Math.hypot(b.vx, b.vy) || 1;
      b.pts[1] = { x: b.x - (b.vx / len) * 4, y: b.y - (b.vy / len) * 4 };
    }
    return true;
  }

  /** Новая форма молнии по следу: короткая ломаная жила с острием на хвосте и звёздочка на голове. */
  private shape(b: Bolt): BoltPt[][] {
    const out: BoltPt[][] = [];
    for (let k = 0; k < b.pts.length - 1; k++) {
      const a = b.pts[k];
      const z = b.pts[k + 1];
      if (Math.hypot(z.x - a.x, z.y - a.y) < 2) continue;
      out.push(...fractalBolt({ x: a.x, y: a.y, w: 1 }, { x: z.x, y: z.y }, {
        rough: 0.16, maxOff: 5, depth: 3, tipEnd: k === b.pts.length - 2, branches: 0.12, branchLen: [5, 11]
      }));
    }
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const l = 3 + Math.random() * 5;
      out.push(fractalBolt({ x: b.x, y: b.y, w: 0.9 }, { x: b.x + Math.cos(a) * l, y: b.y + Math.sin(a) * l }, { rough: 0.2, maxOff: 2, depth: 1, tipEnd: true, branches: 0 })[0]);
    }
    return out;
  }

  private sparks(x: number, y: number, n: number): void {
    this.fx.burst(x, y, { count: n, colors: BLUE.sparks, speed: [30, 110], spread: Math.PI * 2, life: [0.1, 0.28], size: [1, 2] });
  }
}
