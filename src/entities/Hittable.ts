/** Круг попадания в мировых координатах. */
export interface HitCircle {
  x: number;
  y: number;
  r: number;
}

/** Твёрдый прямоугольник врага (мир): на него можно встать, сквозь него не пройти. key — кто это: по нему герой «едет» вместе с движущимся врагом. */
export interface SolidBox {
  key: object;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Прямоугольник, охватывающий круги (радиус умножается на shrink — твёрдое тело чуть меньше зоны попадания). */
export function boxOfCircles(key: object, circles: HitCircle[], shrink = 0.85): SolidBox | null {
  if (circles.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r * shrink); x1 = Math.max(x1, c.x + c.r * shrink);
    y0 = Math.min(y0, c.y - c.r * shrink); y1 = Math.max(y1, c.y + c.r * shrink);
  }
  return { key, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** То, по чему можно ударить и на что можно встать: враг отдаёт круги попадания, твёрдые коробки и реагирует на удар (направление — единичный вектор удара). */
export interface Hittable {
  hitCircles(): HitCircle[];
  solidBoxes(): SolidBox[];
  onHit(dirX: number, dirY: number): void;
}
