/** Круг попадания в мировых координатах. part — номер части тела (у существ из частей: червь, босс), по нему удар узнаёт, куда попал. */
export interface HitCircle {
  x: number;
  y: number;
  r: number;
  part?: number;
}

/** То, по чему можно ударить: враг отдаёт круги попадания и реагирует на удар (направление — единичный вектор удара). */
export interface Hittable {
  hitCircles(): HitCircle[];
  onHit(dirX: number, dirY: number, part?: number): void;
}

/** Результат урона по части: часть цела / часть выбита / погибло всё существо (когда выбита голова). */
export type PartDamageResult = 'hit' | 'killed' | 'dead';

/** Существо из частей с отдельным здоровьем у каждой (червь, босс-червь): урон идёт в ту часть, в которую попал удар. */
export interface PartDamageable extends Hittable {
  damagePart(part: number, amount: number): PartDamageResult;
}

export function isPartDamageable(t: Hittable): t is PartDamageable {
  return typeof (t as Partial<PartDamageable>).damagePart === 'function';
}
