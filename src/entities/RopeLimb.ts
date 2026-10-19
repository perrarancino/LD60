import { Container, Matrix, Sprite, Texture } from 'pixi.js';

// Настройки физики каната
const STEP = 1 / 240; // с: фиксированный шаг физики — при неровных кадрах (разный dt) цепочка не раскачивается и не трясётся
const MAX_STEPS = 10; // шагов за кадр не больше (после лага)
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
const STRETCH_RELAX = 20; // 1/с: растянутая рука (удар) сжимается обратно к нарисованной длине, когда её отпускают

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
  private readonly axis: { ux: number; uy: number; pivot: { x: number; y: number } };

  // Мировые координаты точек цепочки (n + 1 точка) и их предыдущие положения
  private x: number[];
  private y: number[];
  private px: number[];
  private py: number[];
  private ready = false;
  private angles: number[] = [];
  private anglesReady = false;
  // Кинематический режим (хват, упор): дуга без физики. kin — степень перехода 0..1 от физической позы к дуге.
  private kinActive = false;
  private kin = 0;
  private kinFromX: number[] = [];
  private kinFromY: number[] = [];
  private kinFromAngles: number[] = [];
  private kinBlend = 0;
  private lastFacing = 0;
  private stretch = 1; // во сколько раз рука сейчас длиннее нарисованной (удар): сегменты растягиваются вдоль своей оси
  private stretched = false;
  private acc = 0; // накопленное время, ещё не прошедшее шагами физики

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
    this.axis = { ux, uy, pivot: { x: pivot.x, y: pivot.y } };

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

  /**
   * Другая раскраска руки (броня): те же пиксели формы (прозрачность не меняется), другие цвета — сегменты получают новые текстуры,
   * цепочка и поза остаются.
   */
  public setImage(image: ImageData): void {
    const { ux, uy, pivot } = this.axis;
    for (let s = 0; s < this.n; s++) {
      const fresh = this.sliceSegment(image, pivot, ux, uy, s);
      this.segments[s].sprite.texture = fresh.texture;
      fresh.destroy();
    }
  }

  /**
   * Герой развернулся (зеркалирование): отражаем цепочку относительно тела, чтобы руки сохранили положение в локальной
   * системе. Без этого поза покоя мгновенно «перекидывалась» через тело и руки яростно хлестали.
   */
  private syncFacing(frame: LimbFrame): void {
    if (this.lastFacing !== 0 && this.lastFacing !== frame.facing && this.ready) {
      for (let i = 0; i <= this.n; i++) {
        this.x[i] = 2 * frame.bodyX - this.x[i];
        this.px[i] = 2 * frame.bodyX - this.px[i];
        if (this.kinFromX[i] !== undefined) this.kinFromX[i] = -this.kinFromX[i];
      }
    }
    this.lastFacing = frame.facing;
  }

  /** Кисть (кончик руки) в мире — после последнего update/setKinematic. */
  public get tip(): { x: number; y: number } {
    return { x: this.x[this.n], y: this.y[this.n] };
  }

  /** Полная длина руки (плечо -> кисть), px. */
  public get length(): number {
    return this.segLen * this.n;
  }

  /**
   * Детерминированная поза без физики: плечо в (rootX, rootY), кисть в (tx, ty) (не дальше длины руки),
   * цепочка ложится на плавную дугу (сторона выгиба задаётся bend). Нет дрожи: результат зависит только от входов.
   * Переход из физической позы плавный (по умолчанию первые ~110 мс; blendRate — быстрее для резких движений вроде удара),
   * обратно — тоже: после последнего вызова update() подхватывает позу.
   */
  public setKinematic(
    dt: number, rootX: number, rootY: number, tx: number, ty: number, bend: 1 | -1, frame: LimbFrame, blendRate = 9, stretch = 1
  ): void {
    this.stretch = Math.max(1, stretch);
    this.syncFacing(frame);
    if (!this.ready) {
      for (let i = 0; i <= this.n; i++) { this.x[i] = this.px[i] = rootX; this.y[i] = this.py[i] = rootY; }
      this.ready = true;
    }
    if (!this.kinActive) {
      this.kinActive = true;
      this.kin = 0;
      // Исходная поза хранится относительно плеча: тело при этом движется, а рука не должна «отставать» в мире
      this.kinFromX = this.x.map((v) => v - this.x[0]);
      this.kinFromY = this.y.map((v) => v - this.y[0]);
      this.kinFromAngles = this.angles.slice();
    }
    this.kin = Math.min(1, this.kin + dt * blendRate);
    const blend = this.kin * this.kin * (3 - 2 * this.kin);
    this.kinBlend = blend;

    // Цель не дальше длины руки (с учётом растяжения)
    const total = this.length * this.stretch;
    let dx = tx - rootX;
    let dy = ty - rootY;
    let d = Math.hypot(dx, dy);
    const maxD = total * 0.985;
    if (d > maxD) { dx *= maxD / d; dy *= maxD / d; d = maxD; }
    // Слишком сильно сложенную руку не рисуем (дуга превращается в кольцо и «крутится»): минимум — 45% длины
    const minD = total * 0.45;
    if (d < minD) {
      const k = d < 1e-3 ? 0 : minD / d;
      dx = d < 1e-3 ? 0 : dx * k;
      dy = d < 1e-3 ? minD : dy * k;
      d = minD;
    }
    const ux = dx / d;
    const uy = dy / d;
    // Выгиб всегда в одну и ту же сторону относительно направления руки (bend — в локальной системе, при
    // зеркалировании сторона меняется): поза непрерывна при любом повороте руки — никаких «щелчков» выгиба
    const sign = bend * frame.facing;
    const nx = -uy * sign;
    const ny = ux * sign;

    // Дуга длиной total с хордой d: sin(th)/th = d/total
    const ratio = d / total;
    let th = 0;
    if (ratio < 0.9999) {
      let lo = 1e-4;
      let hi = Math.PI - 1e-3;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (Math.sin(mid) / mid > ratio) lo = mid; else hi = mid;
      }
      th = (lo + hi) / 2;
    }
    const R = th > 1e-4 ? total / (2 * th) : 0;

    for (let i = 0; i <= this.n; i++) {
      let along: number;
      let perp: number;
      if (R === 0) {
        along = (total * i) / this.n;
        perp = 0;
      } else {
        const phi = ((total * i) / this.n) / R - th;
        along = R * Math.sin(phi) + R * Math.sin(th);
        perp = R * Math.cos(phi) - R * Math.cos(th);
      }
      const ax = rootX + ux * along + nx * perp;
      const ay = rootY + uy * along + ny * perp;
      const fx = rootX + this.kinFromX[i];
      const fy = rootY + this.kinFromY[i];
      this.x[i] = fx + (ax - fx) * blend;
      this.y[i] = fy + (ay - fy) * blend;
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
    }
    this.render(frame, Math.min(dt, 1 / 30), true); // углы — прямо по точкам: переход без скачка, т.к. точки уже непрерывны
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
   * @param solid мировая точка твёрдая (тайл): точки руки в неё не заходят — остаются там, где были (регдолл, рука не проходит сквозь пол)
   */
  public update(
    dt: number, rootX: number, rootY: number, restAngle: number, stiffness: number, frame: LimbFrame,
    pin: { x: number; y: number } | null = null, solid: ((x: number, y: number) => boolean) | null = null
  ): void {
    const f = frame.facing;
    this.syncFacing(frame);
    this.stretch = 1 + (this.stretch - 1) * Math.exp(-STRETCH_RELAX * dt);
    if (this.stretch < 1.01) this.stretch = 1;
    const segLen = this.segLen * this.stretch;
    if (this.kinActive) {
      // Выход из кинематики: продолжаем с текущей позы, а скорость берём такой же, как у тела (плеча) —
      // иначе при быстром движении цепочка «отставала» бы и хлестала
      this.kinActive = false;
      this.kin = 0;
      const dxr = rootX - this.x[0];
      const dyr = rootY - this.y[0];
      const per = Math.max(1, Math.round(Math.min(dt, 1 / 30) / STEP)); // шагов за кадр — скорость плеча за шаг
      for (let i = 0; i <= this.n; i++) { this.px[i] = this.x[i] - dxr / per; this.py[i] = this.y[i] - dyr / per; }
    }
    // Желаемое направление в мире: зеркалирование по X
    const wx = f * Math.cos(restAngle);
    const wy = Math.sin(restAngle);

    if (!this.ready || Math.hypot(rootX - this.x[0], rootY - this.y[0]) > TELEPORT_DIST) {
      for (let i = 0; i <= this.n; i++) {
        this.x[i] = this.px[i] = rootX + wx * segLen * i;
        this.y[i] = this.py[i] = rootY + wy * segLen * i;
      }
      this.ready = true;
      this.anglesReady = false;
    }

    // Цель для кисти: точка хвата, но не дальше длины руки от плеча
    let pinX = 0;
    let pinY = 0;
    if (pin) {
      const reach = segLen * this.n * 0.985;
      let dx = pin.x - rootX;
      let dy = pin.y - rootY;
      const d = Math.hypot(dx, dy);
      if (d > reach) { dx *= reach / d; dy *= reach / d; }
      pinX = rootX + dx;
      pinY = rootY + dy;
    }

    // Фиксированный шаг: время копится, физика идёт целыми шагами STEP (одинаковыми при любом dt кадра)
    this.acc = Math.min(this.acc + Math.min(dt, 1 / 30), STEP * MAX_STEPS);
    const steps = Math.floor(this.acc / STEP);
    this.acc -= steps * STEP;
    if (steps === 0) {
      // в этом кадре шага нет — цепочка просто едет вместе с плечом
      const dx = rootX - this.x[0];
      const dy = rootY - this.y[0];
      for (let i = 0; i <= this.n; i++) { this.x[i] += dx; this.y[i] += dy; this.px[i] += dx; this.py[i] += dy; }
      this.render(frame, Math.min(dt, 1 / 30));
      return;
    }
    const h = STEP;
    const damp = Math.exp(-DAMPING * h);
    const maxStep = MAX_SPEED * h;
    const bend = Math.min(1, BEND_RATE * h);
    const rootStepX = (rootX - this.x[0]) / steps;
    const rootStepY = (rootY - this.y[0]) / steps;
    const tip = this.n;

    for (let step = 0; step < steps; step++) {
      // Плечо закреплено и двигается вместе с телом
      this.x[0] += rootStepX;
      this.y[0] += rootStepY;
      this.px[0] = this.x[0];
      this.py[0] = this.y[0];

      for (let i = 1; i <= this.n; i++) {
        const k = (STIFFNESS_ROOT + (STIFFNESS_TIP - STIFFNESS_ROOT) * ((i - 1) / this.n)) * stiffness;
        const tx = this.x[0] + wx * segLen * i;
        const ty = this.y[0] + wy * segLen * i;
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
        const sx = this.x[i] + (dx / d) * segLen;
        const sy = this.y[i] + (dy / d) * segLen;
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
          const diff = (dist - segLen) / dist;
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
      if (solid) {
        // точка вошла в тайл — возвращаем по той оси, по которой она вошла (скользит вдоль поверхности, а не застревает)
        for (let i = 1; i <= this.n; i++) {
          if (!solid(this.x[i], this.y[i])) continue;
          if (!solid(this.px[i], this.y[i])) this.x[i] = this.px[i];
          else if (!solid(this.x[i], this.py[i])) this.y[i] = this.py[i];
          else { this.x[i] = this.px[i]; this.y[i] = this.py[i]; }
          // упёрлась — скорость гасится (не пружинит обратно в тайл и не дрожит у поверхности)
          this.px[i] = this.x[i];
          this.py[i] = this.y[i];
        }
      }
    }

    this.render(frame, Math.min(dt, 1 / 30));
  }

  /** Сегмент растянут вдоль оси руки в stretch раз (в картинке: масштаб вдоль оси, поперёк — как был), затем повёрнут в позу. */
  private stretchSegment(sprite: Sprite, x: number, y: number, rot: number): void {
    const k = this.stretch - 1;
    const ca = Math.cos(this.axisAngle);
    const sa = Math.sin(this.axisAngle);
    const s00 = 1 + k * ca * ca;
    const s01 = k * ca * sa;
    const s11 = 1 + k * sa * sa;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const a = cr * s00 - sr * s01;
    const c = cr * s01 - sr * s11;
    const b = sr * s00 + cr * s01;
    const d = sr * s01 + cr * s11;
    const { x: px, y: py } = sprite.pivot;
    sprite.setFromMatrix(new Matrix(a, b, c, d, x - (px * a + py * c), y - (px * b + py * d)));
  }

  /** Переносит мировые точки цепочки в сегменты-спрайты (углы сглажены). */
  private render(frame: LimbFrame, dt: number, snap = false): void {
    const f = frame.facing;
    for (let i = 0; i < this.n; i++) {
      const lx = (this.x[i] - frame.bodyX) * f;
      const ly = this.y[i] - frame.bodyY;
      const nx = (this.x[i + 1] - frame.bodyX) * f;
      const ny = this.y[i + 1] - frame.bodyY;
      let target = Math.atan2(ny - ly, nx - lx);
      if (i > 0 && !snap) {
        // «Трубка»: сегмент не изгибается резко относительно предыдущего (уже сглаженного)
        const dPrev = Math.atan2(Math.sin(target - this.angles[i - 1]), Math.cos(target - this.angles[i - 1]));
        target = this.angles[i - 1] + dPrev * (1 - PIPE_BEND);
      }
      if (!this.anglesReady) {
        this.angles[i] = target;
      } else if (snap) {
        // Кинематика: угол прямо по точкам, но на входе плавно уходим от последнего физического угла
        const from = this.kinFromAngles[i] ?? target;
        const dd = Math.atan2(Math.sin(target - from), Math.cos(target - from));
        this.angles[i] = from + dd * this.kinBlend;
      } else {
        // К кисти сглаживание сильнее: на конце цепочки шум максимален
        const rate = ANGLE_SMOOTH * (1 - 0.6 * (i / Math.max(1, this.n - 1)));
        let diff = target - this.angles[i];
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // кратчайший путь через ±π
        this.angles[i] += diff * (1 - Math.exp(-rate * dt));
      }
      const sprite = this.segments[i].sprite;
      const rot = this.angles[i] - this.axisAngle;
      if (this.stretch > 1) {
        this.stretchSegment(sprite, lx, ly, rot);
      } else {
        if (this.stretched) sprite.skew.set(0, 0);
        sprite.scale.set(1, 1);
        sprite.position.set(lx, ly);
        sprite.rotation = rot;
      }
    }
    this.stretched = this.stretch > 1;
    this.anglesReady = true;
  }
}
