import { Container, Sprite, Texture } from 'pixi.js';

const OVERLAP = 1.4; // px: соседние сегменты слегка нахлёстывают друг на друга — на изгибе нет щелей

/**
 * Лапка с костями: рисунок режется на N сегментов вдоль оси «корень -> кончик», каждый сегмент — кость с суставом
 * на оси. Поза задаётся двумя числами: поворот у корня и суммарный изгиб к кончику; изгиб равномерно растёт вдоль
 * лапки, поэтому она сгибается плавной дугой (а не ломается в одном «колене»). В позе покоя (оба угла 0) сегменты
 * складываются в исходный рисунок без изменений.
 */
export class FlexLimb {
  /** Начало координат — корень лапки; спрайты сегментов лежат в системе контейнера. */
  public readonly container = new Container();

  private readonly n: number;
  private readonly segLen: number;
  private readonly axis: number; // угол оси корень -> кончик, y вниз
  private readonly segments: Sprite[] = [];

  /**
   * @param image пиксели слоя лапки (холст целиком)
   * @param root корень лапки в координатах холста
   * @param bones сколько костей (сегментов)
   */
  constructor(image: ImageData, root: { x: number; y: number }, bones: number) {
    this.n = Math.max(2, Math.round(bones));
    const { data, width, height } = image;

    // Кончик — самый дальний от корня непрозрачный пиксель
    let tipX = root.x;
    let tipY = root.y;
    let best = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        const d = Math.hypot(x + 0.5 - root.x, y + 0.5 - root.y);
        if (d > best) {
          best = d;
          tipX = x + 0.5;
          tipY = y + 0.5;
        }
      }
    }
    if (best <= 0) throw new Error('[FlexLimb] слой лапки пустой');

    const ux = (tipX - root.x) / best;
    const uy = (tipY - root.y) / best;
    this.axis = Math.atan2(uy, ux);
    this.segLen = best / this.n;

    for (let s = 0; s < this.n; s++) {
      const sprite = this.slice(image, root, ux, uy, s);
      this.segments.push(sprite);
      this.container.addChild(sprite);
    }
    this.setPose(0, 0);
  }

  /** Вырезает сегмент s: пиксели, чья координата вдоль оси попадает в [s*len, (s+1)*len + нахлёст). */
  private slice(image: ImageData, root: { x: number; y: number }, ux: number, uy: number, s: number): Sprite {
    const { data, width, height } = image;
    const t0 = s * this.segLen;
    const t1 = (s + 1) * this.segLen;
    const last = s === this.n - 1;

    const picked: number[] = [];
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        const t = (x + 0.5 - root.x) * ux + (y + 0.5 - root.y) * uy;
        if ((s === 0 || t >= t0) && (last || t < t1 + OVERLAP)) {
          picked.push(y * width + x);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    if (picked.length === 0) {
      return new Sprite(Texture.EMPTY);
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const out = ctx.createImageData(w, h);
    for (const i of picked) {
      const x = i % width;
      const y = (i - x) / width;
      const o = ((y - minY) * w + (x - minX)) * 4;
      out.data.set(data.subarray(i * 4, i * 4 + 4), o);
    }
    ctx.putImageData(out, 0, 0);

    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    const sprite = new Sprite(texture);
    // Сустав сегмента — точка на оси на расстоянии t0 от корня; поворачиваем вокруг неё
    sprite.pivot.set(root.x + ux * t0 - minX, root.y + uy * t0 - minY);
    return sprite;
  }

  /**
   * @param rootAngle поворот всей лапки у корня, рад
   * @param bend дополнительный изгиб, накопленный к кончику, рад (растёт равномерно по длине)
   */
  public setPose(rootAngle: number, bend: number): void {
    let jx = 0;
    let jy = 0;
    for (let i = 0; i < this.n; i++) {
      // угол сегмента: общий поворот + доля изгиба, растущая к кончику (середина сегмента)
      const a = rootAngle + bend * ((i + 0.5) / this.n);
      const sprite = this.segments[i];
      sprite.position.set(jx, jy);
      sprite.rotation = a;
      // следующий сустав — на оси, повёрнутой на a
      jx += Math.cos(this.axis + a) * this.segLen;
      jy += Math.sin(this.axis + a) * this.segLen;
    }
  }
}
