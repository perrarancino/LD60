/** Круг попадания в мировых координатах. */
export interface HitCircle {
  x: number;
  y: number;
  r: number;
}

/** То, по чему можно ударить: враг отдаёт круги попадания и реагирует на удар (направление — единичный вектор удара). */
export interface Hittable {
  hitCircles(): HitCircle[];
  onHit(dirX: number, dirY: number): void;
}
