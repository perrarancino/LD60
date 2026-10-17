import { Container, Sprite } from 'pixi.js';

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Двухфаланговая нога с настоящим двухкостным IK: верхняя кость (бедро -> колено) и нижняя (колено -> стопа) — это
 * два отдельных слоя рисунка. Геометрию задаёт рисунок: где бедро, колено и стопа в «позе по умолчанию» (hip0, knee0, foot0).
 * Для заданных бедра и стопы колено считается по теореме косинусов (выше всех по «верху» тела), каждый спрайт
 * поворачивается вокруг своего сустава — пиксели рисунка не пересэмплируются, только поворачиваются.
 */
export class TwoBoneLeg {
  public readonly container = new Container();

  private readonly upper: Sprite;
  private readonly lower: Sprite;
  private readonly l1: number; // длина верхней кости
  private readonly l2: number; // длина нижней кости
  private readonly upperAngle0: number; // направление бедро -> колено в рисунке
  private readonly lowerAngle0: number; // направление колено -> стопа в рисунке

  /** Положение колена после последнего update (в системе тела) — на случай, если нужно знать, где оно. */
  public knee: Vec2 = { x: 0, y: 0 };

  /**
   * @param upper, lower спрайты слоёв (полный холст), без привязки
   * @param hip0, knee0, foot0 суставы в координатах холста (px) в позе из рисунка
   */
  constructor(upper: Sprite, lower: Sprite, hip0: Vec2, knee0: Vec2, foot0: Vec2) {
    this.upper = upper;
    this.lower = lower;
    this.upper.pivot.set(hip0.x, hip0.y);
    this.lower.pivot.set(knee0.x, knee0.y);
    this.container.addChild(this.upper, this.lower);

    this.l1 = Math.hypot(knee0.x - hip0.x, knee0.y - hip0.y);
    this.l2 = Math.hypot(foot0.x - knee0.x, foot0.y - knee0.y);
    this.upperAngle0 = Math.atan2(knee0.y - hip0.y, knee0.x - hip0.x);
    this.lowerAngle0 = Math.atan2(foot0.y - knee0.y, foot0.x - knee0.x);
  }

  /** Полная длина ноги (вытянутой). */
  public get reach(): number {
    return this.l1 + this.l2;
  }

  /**
   * @param hip бедро в системе тела (начало — якорь, «вверх» — отрицательный y)
   * @param foot стопа в системе тела
   */
  public update(hip: Vec2, foot: Vec2): void {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const dist = Math.hypot(dx, dy);
    const ux = dist > 1e-4 ? dx / dist : 0;
    const uy = dist > 1e-4 ? dy / dist : 1;

    // Расстояние бедро-стопа ограничено длинами костей (нога не растягивается и не «складывается» в точку)
    const dMax = this.l1 + this.l2 - 0.01;
    const dMin = Math.abs(this.l1 - this.l2) + 0.01;
    const d = Math.max(dMin, Math.min(dMax, dist));

    // Теорема косинусов: проекция колена на линию бедро-стопа и высота над ней
    const a = (this.l1 * this.l1 - this.l2 * this.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.l1 * this.l1 - a * a));
    const px = hip.x + ux * a;
    const py = hip.y + uy * a;
    const nx = -uy;
    const ny = ux;
    const k1 = { x: px + nx * h, y: py + ny * h };
    const k2 = { x: px - nx * h, y: py - ny * h };
    // колено — «вверх» от тела (меньший y), как у паука
    const knee = k1.y < k2.y ? k1 : k2;
    this.knee = knee;

    const footX = hip.x + ux * d;
    const footY = hip.y + uy * d;
    this.upper.position.set(hip.x, hip.y);
    this.upper.rotation = Math.atan2(knee.y - hip.y, knee.x - hip.x) - this.upperAngle0;
    this.lower.position.set(knee.x, knee.y);
    this.lower.rotation = Math.atan2(footY - knee.y, footX - knee.x) - this.lowerAngle0;
  }
}
