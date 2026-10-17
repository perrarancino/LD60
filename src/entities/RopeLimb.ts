import { Container, Sprite, Texture } from 'pixi.js';

// Настройки физики каната
const SUBSTEPS = 3; // подшагов на кадр — устойчивость при больших dt
const ITERATIONS = 4; // итераций ограничений длины на подшаг
const GRAVITY = 520; // px/с²
const STIFFNESS_ROOT = 420; // сила возврата к позе покоя у плеча, 1/с²
const STIFFNESS_TIP = 160; // у кисти (мягче -> болтается сильнее)
const DAMPING = 14; // затухание скорости, 1/с (близко к критическому — без «дрожи»)
const BEND_RATE = 26; // 1/с: каждый сегмент тянется продолжить направление предыдущего — плавный изгиб «трубки»/нити
const PIPE_BEND = 0.3; // доля поворота сегмента относительно предыдущего, которая «срезается» (0 — как есть)
const ANGLE_SMOOTH = 28; // 1/с: сглаживание поворота сегментов, убирает мелкую дрожь кисти
const MAX_SPEED = 260; // px/с: потолок скорости точек, гасит выбросы
const OVERLAP = 1.6; // px: сегменты слегка нахлёстывают друг на друга, чтобы на изгибе не было щелей
const TELEPORT_DIST = 90; // если плечо «улетело» дальше — сбрасываем цепочку

interface Segment {
  sprite: Sprite;
}

/** Положение героя в мире: позволяет переводить мировые координаты в локальные координаты зеркалируемого контейнера. */
export interface LimbFrame {
  bodyX: number;
  bodyY: number;
  facing: 1 | -1;
}

/**
 * Рука-канат: исходный слой-картинка режется на N сегментов вдоль своей оси, а положение сегментов
 * считается verlet-цепочкой (плечо закреплено, остальное инерционно болтается и тянется к позе покоя).
 * Пиксели рисунка не пересэмплируются: в позе покоя рука выглядит ровно как нарисована, при изгибе
 * каждый сегмент просто поворачивается вокруг своего сустава.
 */
export class RopeLimb {
  /** Спрайты сегментов; координаты — в системе контейнера рига (начало в точке привязки тела). */
  public readonly container = new Container();

  private readonly n: number;
  private readonly segLen: number;
  private readonly axisAngle: number; // угол оси исходной картинки (плечо -> кисть), y вниз
  private readonly segments: Segment[] = [];

  // Мировые координаты точек цепочки (n + 1 точка) и их предыдущие положения
  private x: number[];
  private y: number[];
  private px: number[];
  private py: number[];
  private ready = false;
  private angles: number[] = [];
  private anglesReady = false;

  /**
   * @param image пиксели слоя (холст целиком)
   * @param pivot плечо в координатах холста
   */
  constructor(image: ImageData, pivot: { x: number; y: number }, segments: number) {
    this.n = Math.max(1, Math.round(segments));
    const { data, width, height } = image;

    // Ось руки: от плеча к самому дальнему непрозрачному пикселю (кисти)
    let tipX = pivot.x;
    let tipY = pivot.y;
    let best = -1;
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        if (data[(yy * width + xx) * 4 + 3] === 0) continue;
        const d = Math.hypot(xx + 0.5 - pivot.x, yy + 0.5 - pivot.y);
        if (d > best) {
          best = d;
          tipX = xx + 0.5;
          tipY = yy + 0.5;
        }
      }
    }
    if (best <= 0) throw new Error('[RopeLimb] слой руки пустой');

    const ux = (tipX - pivot.x) / best;
    const uy = (tipY - pivot.y) / best;
    this.axisAngle = Math.atan2(uy, ux);
    this.segLen = best / this.n;

    for (let s = 0; s < this.n; s++) {
      this.segments.push({ sprite: this.sliceSegment(image, pivot, ux, uy, s) });
    }
    // Рисуем от плеча к кисти: дальние сегменты поверх ближних
    for (const seg of this.segments) this.container.addChild(seg.sprite);

    this.x = new Array(this.n + 1).fill(0);
    this.y = new Array(this.n + 1).fill(0);
    this.px = new Array(this.n + 1).fill(0);
    this.py = new Array(this.n + 1).fill(0);
  }

  /** Угол оси руки в исходном рисунке — поза покоя «как нарисовано». */
  public get drawnAngle(): number {
    return this.axisAngle;
  }

  /** Вырезает пиксели сегмента s (с небольшим нахлёстом вперёд) в отдельную текстуру. */
  private sliceSegment(image: ImageData, pivot: { x: number; y: number }, ux: number, uy: number, s: number): Sprite {
    const { data, width, height } = image;
    const t0 = s * this.segLen;
    const t1 = (s + 1) * this.segLen;
    const last = s === this.n - 1;

    const picked: number[] = []; // индексы пикселей
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        if (data[(yy * width + xx) * 4 + 3] === 0) continue;
        const t = (xx + 0.5 - pivot.x) * ux + (yy + 0.5 - pivot.y) * uy; // координата вдоль оси
        if ((s === 0 || t >= t0) && (last || t < t1 + OVERLAP)) {
          picked.push(yy * width + xx);
          minX = Math.min(minX, xx); maxX = Math.max(maxX, xx);
          minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
        }
      }
    }

    const w = Math.max(1, maxX - minX + 1);
    const h = Math.max(1, maxY - minY + 1);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const out = ctx.createImageData(w, h);
    for (const i of picked) {
      const xx = i % width;
      const yy = (i - xx) / width;
      const o = ((yy - minY) * w + (xx - minX)) * 4;
      out.data[o] = data[i * 4];
      out.data[o + 1] = data[i * 4 + 1];
      out.data[o + 2] = data[i * 4 + 2];
      out.data[o + 3] = data[i * 4 + 3];
    }
    ctx.putImageData(out, 0, 0);

    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    const sprite = new Sprite(texture);
    // Сустав сегмента — точка на оси на расстоянии t0 от плеча; поворачиваем вокруг неё
    sprite.pivot.set(pivot.x + ux * t0 - minX, pivot.y + uy * t0 - minY);
    return sprite;
  }

  /**
   * @param dt шаг времени, с
   * @param rootX плечо, мир
   * @param restAngle желаемое направление руки в локальной (зеркалируемой) системе, рад, y вниз
   * @param stiffness множитель силы возврата к позе (1 — обычная, больше — «собранная» рука)
   * @param pin мировая точка, к которой жёстко прикреплена кисть (хват за уступ); null — рука свободна.
   *   Если точка дальше длины руки, кисть тянется к ней в пределах досягаемости.
   */
  public update(
    dt: number, rootX: number, rootY: number, restAngle: number, stiffness: number, frame: LimbFrame,
    pin: { x: number; y: number } | null = null
  ): void {
    const f = frame.facing;
    // Желаемое направление в мире: зеркалирование по X
    const wx = f * Math.cos(restAngle);
    const wy = Math.sin(restAngle);

    if (!this.ready || Math.hypot(rootX - this.x[0], rootY - this.y[0]) > TELEPORT_DIST) {
      for (let i = 0; i <= this.n; i++) {
        this.x[i] = this.px[i] = rootX + wx * this.segLen * i;
        this.y[i] = this.py[i] = rootY + wy * this.segLen * i;
      }
      this.ready = true;
      this.anglesReady = false;
    }

    // Цель для кисти: точка хвата, но не дальше длины руки от плеча
    let pinX = 0;
    let pinY = 0;
    if (pin) {
      const reach = this.segLen * this.n * 0.985;
      let dx = pin.x - rootX;
      let dy = pin.y - rootY;
      const d = Math.hypot(dx, dy);
      if (d > reach) { dx *= reach / d; dy *= reach / d; }
      pinX = rootX + dx;
      pinY = rootY + dy;
    }

    const h = Math.min(dt, 1 / 30) / SUBSTEPS;
    const damp = Math.exp(-DAMPING * h);
    const maxStep = MAX_SPEED * h;
    const bend = Math.min(1, BEND_RATE * h);
    const rootStepX = (rootX - this.x[0]) / SUBSTEPS;
    const rootStepY = (rootY - this.y[0]) / SUBSTEPS;
    const tip = this.n;

    for (let step = 0; step < SUBSTEPS; step++) {
      // Плечо закреплено и двигается вместе с телом
      this.x[0] += rootStepX;
      this.y[0] += rootStepY;
      this.px[0] = this.x[0];
      this.py[0] = this.y[0];

      for (let i = 1; i <= this.n; i++) {
        const k = (STIFFNESS_ROOT + (STIFFNESS_TIP - STIFFNESS_ROOT) * ((i - 1) / this.n)) * stiffness;
        const tx = this.x[0] + wx * this.segLen * i;
        const ty = this.y[0] + wy * this.segLen * i;
        let vx = (this.x[i] - this.px[i]) * damp;
        let vy = (this.y[i] - this.py[i]) * damp;
        const sp = Math.hypot(vx, vy);
        if (sp > maxStep) { vx *= maxStep / sp; vy *= maxStep / sp; }
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        this.x[i] += vx + k * (tx - this.x[i]) * h * h;
        this.y[i] += vy + (GRAVITY + k * (ty - this.y[i])) * h * h;
      }

      // Изгиб как у трубки: точка i+1 стремится лечь на продолжение предыдущего сегмента
      for (let i = 1; i < this.n; i++) {
        const dx = this.x[i] - this.x[i - 1];
        const dy = this.y[i] - this.y[i - 1];
        const d = Math.hypot(dx, dy) || 1e-6;
        const sx = this.x[i] + (dx / d) * this.segLen;
        const sy = this.y[i] + (dy / d) * this.segLen;
        this.x[i + 1] += (sx - this.x[i + 1]) * bend;
        this.y[i + 1] += (sy - this.y[i + 1]) * bend;
      }

      if (pin) {
        this.x[tip] = this.px[tip] = pinX;
        this.y[tip] = this.py[tip] = pinY;
      }

      // Ограничения длины сегментов: плечо (и кисть при хвате) неподвижны
      for (let it = 0; it < ITERATIONS; it++) {
        for (let i = 0; i < this.n; i++) {
          const dx = this.x[i + 1] - this.x[i];
          const dy = this.y[i + 1] - this.y[i];
          const dist = Math.hypot(dx, dy) || 1e-6;
          const diff = (dist - this.segLen) / dist;
          const wa = i === 0 ? 0 : 1;
          const wb = pin && i + 1 === tip ? 0 : 1;
          const sum = wa + wb;
          if (sum === 0) continue;
          this.x[i] += (dx * diff * wa) / sum;
          this.y[i] += (dy * diff * wa) / sum;
          this.x[i + 1] -= (dx * diff * wb) / sum;
          this.y[i + 1] -= (dy * diff * wb) / sum;
        }
      }
    }

    this.render(frame, Math.min(dt, 1 / 30));
  }

  /** Переносит мировые точки цепочки в сегменты-спрайты (углы сглажены). */
  private render(frame: LimbFrame, dt: number): void {
    const f = frame.facing;
    for (let i = 0; i < this.n; i++) {
      const lx = (this.x[i] - frame.bodyX) * f;
      const ly = this.y[i] - frame.bodyY;
      const nx = (this.x[i + 1] - frame.bodyX) * f;
      const ny = this.y[i + 1] - frame.bodyY;
      let target = Math.atan2(ny - ly, nx - lx);
      if (i > 0) {
        // «Трубка»: сегмент не изгибается резко относительно предыдущего (уже сглаженного)
        const dPrev = Math.atan2(Math.sin(target - this.angles[i - 1]), Math.cos(target - this.angles[i - 1]));
        target = this.angles[i - 1] + dPrev * (1 - PIPE_BEND);
      }
      if (!this.anglesReady) this.angles[i] = target;
      // К кисти сглаживание сильнее: на конце цепочки шум максимален
      const rate = ANGLE_SMOOTH * (1 - 0.6 * (i / Math.max(1, this.n - 1)));
      let diff = target - this.angles[i];
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // кратчайший путь через ±π
      this.angles[i] += diff * (1 - Math.exp(-rate * dt));
      const sprite = this.segments[i].sprite;
      sprite.position.set(lx, ly);
      sprite.rotation = this.angles[i] - this.axisAngle;
    }
    this.anglesReady = true;
  }
}
