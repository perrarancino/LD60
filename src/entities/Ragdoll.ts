import type { Level } from '../world/Level.ts';

interface Vec {
  x: number;
  y: number;
}

/** Геометрия тела в координатах холста рига (позa «как нарисовано»): из неё строится регдолл. */
export interface RagdollGeometry {
  anchor: Vec; // точка ног героя (начало мировых координат тела)
  waist: Vec; // таз (вокруг него вращается торс)
  neck: Vec; // шея (на ней держится голова)
  head: Vec; // центр головы
  hips: { at: Vec; length: number }[]; // бёдра и длины ног (нога нарисована прямо вниз)
}

interface Point {
  x: number;
  y: number;
  px: number;
  py: number;
  r: number; // радиус столкновения: половина толщины части тела
  inv: number; // 1 / масса
}

interface Link {
  a: number;
  b: number;
  min: number; // жёсткая связь: min === max
  max: number;
}

// Физика
const GRAVITY = 850; // px/с² — как у героя
const STEP = 1 / 300; // с: фиксированный шаг — одинаковая физика при любом dt кадра
const MAX_STEPS = 12;
const ITERATIONS = 6;
const AIR_DRAG = 0.8; // 1/с
const FRICTION = 0.35; // доля касательной скорости, теряемая при касании тайла (за подшаг)
const BOUNCE = 0.15; // упругость удара о тайл
const MAX_SPEED = 700; // px/с
// Подъём: «мышцы» тянут точки к стойке, по очереди — стопы, таз, грудь, голова
const GETUP_STIFF = 420; // 1/с²
const GETUP_DAMP = 12; // 1/с: гасит раскачку при подъёме
const GETUP_ORDER = [0.12, 0.25, 0.35, 0.0, 0.0]; // с задержки старта мышц: таз, шея, голова, стопы

const P = 0; // таз
const N = 1; // шея
const H = 2; // голова

/**
 * Регдолл героя: таз, шея, голова и стопы — точки verlet с массой; торс, шея и ноги — жёсткие связи, плюс ограничения сгиба
 * (голова не складывается на грудь, ноги не подтягиваются к шее). Каждая точка — круг с толщиной части тела: она сталкивается
 * с тайлами (выталкивается, теряет скорость по касательной, слегка отскакивает), поэтому тело не проходит сквозь стены и пол.
 * Подъём — «активный»: мышцы-пружины тянут точки к стойке героя по очереди (стопы -> таз -> грудь -> голова), столкновения
 * при этом работают, и встаёт он физически — из того положения и места, где лёг.
 */
export class Ragdoll {
  public readonly points: Point[] = [];
  private readonly links: Link[] = [];
  private readonly rest: Vec[] = []; // стойка в координатах холста (до зеркалирования)
  private level: Level | null = null;
  private time = 0;
  private calm = 0; // сколько секунд тело почти не движется
  private getUpT = -1; // < 0 — ещё не встаёт
  private acc = 0;

  constructor(private readonly geo: RagdollGeometry) {
    const footOf = (h: { at: Vec; length: number }) => ({ x: h.at.x, y: h.at.y + h.length });
    this.rest = [geo.waist, geo.neck, geo.head, ...geo.hips.map(footOf)];
    const radii = [5, 5, 6, ...geo.hips.map(() => 2)];
    const mass = [3, 2.5, 1.5, ...geo.hips.map(() => 1)];
    for (let i = 0; i < this.rest.length; i++) this.points.push({ x: 0, y: 0, px: 0, py: 0, r: radii[i], inv: 1 / mass[i] });
    const d = (a: number, b: number) => Math.hypot(this.rest[a].x - this.rest[b].x, this.rest[a].y - this.rest[b].y);
    const rigid = (a: number, b: number) => this.links.push({ a, b, min: d(a, b), max: d(a, b) });
    const limit = (a: number, b: number, lo: number, hi: number) => this.links.push({ a, b, min: d(a, b) * lo, max: d(a, b) * hi });
    rigid(P, N); // торс
    rigid(N, H); // шея
    limit(P, H, 0.85, 1.03); // голова не складывается на грудь и не запрокидывается
    for (let i = 3; i < this.rest.length; i++) {
      rigid(P, i); // нога
      limit(N, i, 0.72, 1.02); // нога не подтягивается к груди
    }
    for (let i = 3; i + 1 < this.rest.length; i++) limit(i, i + 1, 0.4, 3.5); // стопы не сливаются в одну
  }

  /** Стойка героя в мире: тело стоит в (bodyX, bodyY) ногами, взгляд facing. */
  private standing(bodyX: number, bodyY: number, facing: 1 | -1): Vec[] {
    const a = this.geo.anchor;
    return this.rest.map((c) => ({ x: bodyX + (c.x - a.x) * facing, y: bodyY + (c.y - a.y) }));
  }

  /**
   * Тело только что ударилось о землю: точки — в стойке, скорости — по инерции падения (vx, vy) и толчку topple
   * (скорость груди и головы по горизонтали: вперёд, если бежал, иначе назад — ноги подкашиваются, тело валится).
   */
  public start(level: Level, bodyX: number, bodyY: number, facing: 1 | -1, vx: number, vy: number, topple: number): void {
    this.level = level;
    this.time = 0;
    this.calm = 0;
    this.getUpT = -1;
    const pose = this.standing(bodyX, bodyY, facing);
    // доля скорости падения, которая остаётся у точки (стопы уже стоят, таз проседает, грудь и голова летят по инерции)
    const keepX = [0.6, 0.9, 1.0, 0.15, 0.15];
    const keepY = [0.35, 0.2, 0.1, 0, 0];
    const push = [0.3, 1.0, 1.25, -0.15, -0.15];
    const h = STEP;
    this.points.forEach((p, i) => {
      const k = Math.min(i, 4);
      const pvx = vx * keepX[k] + topple * push[k] + (Math.random() - 0.5) * 20;
      const pvy = vy * keepY[k];
      p.x = pose[i].x;
      p.y = pose[i].y - (i >= 3 ? p.r : 0); // стопы — на поверхности
      p.px = p.x - pvx * h;
      p.py = p.y - pvy * h;
    });
  }

  /** Тело улеглось: почти не движется заметное время (или лежит уже долго). */
  public get settled(): boolean {
    return this.calm > 0.2 || this.time > 2.0;
  }

  /** Начать подъём (мышцы включаются по очереди). */
  public getUp(): void {
    if (this.getUpT < 0) this.getUpT = 0;
  }

  public get gettingUp(): number {
    return this.getUpT;
  }

  /** Насколько тело близко к стойке (0 — стоит ровно), px — для завершения подъёма. */
  public offStand(bodyX: number, bodyY: number, facing: 1 | -1): number {
    const pose = this.standing(bodyX, bodyY, facing);
    let worst = 0;
    this.points.forEach((p, i) => { worst = Math.max(worst, Math.hypot(p.x - pose[i].x, p.y - pose[i].y)); });
    return worst;
  }

  /** stand — стойка, к которой тянут мышцы при подъёме (тело героя: ноги и взгляд). */
  public update(dt: number, stand: { bodyX: number; bodyY: number; facing: 1 | -1 }): void {
    if (!this.level) return;
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    if (this.getUpT >= 0) this.getUpT += dt;
    const pose = this.getUpT >= 0 ? this.standing(stand.bodyX, stand.bodyY, stand.facing) : null;
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const steps = Math.floor(this.acc / STEP);
    this.acc -= steps * STEP;
    const h = STEP;
    const drag = Math.exp(-AIR_DRAG * h);
    const maxStep = MAX_SPEED * h;
    let fastest = 0;

    for (let s = 0; s < steps; s++) {
      this.points.forEach((p, i) => {
        let vx = (p.x - p.px) * drag;
        let vy = (p.y - p.py) * drag;
        let ax = 0;
        let ay = GRAVITY;
        if (pose) {
          // мышцы: включаются по очереди и набирают силу плавно
          const delay = GETUP_ORDER[Math.min(i, 4)];
          const m = Math.min(1, Math.max(0, (this.getUpT - delay) / 0.25));
          const k = GETUP_STIFF * m * m;
          ax += k * (pose[i].x - p.x);
          ay += k * (pose[i].y - p.y) - GRAVITY * m; // мышцы держат вес
          const damp = Math.exp(-GETUP_DAMP * m * h);
          vx *= damp;
          vy *= damp;
        }
        const sp = Math.hypot(vx, vy);
        if (sp > maxStep) { vx *= maxStep / sp; vy *= maxStep / sp; }
        fastest = Math.max(fastest, sp / h);
        p.px = p.x;
        p.py = p.y;
        p.x += vx + ax * h * h;
        p.y += vy + ay * h * h;
      });
      for (let it = 0; it < ITERATIONS; it++) {
        for (const l of this.links) this.solve(l);
        for (const p of this.points) this.collide(p);
      }
    }
    if (steps > 0) this.calm = fastest < 14 ? this.calm + dt : 0;
  }

  private solve(l: Link): void {
    const a = this.points[l.a];
    const b = this.points[l.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const target = d < l.min ? l.min : d > l.max ? l.max : d;
    if (target === d) return;
    const diff = (d - target) / d / (a.inv + b.inv);
    a.x += dx * diff * a.inv;
    a.y += dy * diff * a.inv;
    b.x -= dx * diff * b.inv;
    b.y -= dy * diff * b.inv;
  }

  /** Круг точки против клеток тайлов: выталкивание по кратчайшему пути наружу, трение и небольшой отскок. */
  private collide(p: Point): void {
    const level = this.level!;
    const ts = level.tileSize;
    const x0 = Math.floor((p.x - p.r) / ts);
    const x1 = Math.floor((p.x + p.r) / ts);
    const y0 = Math.floor((p.y - p.r) / ts);
    const y1 = Math.floor((p.y + p.r) / ts);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.solidCell(cx, cy)) continue;
        const L = cx * ts;
        const T = cy * ts;
        const R = L + ts;
        const B = T + ts;
        const qx = Math.max(L, Math.min(R, p.x));
        const qy = Math.max(T, Math.min(B, p.y));
        let nx = p.x - qx;
        let ny = p.y - qy;
        let d = Math.hypot(nx, ny);
        let push: number;
        if (d > 1e-6) {
          if (d >= p.r) continue;
          nx /= d;
          ny /= d;
          push = p.r - d;
        } else {
          // центр внутри клетки: наружу по кратчайшему пути — туда, где соседняя клетка свободна
          const opts: [number, number, number][] = [];
          if (!this.solidCell(cx, cy - 1)) opts.push([0, -1, p.y - T + p.r]);
          if (!this.solidCell(cx, cy + 1)) opts.push([0, 1, B - p.y + p.r]);
          if (!this.solidCell(cx - 1, cy)) opts.push([-1, 0, p.x - L + p.r]);
          if (!this.solidCell(cx + 1, cy)) opts.push([1, 0, R - p.x + p.r]);
          if (!opts.length) continue;
          opts.sort((u, v) => u[2] - v[2]);
          [nx, ny, push] = opts[0];
          d = 0;
        }
        p.x += nx * push;
        p.y += ny * push;
        // скорость: нормальная — с небольшим отскоком, касательная — с трением
        const vx = p.x - p.px;
        const vy = p.y - p.py;
        const vn = vx * nx + vy * ny;
        if (vn < 0) {
          const tx = vx - vn * nx;
          const ty = vy - vn * ny;
          const nvx = tx * (1 - FRICTION) - vn * BOUNCE * nx;
          const nvy = ty * (1 - FRICTION) - vn * BOUNCE * ny;
          p.px = p.x - nvx;
          p.py = p.y - nvy;
        }
      }
    }
  }

  private solidCell(cx: number, cy: number): boolean {
    const level = this.level!;
    if (cy < 0) return false; // над уровнем — небо
    return level.isSolid(cx, cy);
  }
}
