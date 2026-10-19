import { pal } from '../core/Palette.ts';
import type { Ramp } from '../core/Palette.ts';
import type { RunNode } from '../systems/Run.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

const SMALL = 7; // px арта: полуширина обычного кубика
const BOSS = 11; // босса — крупнее
const GAP = 7; // между кубиками одного уровня
const GROUP_GAP = 16; // между уровнями
const FADE_IN = 0.3; // с: экран темнеет
const FADE_OUT = 0.45; // с: экран открывается
const DROP = 0.5; // с: кубики «падают» на место
const LIGHT_AT = 0.75; // с: когда загорается пройденный кубик
const HOLD = 1.0; // с: сколько держим кадр после того, как загорелся пройденный

type Kind = 'next' | 'victory' | 'death';

interface Face {
  top: number;
  left: number;
  right: number;
}

/** Грани кубика по состоянию: done — золотой, current — переливается, todo — тёмный; босс — алый. */
function faces(boss: boolean, state: 'done' | 'current' | 'todo', pulse: number): Face {
  const ramp: Ramp = boss ? 'ember' : 'gold';
  if (state === 'done') return { top: pal(ramp, 7), left: pal(ramp, 5), right: pal(ramp, 3) };
  if (state === 'current') {
    const k = 0.5 + 0.5 * Math.sin(pulse * 6);
    const r: Ramp = boss ? 'plasma' : 'electric';
    return k > 0.5 ? { top: pal(r, 7), left: pal(r, 6), right: pal(r, 4) } : { top: pal(r, 6), left: pal(r, 5), right: pal(r, 3) };
  }
  return { top: pal('steel', 3), left: pal('steel', 2), right: pal('steel', 1) };
}

/**
 * Экран перехода между комнатами: ряд кубиков — весь забег (по 3 на боевой уровень и крупный на босса). Пройденные горят золотом, следующий мигает.
 * Закрывает экран при уходе из комнаты (загорается только что пройденный кубик), остаётся поверх, пока страница перезагружается и грузится следующая комната,
 * и плавно открывается, когда комната готова. Текста нет — только кубики.
 */
export class CubeTransition {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private t = 0;
  private last = 0;
  private alpha = 1;
  private fadeDir: 0 | 1 | -1 = 0; // 1 — темнеет, -1 — открывается
  private done = 0; // сколько кубиков уже горит
  private pulse: number | null = null; // какой кубик мигает (следующий)
  private flash = -1; // кубик со вспышкой «только что загорелся»
  private flashT = 0;
  private dead = -1; // кубик, на котором забег оборвался
  private sparks: { x: number; y: number; vx: number; vy: number; life: number; c: number }[] = [];
  private lit = false; // анимация «загорелся» уже сыграна
  private dropT = DROP; // анимация падения кубиков: 0..DROP
  private after: (() => void) | null = null;
  private leaveAt = Infinity;
  private kind: Kind = 'next';

  constructor(private readonly nodes: RunNode[]) {
    this.root.style.cssText = 'position: fixed; inset: 0; z-index: 3000; background: #05070b; pointer-events: all; opacity: 1; display: none;';
    this.canvas.style.cssText = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; image-rendering: pixelated;';
    this.root.appendChild(this.canvas);
    document.body.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
  }

  private scale(): number {
    return Math.max(1, Math.round(window.innerHeight / 270));
  }

  private resize(): void {
    const s = this.scale();
    this.canvas.width = Math.ceil(window.innerWidth / s);
    this.canvas.height = Math.ceil(window.innerHeight / s);
  }

  /** Закрывает экран сразу (первая отрисовка страницы): done кубиков горит, следующий мигает. */
  public cover(done: number): void {
    this.done = done;
    this.pulse = done < this.nodes.length ? done : null;
    this.alpha = 1;
    this.fadeDir = 0;
    this.dropT = DROP;
    this.root.style.display = 'block';
    this.root.style.opacity = '1';
    this.resize();
    this.start();
  }

  /** Комната готова — экран плавно открывается. */
  public reveal(minHold = 0.55): void {
    window.setTimeout(() => {
      this.fadeDir = -1;
    }, minHold * 1000);
  }

  /**
   * Уход из комнаты: экран темнеет, кубик пройденного узла (index) загорается, дальше call. kind: next — к следующему узлу, victory — все кубики загораются
   * волной (финальный босс), death — кубик, на котором забег оборвался, вспыхивает красным.
   */
  public leave(index: number, kind: Kind, after: () => void): void {
    this.kind = kind;
    this.after = after;
    this.done = index; // кубики до index уже золотые, сам index мигает, пока не загорится
    this.pulse = index;
    this.dead = kind === 'death' ? index : -1;
    this.flash = -1;
    this.lit = false;
    this.t = 0;
    this.dropT = 0;
    this.alpha = 0;
    this.fadeDir = 1;
    this.leaveAt = FADE_IN + LIGHT_AT + HOLD + (kind === 'victory' ? 2.2 : 0);
    this.root.style.display = 'block';
    this.resize();
    this.start();
  }

  private start(): void {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.draw();
      if (this.root.style.display !== 'none') this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private step(dt: number): void {
    this.t += dt;
    this.dropT = Math.min(DROP, this.dropT + dt);
    if (this.fadeDir === 1) {
      this.alpha = Math.min(1, this.alpha + dt / FADE_IN);
      this.root.style.opacity = String(this.alpha);
    } else if (this.fadeDir === -1) {
      this.alpha = Math.max(0, this.alpha - dt / FADE_OUT);
      this.root.style.opacity = String(this.alpha);
      if (this.alpha <= 0) {
        this.root.style.display = 'none';
        this.fadeDir = 0;
      }
    }
    if (this.after) {
      const into = this.t - FADE_IN;
      if (!this.lit && into >= LIGHT_AT) {
        this.lit = true;
        const i = this.done;
        if (this.kind === 'death') this.flash = i;
        else if (this.kind === 'victory') this.flash = this.nodes.length - 1;
        else this.flash = i;
        this.flashT = 0;
        const p = this.pos(i);
        for (let k = 0; k < 26; k++) {
          const a = Math.random() * Math.PI * 2;
          const v = 30 + Math.random() * 70;
          this.sparks.push({ x: p.x, y: p.y - 6, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.5 + Math.random() * 0.5, c: this.kind === 'death' ? pal('ember', 5) : pal(this.nodes[i]?.kind === 'boss' ? 'ember' : 'gold', 6) });
        }
        if (this.kind === 'next') this.pulse = Math.min(this.nodes.length - 1, i + 1);
      }
      if (this.t >= this.leaveAt) {
        const cb = this.after;
        this.after = null;
        cb();
      }
    }
    if (this.flash >= 0) this.flashT += dt;
    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 120 * dt;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
  }

  /** Центр кубика i на холсте (логические px). */
  private pos(i: number): { x: number; y: number } {
    const widths = this.nodes.map((n) => (n.kind === 'boss' ? BOSS : SMALL) * 2);
    let total = 0;
    for (let k = 0; k < this.nodes.length; k++) {
      total += widths[k];
      if (k + 1 < this.nodes.length) total += this.nodes[k + 1].stage !== this.nodes[k].stage ? GROUP_GAP : GAP;
    }
    let x = (this.canvas.width - total) / 2;
    for (let k = 0; k < i; k++) x += widths[k] + (this.nodes[k + 1].stage !== this.nodes[k].stage ? GROUP_GAP : GAP);
    return { x: x + widths[i] / 2, y: this.canvas.height / 2 };
  }

  private cube(cx: number, cy: number, s: number, f: Face): void {
    const c = this.ctx;
    const hgt = Math.round(s * 0.95);
    const hy = Math.round(s / 2);
    const poly = (pts: [number, number][], col: number) => {
      c.fillStyle = hex(col);
      c.beginPath();
      c.moveTo(Math.round(pts[0][0]), Math.round(pts[0][1]));
      for (let i = 1; i < pts.length; i++) c.lineTo(Math.round(pts[i][0]), Math.round(pts[i][1]));
      c.closePath();
      c.fill();
    };
    poly([[cx - s, cy - hgt], [cx, cy - hgt + hy], [cx, cy + hy], [cx - s, cy]], f.left);
    poly([[cx + s, cy - hgt], [cx, cy - hgt + hy], [cx, cy + hy], [cx + s, cy]], f.right);
    poly([[cx, cy - hgt - hy], [cx + s, cy - hgt], [cx, cy - hgt + hy], [cx - s, cy - hgt]], f.top);
  }

  private draw(): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.fillStyle = '#05070b';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const s = n.kind === 'boss' ? BOSS : SMALL;
      const p = this.pos(i);
      // падение на место с отскоком, по очереди слева направо
      const local = Math.max(0, Math.min(1, (this.dropT - i * 0.02) / (DROP - 0.25)));
      const fall = (1 - local) * (1 - local) * -90 + (local > 0.8 ? Math.sin((local - 0.8) * Math.PI * 5) * -1.5 : 0);
      const lit = this.flash === i && this.kind !== 'death' && this.flashT < 0.5;
      let state: 'done' | 'current' | 'todo' = i < this.done ? 'done' : i === this.pulse ? 'current' : 'todo';
      if (this.flash === i && this.kind !== 'death') state = 'done';
      if (this.kind === 'victory' && this.flash >= 0) state = this.flashT * 14 > i ? 'done' : state;
      let f = faces(n.kind === 'boss', state, this.t);
      if (lit) f = { top: 0xffffff, left: pal('gold', 7), right: pal('gold', 6) };
      if (this.kind === 'death' && this.dead === i && this.flash === i) f = { top: pal('ember', 7), left: pal('ember', 5), right: pal('ember', 3) };
      const bob = state === 'current' ? Math.round(Math.sin(this.t * 6) * 1.2) : 0;
      this.cube(p.x, p.y + fall + bob + (lit ? -3 : 0), s, f);
    }
    for (const sp of this.sparks) {
      c.fillStyle = hex(sp.c);
      c.fillRect(Math.round(sp.x), Math.round(sp.y), 1, 1);
    }
  }
}
