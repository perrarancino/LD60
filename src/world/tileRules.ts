import type { Slope, TileDef, TileXformDef } from '../data/types.ts';

/**
 * Правила тайлов, общие для игры (Level.ts) и редактора уровней: какой кадр рисуется в клетке и как поворот/отражение
 * меняют рисунок и наклон скоса. Так редактор показывает ровно то, что потом увидит игра.
 */

/** Окружение клетки: что стоит в соседях (для выбора кадра). */
export interface TileEnv {
  tileAt: (cx: number, cy: number) => TileDef | undefined;
  solidAt: (cx: number, cy: number) => boolean;
}

export interface TileVisual {
  sprite_id: string;
  frame: number;
}

/** Какой спрайт и кадр рисуется в клетке (cx, cy) для тайла tile. */
export function tileVisual(tile: TileDef, cx: number, cy: number, env: TileEnv): TileVisual {
  const under = cy > 0 && env.solidAt(cx, cy - 1);
  if ((tile.top_frames || tile.fill_frames) && !tile.slope) {
    // Лист вариантов (textalite): сверху — кадры верхнего слоя, в толще — кадры заливки; вариант выбирается по клетке, всегда один и тот же
    const pool = (under ? tile.fill_frames : tile.top_frames) ?? tile.top_frames ?? tile.fill_frames!;
    return { sprite_id: tile.sprite_id, frame: pool[(((cx * 73856093) ^ (cy * 19349663)) >>> 0) % pool.length] };
  }
  if (tile.fill_sprite_id && under && !tile.slope) {
    // Под верхним слоем (стена, толща): заливка вместо рамки основного тайла
    return { sprite_id: tile.fill_sprite_id, frame: 0 };
  }
  let frame = 0;
  if (tile.loop_frames && tile.loop_frames >= 3) {
    // Платформа из трёх кадров: левый край (0), середина (1, повторяется), правый край (2). Одиночный тайл (стенка) — середина.
    const left = env.tileAt(cx - 1, cy) === tile;
    const right = env.tileAt(cx + 1, cy) === tile;
    frame = left && right ? 1 : right ? 0 : left ? tile.loop_frames - 1 : 1;
  }
  return { sprite_id: tile.sprite_id, frame };
}

// ---------- Поворот и отражение ----------

export interface XformSteps {
  sx: 1 | -1; // масштаб рисунка по x (отражение)
  sy: 1 | -1;
  quarter: 0 | 1 | 2 | 3; // поворот по часовой стрелке, четвертей оборота
}

/** Нормализованное преобразование: отражения, затем поворот. */
export function xformSteps(x: Pick<TileXformDef, 'flip_x' | 'flip_y' | 'rot'> | undefined): XformSteps {
  const rot = x?.rot ?? 0;
  const quarter = ((((Math.round(rot / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3);
  return { sx: x?.flip_x ? -1 : 1, sy: x?.flip_y ? -1 : 1, quarter };
}

export function isIdentityXform(x: Pick<TileXformDef, 'flip_x' | 'flip_y' | 'rot'> | undefined): boolean {
  if (!x) return true;
  const s = xformSteps(x);
  return s.sx === 1 && s.sy === 1 && s.quarter === 0;
}

// Угол клетки, в котором лежит «твёрдая» половина скоса (x вправо, y вниз)
const SLOPE_CORNER: Record<Slope, [number, number]> = {
  up_right: [1, 1],
  up_left: [-1, 1],
  ceil_right: [1, -1],
  ceil_left: [-1, -1]
};

function cornerSlope(x: number, y: number): Slope {
  if (y > 0) return x > 0 ? 'up_right' : 'up_left';
  return x > 0 ? 'ceil_right' : 'ceil_left';
}

/** Скос после поворота/отражения клетки: твёрдая половина переезжает в другой угол. */
export function transformSlope(slope: Slope, x: Pick<TileXformDef, 'flip_x' | 'flip_y' | 'rot'> | undefined): Slope {
  const s = xformSteps(x);
  let [cx, cy] = SLOPE_CORNER[slope];
  cx *= s.sx;
  cy *= s.sy;
  for (let i = 0; i < s.quarter; i++) [cx, cy] = [-cy, cx]; // 90° по часовой стрелке при оси y вниз
  return cornerSlope(cx, cy);
}

/** Ключ клетки в словаре преобразований. */
export const cellKey = (cx: number, cy: number) => `${cx},${cy}`;

/** Словарь преобразований клеток по списку level.tile_xform (единичные не хранятся). */
export function xformMap(list: readonly TileXformDef[] | undefined): Map<string, TileXformDef> {
  const map = new Map<string, TileXformDef>();
  for (const t of list ?? []) if (!isIdentityXform(t)) map.set(cellKey(t.x, t.y), t);
  return map;
}
