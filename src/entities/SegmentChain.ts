import type { Container } from 'pixi.js';
import { HitReaction } from './HitReaction.ts';
import type { HitCircle } from './Hittable.ts';

const TRAIL_STEP = 1.5; // px: шаг записи следа головы
const CLOSE_RATE = 7; // 1/с: как быстро звенья смыкаются, когда впереди выбило часть тела
const SQUASH_LAG = 0.9; // сдвиг фазы между соседними звеньями, рад

export interface Vec {
  x: number;
  y: number;
}

export type PartKind = 'head' | 'body' | 'tail';

/** Одна часть тела: у каждой своё здоровье, свой круг попадания и своя вспышка. */
export interface ChainSegment {
  id: number; // не меняется, когда другие части выбиты (по нему игра находит часть, в которую попал удар)
  kind: PartKind;
  node: Container; // всё, что рисуется для части: позиция — центр, поворот — по следу (верх рисунка = вперёд)
  radius: number; // круг попадания, px
  hp: number;
  maxHp: number;
  baseScale: number;
  dist: number; // текущее расстояние от головы вдоль следа, px
  target: number; // куда оно смыкается
  lag: number; // сдвиг фазы волны
  react: HitReaction;
}

export interface ChainPartDef {
  kind: PartKind;
  node: Container;
  radius: number;
  hp: number;
  scale?: number;
  flash?: Container[]; // что вспыхивает при ударе (по умолчанию — сам node)
}

/** Чем кончился урон по части. */
export type PartResult = 'miss' | 'hit' | 'killed';

/**
 * Цепочка частей, едущих по следу головы (червь и босс-червь). Каждая часть — отдельный узел со своим здоровьем: когда здоровье части
 * кончается, она выбывает, а те, что сзади, смыкаются к голове. Голова — особая часть (id 0): её гибель — гибель всего существа,
 * это решает владелец. Расстояния между частями берутся из spacing(предыдущая, эта).
 */
export class SegmentChain {
  public readonly segments: ChainSegment[] = [];

  private trail: Vec[] = [];
  private head: Vec = { x: 0, y: 0 };
  private limit = 0;
  private nextId = 0;

  constructor(container: Container, parts: ChainPartDef[], private readonly spacing: (prev: PartKind, kind: PartKind) => number) {
    let dist = 0;
    parts.forEach((p, i) => {
      if (i > 0) dist += spacing(parts[i - 1].kind, p.kind);
      this.segments.push({
        id: this.nextId++, kind: p.kind, node: p.node, radius: p.radius, hp: p.hp, maxHp: p.hp, baseScale: p.scale ?? 1,
        dist, target: dist, lag: i * SQUASH_LAG, react: new HitReaction(p.flash ?? [p.node])
      });
    });
    this.limit = dist + 24;
    // голова сверху: добавляем с хвоста
    for (let i = this.segments.length - 1; i >= 0; i--) container.addChild(this.segments[i].node);
  }

  /** Ставит голову в точку и вытягивает след прямо за ней (dir — единичный вектор, куда смотрит голова). */
  public reset(head: Vec, dir: Vec, phase = 0, headAngle?: number): void {
    this.head = { ...head };
    this.trail = [];
    for (let d = TRAIL_STEP; d <= this.limit + 4; d += TRAIL_STEP) this.trail.push({ x: head.x - dir.x * d, y: head.y - dir.y * d });
    for (const s of this.segments) s.dist = s.target;
    this.layout(phase, undefined, 0, headAngle);
  }

  /** wave — поперечная волна по телу; squash — пульсация вдоль тела (0 для плавного хода босса). */
  public update(dt: number, head: Vec, phase: number, wave?: { amp: number; k: number }, squash = 0, headAngle?: number): void {
    for (const s of this.segments) s.react.update(dt);
    this.head = head;
    const last = this.trail[0];
    if (!last || Math.hypot(head.x - last.x, head.y - last.y) >= TRAIL_STEP) this.trail.unshift({ x: head.x, y: head.y });
    this.trim();
    const close = 1 - Math.exp(-CLOSE_RATE * dt);
    for (const s of this.segments) s.dist += (s.target - s.dist) * close;
    this.layout(phase, wave, squash, headAngle);
  }

  public get alive(): number {
    return this.segments.length;
  }

  public find(id: number): ChainSegment | undefined {
    return this.segments.find((s) => s.id === id);
  }

  /** Урон части. killed — часть выбыла (из цепочки, узел уничтожен); для головы вызывающий сам решает, что делать с существом. */
  public damage(id: number, amount: number): PartResult {
    const seg = this.find(id);
    if (!seg) return 'miss';
    seg.hp -= amount;
    if (seg.hp > 0) return 'hit';
    seg.hp = 0;
    return 'killed';
  }

  /** Убирает часть из цепочки: те, что сзади, смыкаются. */
  public remove(id: number): void {
    const i = this.segments.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [gone] = this.segments.splice(i, 1);
    gone.node.destroy({ children: true });
    let dist = 0;
    this.segments.forEach((s, k) => {
      if (k > 0) dist += this.spacing(this.segments[k - 1].kind, s.kind);
      s.target = dist;
    });
    this.limit = dist + 24;
  }

  public flash(id: number, dirX: number, dirY: number): void {
    this.find(id)?.react.trigger(dirX, dirY);
  }

  /** Круг на каждую часть; те, что сейчас скрыты (в земле), не бьются. */
  public circles(hidden: (x: number, y: number) => boolean): Array<HitCircle & { part: number }> {
    const out: Array<HitCircle & { part: number }> = [];
    for (const s of this.segments) {
      const { x, y } = s.node.position;
      if (hidden(x, y)) continue;
      out.push({ x, y, r: s.radius, part: s.id });
    }
    return out;
  }

  // ---------- Тело по следу ----------

  private trim(): void {
    let acc = 0;
    let prev = this.head;
    for (let i = 0; i < this.trail.length; i++) {
      acc += Math.hypot(this.trail[i].x - prev.x, this.trail[i].y - prev.y);
      prev = this.trail[i];
      if (acc > this.limit + 12) {
        this.trail.length = i + 1;
        return;
      }
    }
  }

  /** Точка следа на расстоянии a от головы (вдоль ломаной). */
  private pointAt(a: number): Vec {
    let prev = this.head;
    if (a < 0) {
      const last = this.trail[0];
      if (last) {
        const dx = this.head.x - last.x;
        const dy = this.head.y - last.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-3) {
          const d = -a;
          return { x: this.head.x + (dx / len) * d, y: this.head.y + (dy / len) * d };
        }
      }
      return this.head;
    }
    let rest = a;
    for (const pt of this.trail) {
      const seg = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      if (seg >= rest) {
        const f = seg > 0 ? rest / seg : 0;
        return { x: prev.x + (pt.x - prev.x) * f, y: prev.y + (pt.y - prev.y) * f };
      }
      rest -= seg;
      prev = pt;
    }
    return prev;
  }

  private layout(phase: number, wave?: { amp: number; k: number }, squash = 0, headAngle?: number): void {
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const centre = this.pointAt(s.dist);
      let x = centre.x;
      let y = centre.y;

      if (i === 0 && headAngle !== undefined) {
        s.node.position.set(x, y);
        s.node.rotation = headAngle;
        s.node.scale.set(s.baseScale, s.baseScale);
        continue;
      }

      const look = Math.max(20, s.radius * 0.6);
      const front = this.pointAt(s.dist - look);
      const back = this.pointAt(s.dist + look);
      const fx = front.x - back.x;
      const fy = front.y - back.y;
      const len = Math.hypot(fx, fy);
      if (wave && wave.amp > 0 && len > 0.01 && s.dist > 0) {
        // боком от оси тела: волна бежит от головы к хвосту, у головы почти нет (амплитуда растёт вдоль тела)
        const off = wave.amp * Math.min(1, s.dist / 120) * Math.sin(phase * 2 - s.dist * wave.k);
        x += (-fy / len) * off;
        y += (fx / len) * off;
      }
      s.node.position.set(x, y);
      // рисунок смотрит «вверх» (−y): поворачиваем так, чтобы верх части смотрел по ходу следа
      if (len > 0.01) s.node.rotation = Math.atan2(fx, -fy);
      const sq = squash > 0 ? (1 + squash * Math.sin(phase - s.lag)) : 1;
      s.node.scale.set(s.baseScale, s.baseScale * sq);
    }
  }
}
