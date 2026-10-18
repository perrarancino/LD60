import { Container, Sprite, Texture } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { DecorZoneDef } from '../data/types.ts';
import { ThreadRope } from '../entities/ThreadRope.ts';

/** Нитка паучихи (enemy_spider_thread): из её звеньев собрана вся висящая паутина. */
export const THREAD_SPRITE = 'enemy_spider_thread';
const THREAD_CENTER_X = 5; // центр нитки по x в звене (как в риге паучихи)

// Лианы под тайлами: цепочка узлов через VINE_NODE px, по два узла на звено нитки (звено рисуется в натуральную длину — не сжимается)
const VINE_NODE = 7;
const VINE_PIECE = VINE_NODE * 2; // px: шаг звеньев вдоль лианы (высота звена 16 минус нахлёст 2)
const VINE_GRAVITY = 300; // px/с²: нитка лёгкая — тяжесть мала, поэтому она послушно колышется и изгибается
const VINE_DAMPING = 1.4; // 1/с: затухание скорости (малое — после толчка лиана качается ещё несколько раз, как маятник)
const VINE_WIND = 95; // px/с²: порывы ветра (к концу лианы растут быстрее, чем линейно, — нить изгибается дугой)
const VINE_BIAS = [18, 42]; // px/с²: постоянный лёгкий сквозняк у каждой лианы (в свою сторону) — висит с наклоном и изгибом, а не палкой
const VINE_RETURN = 2.5; // 1/с²: слабая пружина возврата к вертикали (предела отклонения нет — лиана ограничена только длиной и столкновениями)
const VINE_ITERATIONS = 3;
const VINE_SUBSTEPS = 2;
const ACTOR_PAD = 3; // px: герой задевает лиану чуть раньше края хитбокса
const PUSH_SPEED = 180; // px/с: быстрее узел героем не отодвигается — смещение плавное, без телепортов
const CARRY = 0.2; // доля скорости героя, которую получает задетый узел (лиана немного увлекается за ним)
const REACH_FLIP = 0.72; // доля длины до узла: герой не тянет узел дальше — узел переходит на другую сторону героя, лиана не натягивается струной
const CALM_TIME = 0.7; // с: после контакта лиана успокаивается быстрее — отпущенная, не хлещет
const CALM_DAMPING = 4; // 1/с: добавка затухания сразу после контакта
const SIDE_STUCK = 0.12; // с: узел не может уйти на свою сторону (цепочка натянута) — перетекает на другую сторону героя
const VIEW_MARGIN = 40; // px: за краем обзора декор не обновляется
const VINE_TINTS = [0xffffff, 0xe3f1ff, 0xcfe6ff];
const SKY_CLEARANCE = 8; // px: нитка с неба обрывается чуть выше первой платформы под ней, а не проходит сквозь неё

// Длинные нитки с неба — как у паучихи: ThreadRope (упругая струна), верх закреплён над уровнем, низ свободно покачивается
const SKY_ANCHOR_ROW = -2; // ряд тайлов, где закреплён верх (как у паучихи по умолчанию)
const SKY_SWING = [6, 14]; // px: размах качания нижнего конца (от, до)
const SKY_SPEED = [0.35, 0.7]; // рад/с

/** Детерминированный генератор: раскладка паутины одинакова при каждом запуске. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Тот, кто задевает лианы: хитбокс (мир) и скорость. */
export interface Actor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  vx: number;
  vy: number;
}

/** Звено нитки: спрайт, вытянутый вдоль отрезка. */
class Piece {
  public readonly sprite: Sprite;

  constructor(parent: Container, tex: Texture, alpha = 1, tint = 0xffffff) {
    this.sprite = new Sprite(tex);
    this.sprite.pivot.set(THREAD_CENTER_X, tex.height / 2);
    this.sprite.alpha = alpha;
    this.sprite.tint = tint;
    parent.addChild(this.sprite);
  }

  /** Растягивает звено от (ax, ay) к (bx, by); overlap — на сколько оно заходит за концы отрезка. */
  public place(ax: number, ay: number, bx: number, by: number, overlap: number): void {
    const len = Math.hypot(bx - ax, by - ay) || 1e-6;
    this.sprite.position.set((ax + bx) / 2, (ay + by) / 2);
    this.sprite.rotation = Math.atan2(-(bx - ax), by - ay); // рисунок нитки вертикальный: «вниз» (+y) поворачиваем вдоль отрезка
    this.sprite.scale.set(1, (len + overlap) / this.sprite.texture.height);
  }
}

/** Капелька на конце нитки. */
function makeBead(parent: Container): Sprite {
  const bead = new Sprite(Texture.WHITE);
  bead.tint = 0xeaffff;
  bead.width = 2;
  bead.height = 3;
  parent.addChild(bead);
  return bead;
}

/**
 * Лиана под тайлом: цепочка (verlet) из паутинных звеньев, корень закреплён под тайлом. Физична: тяжесть, затухание, порывы ветра, а
 * герой, проходя сквозь неё, раздвигает звенья и раскачивает. Смещение узлов от вертикали ограничено, к тому же есть пружина возврата —
 * лиана не улетает. Звенья нитки рисуются в натуральную длину (длина лианы кратна шагу звена) — рисунок не сжимается.
 */
class Vine {
  public readonly minX: number;
  public readonly maxX: number;
  private readonly n: number; // узлов (без корня)
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pieces: Piece[] = [];
  private readonly bead: Sprite | null;
  private readonly side: Int8Array; // с какой стороны от героя узел (-1 слева, 1 справа, 0 — не задет): сторона не меняется, пока контакт идёт
  private calm = 0; // сколько ещё действует усиленное затухание после контакта с героем, с
  private readonly stuck: Float32Array; // сколько узел не может выбраться на свою сторону, с
  /** Есть ли рядом твёрдые клетки, в которые лиана может упереться: только такие лианы проверяют тайлы (остальные висят в пустоте). */
  private readonly collide: boolean;
  private readonly isSolid: (cx: number, cy: number) => boolean;
  private readonly ts: number;
  private readonly bias: number; // постоянный сквозняк (px/с², со знаком)
  private readonly freq: number; // у каждой лианы свой темп качания
  private readonly phase: number;
  private readonly ceilY: number; // нижняя грань тайла, из которого растёт лиана: выше неё узлам делать нечего

  /** pieceCount звеньев; корень (rx, ry) закреплён. */
  constructor(
    parent: Container, tex: Texture, private readonly rx: number, ry: number, pieceCount: number, tint: number, bead: boolean,
    isSolid: (cx: number, cy: number) => boolean, ts: number
  ) {
    this.isSolid = isSolid;
    this.ts = ts;
    this.ceilY = ry + 2.5;
    this.bias = (Math.random() < 0.5 ? -1 : 1) * (VINE_BIAS[0] + Math.random() * (VINE_BIAS[1] - VINE_BIAS[0]));
    this.freq = 0.75 + Math.random() * 0.6;
    this.phase = Math.random() * Math.PI * 2;
    this.n = pieceCount * 2;
    const size = this.n + 1;
    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.px = new Float32Array(size);
    this.py = new Float32Array(size);
    this.side = new Int8Array(size);
    this.stuck = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.x[i] = this.px[i] = rx;
      this.y[i] = this.py[i] = ry + i * VINE_NODE;
    }
    for (let i = 0; i < pieceCount; i++) this.pieces.push(new Piece(parent, tex, i === pieceCount - 1 && pieceCount > 1 ? 0.8 : 1, tint));
    this.bead = bead ? makeBead(parent) : null;
    const reach = this.n * VINE_NODE;
    this.minX = rx - reach;
    this.maxX = rx + reach;
    // область, куда лиана может дотянуться (отклонение ограничено): есть ли в ней твёрдые клетки (кроме клетки, из которой она растёт)
    const swing = reach + 2; // предела отклонения нет: лиана может дотянуться на всю длину
    let near = false;
    for (let cy = Math.floor((ry + VINE_NODE) / ts); cy <= Math.floor((ry + reach + 2) / ts) && !near; cy++) { // узлы начинаются ниже грани тайла
      for (let cx = Math.floor((rx - swing) / ts); cx <= Math.floor((rx + swing) / ts); cx++) {
        if (isSolid(cx, cy)) { near = true; break; }
      }
    }
    this.collide = near;
    this.render();
  }

  /** Узел внутри твёрдой клетки: выталкиваем на ближайшую свободную сторону клетки и гасим скорость по этой оси. */
  private pushOutOfTiles(i: number): void {
    const ts = this.ts;
    const x = this.x[i];
    const y = this.y[i];
    const cx = Math.floor(x / ts);
    const cy = Math.floor(y / ts);
    if (!this.isSolid(cx, cy)) return;
    const dl = this.isSolid(cx - 1, cy) ? Infinity : x - cx * ts;
    const dr = this.isSolid(cx + 1, cy) ? Infinity : (cx + 1) * ts - x;
    const du = this.isSolid(cx, cy - 1) ? Infinity : y - cy * ts;
    const dd = this.isSolid(cx, cy + 1) ? Infinity : (cy + 1) * ts - y;
    const m = Math.min(dl, dr, du, dd);
    if (m === Infinity) return;
    if (m === dl) { this.x[i] = cx * ts - 0.5; this.px[i] = this.x[i]; }
    else if (m === dr) { this.x[i] = (cx + 1) * ts + 0.5; this.px[i] = this.x[i]; }
    else if (m === du) { this.y[i] = cy * ts - 0.5; this.py[i] = this.y[i]; }
    else { this.y[i] = (cy + 1) * ts + 0.5; this.py[i] = this.y[i]; }
  }

  public update(dt: number, t: number, actors: readonly Actor[]): void {
    const h = Math.min(dt, 1 / 30) / VINE_SUBSTEPS;
    const calmK = Math.min(1, this.calm / CALM_TIME);
    const damp = Math.exp(-(VINE_DAMPING + CALM_DAMPING * calmK) * h);
    this.calm = Math.max(0, this.calm - Math.min(dt, 1 / 30));
    const n = this.n;
    const rx = this.rx;
    for (let step = 0; step < VINE_SUBSTEPS; step++) {
      for (let i = 1; i <= n; i++) {
        const k = Math.pow(i / n, 1.5); // чем ближе к концу, тем сильнее: нить изгибается дугой, а не качается целиком
        const f = this.freq;
        const wind = k * (
          VINE_WIND * (Math.sin(t * 0.9 * f + rx * 0.015 + this.phase + i * 0.3) + 0.6 * Math.sin(t * 2.3 * f + this.phase * 1.7 + i * 0.5)) + this.bias
        );
        const vx = (this.x[i] - this.px[i]) * damp;
        const vy = (this.y[i] - this.py[i]) * damp;
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        // пружина возврата к вертикали под корнем + ветер + тяжесть
        this.x[i] += vx + (wind - VINE_RETURN * (this.x[i] - rx)) * h * h;
        this.y[i] += vy + VINE_GRAVITY * h * h;
      }
      for (let it = 0; it < VINE_ITERATIONS; it++) {
        for (let i = 0; i < n; i++) {
          const dx = this.x[i + 1] - this.x[i];
          const dy = this.y[i + 1] - this.y[i];
          const dist = Math.hypot(dx, dy) || 1e-6;
          const diff = (dist - VINE_NODE) / dist;
          if (i === 0) {
            this.x[1] -= dx * diff; // корень неподвижен
            this.y[1] -= dy * diff;
          } else {
            this.x[i] += dx * diff * 0.5;
            this.y[i] += dy * diff * 0.5;
            this.x[i + 1] -= dx * diff * 0.5;
            this.y[i + 1] -= dy * diff * 0.5;
          }
        }
      }
      for (let i = 1; i <= n; i++) {
        if (this.y[i] < this.ceilY) { this.y[i] = this.ceilY; this.py[i] = this.ceilY; } // не заходит в тайл, из которого растёт
      }
      // герой — препятствие: узел в его хитбоксе плавно (с ограничением скорости) отодвигается к ближайшему краю и остаётся с этой стороны,
      // пока контакт идёт; если цепочка натянута и узел так не выбраться — он перетекает на другую сторону (по телу, без скачка)
      for (const a of actors) {
        if (a.right < this.minX || a.left > this.maxX) continue;
        const cx = (a.left + a.right) / 2;
        for (let i = 1; i <= n; i++) {
          const x = this.x[i];
          const y = this.y[i];
          const inside = y > a.top && y < a.bottom && x > a.left - ACTOR_PAD && x < a.right + ACTOR_PAD;
          if (!inside) { this.side[i] = 0; this.stuck[i] = 0; continue; }
          this.calm = CALM_TIME;
          if (this.side[i] === 0) this.side[i] = x < cx ? -1 : 1;
          // герой не оттягивает узел слишком далеко от корня: если пришлось бы тянуть дальше — узел уходит на другую сторону
          if (Math.sign(x - rx) === this.side[i] && Math.abs(x - rx) > i * VINE_NODE * REACH_FLIP) this.side[i] = -this.side[i] as -1 | 1;
          const target = this.side[i] < 0 ? a.left - ACTOR_PAD : a.right + ACTOR_PAD;
          const need = target - x;
          const move = Math.max(-PUSH_SPEED * h, Math.min(PUSH_SPEED * h, need));
          this.x[i] += move;
          this.px[i] += move - a.vx * CARRY * h; // смещение не превращается в скорость; узел немного увлекается ходом героя
          if (Math.abs(need) - Math.abs(move) > 1.5) {
            this.stuck[i] += h;
            if (this.stuck[i] > SIDE_STUCK) { this.side[i] = -this.side[i] as -1 | 1; this.stuck[i] = 0; }
          } else {
            this.stuck[i] = 0;
          }
        }
      }
      // стены и платформы: лиана их не пересекает (проверка — только у лиан рядом с твёрдыми клетками)
      if (this.collide) for (let i = 1; i <= n; i++) this.pushOutOfTiles(i);
    }
    this.render();
  }

  private render(): void {
    for (let i = 0; i < this.pieces.length; i++) {
      const a = 2 * i;
      this.pieces[i].place(this.x[a], this.y[a], this.x[a + 2], this.y[a + 2], 2); // 14 px узлов + 2 нахлёста = 16: звено в натуральную длину
    }
    if (this.bead) this.bead.position.set(this.x[this.n] - 1, this.y[this.n] + 1);
  }
}

/** Длинная нитка с неба — такая же, как у паучихи: верх закреплён над уровнем, низ свободно покачивается, нитка плавно течёт волнами. */
class SkyThread {
  public readonly minX: number;
  public readonly maxX: number;
  private readonly rope: ThreadRope;
  private readonly bead: Sprite | null;
  private time: number;
  private readonly top: { x: number; y: number };
  private readonly bottom: { x: number; y: number };

  constructor(
    parent: Container, tex: Texture, private readonly x: number, topY: number, bottomY: number, private readonly swing: number,
    private readonly speed: number, private readonly phase: number, bead: boolean
  ) {
    this.top = { x, y: topY };
    this.bottom = { x, y: bottomY };
    this.rope = new ThreadRope(tex, THREAD_CENTER_X, this.top, this.bottom);
    parent.addChild(this.rope.container);
    this.bead = bead ? makeBead(parent) : null;
    this.time = phase;
    this.minX = x - swing - 24;
    this.maxX = x + swing + 24;
  }

  public update(dt: number): void {
    this.time += dt;
    // свободный конец плавно качается — нитка запаздывает за ним (инерция ThreadRope) и течёт волнами
    this.bottom.x = this.x + this.swing * Math.sin(this.time * this.speed) + 0.4 * this.swing * Math.sin(this.time * this.speed * 2.3 + this.phase);
    this.rope.update(dt, this.top, this.bottom);
    if (this.bead) this.bead.position.set(this.bottom.x - 1, this.bottom.y);
  }
}

/**
 * Висящая паутина из нитки паучихи по зонам уровня (kind: "webs"):
 *  - лианы под нижними гранями тайлов: пучки физичных нитей разной длины (под тайлами, корень спрятан);
 *  - длинные нитки с неба — такие же, как у паучихи (закреплены над уровнем, где и она), свободно качаются; в зоне их тем больше, чем больше density.
 * Обновляется только то, что в обзоре.
 */
export class Webs {
  public readonly back = new Container();

  private readonly vines: Vine[] = [];
  private readonly sky: SkyThread[] = [];
  private readonly tex: Texture;
  private time = 0;

  constructor(
    sprites: SpriteLibrary, private readonly ts: number, private readonly width: number, private readonly height: number,
    private readonly isSolid: (cx: number, cy: number) => boolean
  ) {
    this.tex = sprites.texture(THREAD_SPRITE);
  }

  private solid(cx: number, cy: number): boolean {
    return cx >= 0 && cx < this.width && cy >= 0 && cy < this.height && this.isSolid(cx, cy);
  }

  /** Раскладывает паутину зоны; index — номер зоны (для детерминированного генератора). */
  public addZone(zone: DecorZoneDef, index: number): void {
    const rand = mulberry32(index * 7919 + 4421);
    const density = zone.density ?? 0.5;
    const ts = this.ts;
    const x0 = Math.max(0, zone.x0);
    const x1 = Math.min(this.width - 1, zone.x1);
    const y0 = Math.max(0, zone.y0);
    const y1 = Math.min(this.height - 1, zone.y1);

    // лианы под тайлами
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (this.solid(cx, cy) && !this.solid(cx, cy + 1) && cy + 1 < this.height && rand() < Math.min(1, density * 1.3)) this.addVines(cx, cy, rand);
      }
    }

    // длинные нитки с неба: по одной примерно на каждые 2–3 колонки зоны (по density), с неравномерными промежутками
    const topY = SKY_ANCHOR_ROW * ts;
    for (let cx = x0; cx <= x1; cx++) {
      if (rand() >= density * 0.55) continue;
      const x = cx * ts + 4 + rand() * (ts - 8);
      // конец — на случайной высоте в пределах зоны: нитка свисает и обрывается свободно (тайлы перекрывают её, она за ними)
      const swing = SKY_SWING[0] + rand() * (SKY_SWING[1] - SKY_SWING[0]);
      let bottomY = (y0 + rand() * (y1 - y0 + 1)) * ts;
      // нитка обрывается над первой твёрдой клеткой под ней (с учётом размаха качания), а не проходит сквозь платформу
      const cl = Math.floor((x - swing - 4) / ts);
      const cr = Math.floor((x + swing + 4) / ts);
      for (let cy = 0; cy < this.height; cy++) {
        let hit = false;
        for (let c = cl; c <= cr; c++) if (this.solid(c, cy)) hit = true;
        if (hit) { bottomY = Math.min(bottomY, cy * ts - SKY_CLEARANCE); break; }
      }
      if (bottomY - topY < 4 * ts) continue;
      const speed = SKY_SPEED[0] + rand() * (SKY_SPEED[1] - SKY_SPEED[0]);
      this.sky.push(new SkyThread(this.back, this.tex, x, topY, bottomY, swing, speed, rand() * Math.PI * 2, rand() < 0.5));
    }
  }

  /** Пучок лиан под нижней гранью тайла: 2–3 нити разной длины (кратной звену), длина — до следующего тайла. */
  private addVines(cx: number, cy: number, rand: () => number): void {
    const ts = this.ts;
    let room = 0;
    for (let y = cy + 1; y < this.height && !this.solid(cx, y); y++) room += ts;
    const maxPieces = Math.min(6, Math.floor((room - 6) / VINE_PIECE));
    if (maxPieces < 1) return;
    const count = 2 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const x = cx * ts + 4 + ((i + 0.3 + rand() * 0.4) * (ts - 8)) / count;
      const pieces = 1 + Math.floor(rand() * maxPieces);
      const tint = VINE_TINTS[Math.floor(rand() * VINE_TINTS.length)];
      this.vines.push(new Vine(this.back, this.tex, x, (cy + 1) * ts - 2, pieces, tint, rand() < 0.45, this.isSolid, ts));
    }
  }

  /** camLeft..camRight — видимый диапазон по x (мир). */
  public update(dt: number, camLeft: number, camRight: number, actors: readonly Actor[]): void {
    this.time += dt;
    const left = camLeft - VIEW_MARGIN;
    const right = camRight + VIEW_MARGIN;
    for (const v of this.vines) if (v.maxX >= left && v.minX <= right) v.update(dt, this.time, actors);
    for (const s of this.sky) if (s.maxX >= left && s.minX <= right) s.update(dt);
  }
}
