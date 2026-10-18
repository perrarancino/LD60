import { Graphics } from 'pixi.js';
import type { CritterTailDef } from '../data/types.ts';
import { pal } from '../core/Palette.ts';

interface Vec {
  x: number;
  y: number;
}

const JAG_HZ = 15; // раз в секунду зубцы молнии выбираются заново (потрескивание)
const JAG_FOLLOW = 70; // 1/с: насколько быстро зубцы переходят к новым значениям (почти щелчком)
const EDGE = pal('cobalt', 3); // контур-свечение
const BODY = pal('cobalt', 5); // тело молнии
const HOT = pal('cobalt', 7); // раскалённая жила
const SPARK = [pal('cobalt', 6), pal('cobalt', 7), pal('electric', 7)];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => v * v * (3 - 2 * v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Процедурный хвост-молния (электрокрыса): острая зазубренная молния, сужающаяся к кончику и бьющая током. Рисуется пикселями арта (одним Graphics,
 * перерисовывается каждый кадр): цепочка узлов от корня ведётся углами, поверх — зубцы, переизбираемые ~15 раз в секунду, и искры вокруг.
 * Цвета — рампа cobalt палитры проекта (src/core/Palette.ts). Координаты — холст рига зверька (рисунок смотрит влево, хвост уходит в +x).
 *
 * Позы: покой (поднят над спиной, качается волной; на бегу вытягивается назад), замах (wind — хвост взвивается дугой над спиной и загибается вперёд)
 * и хлёст (lash — хвост проносится дугой вперёд и вниз и ложится на землю: корень уже бьёт вниз, а кончик ещё догоняет — петля, как у кнута;
 * вытягивается до lashLength, как разряд). Ниже земли (groundY) хвост не опускается.
 */
export class LightningTail {
  public readonly graphics = new Graphics();
  /** Узлы хвоста в координатах холста (обновляются в update; читать после него). */
  public readonly nodes: Vec[];
  /** Хлёст дошёл до конца в этом кадре (щелчок: искры, вспышка). */
  public cracked = false;

  private readonly root: Vec;
  private readonly length: number;
  private readonly n: number;
  private readonly lashLength: number;
  private readonly groundY: number;
  private readonly jag: number[];
  private readonly jagTarget: number[];
  private readonly grid = new Map<number, number>(); // пиксель -> слой (1 контур, 2 тело, 3 жила)
  private jagTimer = 0;
  private time = Math.random() * 10;
  private flash = 0;
  private lastLash = 0;

  constructor(def: CritterTailDef, lashLength: number, groundY: number) {
    this.groundY = groundY;
    this.root = { x: def.root.x, y: def.root.y };
    this.length = def.length;
    this.n = def.nodes ?? 11;
    this.lashLength = Math.max(def.length, lashLength);
    this.jag = new Array<number>(this.n).fill(0);
    this.jagTarget = new Array<number>(this.n).fill(0);
    this.nodes = Array.from({ length: this.n }, () => ({ x: def.root.x, y: def.root.y }));
    this.update(0, 0, 0, 0);
  }

  /**
   * move — насколько зверёк в движении (0..1), wind — замах (0..1), lash — ход хлёста (0..1; 0 — нет). Возвращает true в кадр, когда хлёст
   * дошёл до конца (щелчок).
   */
  public update(dt: number, move: number, wind: number, lash: number): boolean {
    this.time += dt;
    this.cracked = lash >= 0.8 && this.lastLash < 0.8 && lash < 1.0 + 1e-6 && wind > 0.5;
    this.lastLash = lash;
    if (this.cracked) this.flash = 1;
    this.flash = Math.max(0, this.flash - dt * 7);

    // зубцы: цели переизбираются с частотой потрескивания, текущие почти щелчком идут к ним; знак чередуется — настоящий зигзаг
    this.jagTimer -= dt;
    if (this.jagTimer <= 0) {
      this.jagTimer = 1 / JAG_HZ;
      for (let i = 0; i < this.n; i++) this.jagTarget[i] = (i % 2 ? 1 : -1) * (0.45 + 0.55 * Math.random());
    }
    const jk = dt > 0 ? 1 - Math.exp(-JAG_FOLLOW * dt) : 1;
    for (let i = 0; i < this.n; i++) this.jag[i] += (this.jagTarget[i] - this.jag[i]) * jk;

    // длина: хлёст вытягивает хвост до lashLength (по ходу волны)
    const stretch = ease(clamp01(lash * 1.2));
    const len = lerp(this.length, this.lashLength, stretch) * lerp(1, 1.3, wind * (1 - lash)); // в замахе хвост вытягивается дугой
    const seg = len / (this.n - 1);
    const amp = lerp(lerp(2.7, 3.8, wind), 1.5, stretch); // размах зубцов: в замахе больше, в хлёсте — прямее
    const idleBase = lerp(-0.95, -0.2, move); // покой: поднят над спиной; на бегу вытягивается назад
    let x = this.root.x;
    let y = this.root.y;
    this.nodes[0].x = x;
    this.nodes[0].y = y;
    let prevAng = 0;
    for (let i = 1; i < this.n; i++) {
      const u = i / (this.n - 1);
      // покой: плавная волна вдоль хвоста
      const idle = idleBase - u * 0.55 + Math.sin(this.time * 4.2 - u * 5.0) * (0.25 + 0.2 * move) * (0.3 + u);
      // замах: дуга над спиной, кончик загибается вперёд
      const windA = -0.95 - u * 2.3 + Math.sin(this.time * 9 - u * 6) * 0.07;
      // хлёст: волна выпрямления бежит от корня к кончику
      const e = ease(clamp01(lash * 1.6 - 0.6 * u));
      const lashA = -Math.PI - 0.55 * Math.pow(1 - u, 1.6); // вперёд и вниз к земле, у кончика — вдоль земли
      let ang = lerp(lerp(idle, windA, wind), lashA, e);
      // углы соседних узлов не рвутся (плавная кривая под зубцами)
      if (i > 1) ang = prevAng + Math.max(-1.2, Math.min(1.2, ang - prevAng));
      prevAng = ang;
      x += Math.cos(ang) * seg;
      y += Math.sin(ang) * seg;
      // зубец: сдвиг поперёк хвоста, у корня и кончика затихает
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.7) * amp;
      const off = this.jag[i] * env;
      this.nodes[i].x = x - Math.sin(ang) * off;
      this.nodes[i].y = Math.min(y + Math.cos(ang) * off, this.groundY - 0.5); // по земле — не под неё
    }
    this.draw(wind, lash);
    return this.cracked;
  }

  /** Пиксели молнии: сначала контур, затем тело и жила (сверху); искры вокруг. */
  private draw(wind: number, lash: number): void {
    const g = this.graphics;
    g.clear();
    const grid = this.grid;
    grid.clear();
    const put = (x: number, y: number, layer: number) => {
      const k = (x + 512) * 1024 + (y + 512);
      if ((grid.get(k) ?? 0) < layer) grid.set(k, layer);
    };
    const stamp = (cx: number, cy: number, size: number, layer: number) => {
      const lo = -Math.floor((size - 1) / 2);
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) put(cx + lo + dx, cy + lo + dy, layer);
    };
    const n = this.n;
    const hot = this.flash > 0.05 || lash > 0.2;
    for (let i = 0; i < n - 1; i++) {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      let x0 = Math.round(a.x);
      let y0 = Math.round(a.y);
      const x1 = Math.round(b.x);
      const y1 = Math.round(b.y);
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      const steps = Math.max(dx, -dy) + 1;
      for (let s = 0; s < steps; s++) {
        const u = (i + s / steps) / (n - 1);
        // толщина: у корня 3 пикселя, к кончику — острие в 1 пиксель
        const core = u < 0.3 ? 3 : u < 0.62 ? 2 : 1;
        stamp(x0, y0, core + 2, 1);
        stamp(x0, y0, core, 2);
        if (u < 0.94 && (u < 0.82 || Math.random() < 0.8)) put(x0, y0, 3);
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    // жила: у корня цвет чуть темнее, при вспышке и хлёсте — раскалена целиком
    const cells: number[][] = [[], [], []];
    grid.forEach((layer, k) => cells[layer - 1].push(k));
    const emit = (list: number[], color: number) => {
      if (!list.length) return;
      for (const k of list) g.rect(Math.floor(k / 1024) - 512, (k % 1024) - 512, 1, 1);
      g.fill(color);
    };
    emit(cells[0], this.flash > 0.5 ? BODY : EDGE);
    emit(cells[1], this.flash > 0.5 ? HOT : BODY);
    emit(cells[2], hot ? HOT : pal('cobalt', 6));

    // искры вокруг: в покое редкие, в замахе и хлёсте гуще; живут один кадр (мерцание)
    const count = Math.round(lerp(0.6, 3.5, Math.max(wind, lash)) + this.flash * 4 + (Math.random() < 0.4 ? 1 : 0));
    for (let s = 0; s < count; s++) {
      const i = 1 + Math.floor(Math.random() * (n - 1));
      const p = this.nodes[i];
      const ox = Math.round((Math.random() - 0.5) * 8);
      const oy = Math.round((Math.random() - 0.5) * 8);
      g.rect(Math.round(p.x) + ox, Math.round(p.y) + oy, 1, 1).fill(SPARK[Math.floor(Math.random() * SPARK.length)]);
    }
    // кончик — всегда яркая точка
    const tip = this.nodes[n - 1];
    g.rect(Math.round(tip.x), Math.round(tip.y), 1, 1).fill(HOT);
  }

  /** Расстояние от точки до ломаной хвоста (для попадания хлёста). */
  public distanceTo(px: number, py: number): number {
    let best = Infinity;
    for (let i = 0; i < this.n - 1; i++) {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      const t = l2 > 0 ? clamp01(((px - a.x) * abx + (py - a.y) * aby) / l2) : 0;
      best = Math.min(best, Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t)));
    }
    return best;
  }

  public get tip(): Vec {
    return this.nodes[this.n - 1];
  }
}
