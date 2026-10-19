import type { LevelDef, RoomDef, TileXformDef } from '../data/types.ts';
import { xformSteps } from '../world/tileRules.ts';

/**
 * Модель уровня для редактора: все операции над LevelDef (то, что лежит в data/levels/*.json). Редактор не держит отдельной копии —
 * правит сам LevelDef через эти функции, поэтому на диск уходит ровно то, что видит игра.
 */

export const EMPTY_CHAR = '.';
const LEGEND_CHARS = '#@%&$ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function inBounds(def: LevelDef, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < def.width && y < def.height;
}

// ---------- Тайлы ----------

/** Id тайла в клетке (null — пусто или за границей). */
export function tileIdAt(def: LevelDef, x: number, y: number): string | null {
  if (!inBounds(def, x, y)) return null;
  const ch = def.rows[y]?.[x] ?? EMPTY_CHAR;
  return def.legend[ch] ?? null;
}

/** Символ legend для тайла (создаёт, если такого ещё нет). */
function charFor(def: LevelDef, id: string): string {
  for (const [ch, v] of Object.entries(def.legend)) if (v === id) return ch;
  const ch = [...LEGEND_CHARS].find((c) => !(c in def.legend)) ?? '?';
  def.legend[ch] = id;
  return ch;
}

export function setTile(def: LevelDef, x: number, y: number, id: string | null): void {
  if (!inBounds(def, x, y)) return;
  if (!(EMPTY_CHAR in def.legend)) def.legend[EMPTY_CHAR] = null;
  const ch = id === null ? EMPTY_CHAR : charFor(def, id);
  const row = def.rows[y];
  if (row[x] !== ch) def.rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

/** Убирает из legend символы, которых нет в rows. */
export function pruneLegend(def: LevelDef): void {
  const used = new Set(def.rows.join(''));
  for (const ch of Object.keys(def.legend)) if (!used.has(ch) && ch !== EMPTY_CHAR) delete def.legend[ch];
  if (!(EMPTY_CHAR in def.legend)) def.legend[EMPTY_CHAR] = null;
}

// ---------- Поворот и отражение тайлов ----------

export type Xf = { flip_x?: boolean; flip_y?: boolean; rot?: number };
export type CanonXf = { flip_x: boolean; rot: number };

/** Каноническая форма: отражение только по x (flip_y = flip_x + поворот на 180°), поворот 0/90/180/270. */
export function canonXf(x: Xf | undefined): CanonXf {
  const s = xformSteps(x);
  let flip = s.sx < 0;
  let rot = s.quarter * 90;
  if (s.sy < 0) {
    flip = !flip;
    rot = (rot + 180) % 360;
  }
  return { flip_x: flip, rot };
}

export const isXfIdentity = (x: Xf | undefined) => {
  const c = canonXf(x);
  return !c.flip_x && c.rot === 0;
};

/** Отразить по горизонтали на экране: рисунок в клетке (уже повёрнутый) зеркалится. */
export function xfMirrorH(x: Xf | undefined): CanonXf {
  const c = canonXf(x);
  return { flip_x: !c.flip_x, rot: (360 - c.rot) % 360 };
}

/** Отразить по вертикали на экране: зеркало по горизонтали и поворот на 180°. */
export function xfMirrorV(x: Xf | undefined): CanonXf {
  const h = xfMirrorH(x);
  return { flip_x: h.flip_x, rot: (h.rot + 180) % 360 };
}

/** Повернуть на экране на 90° по часовой стрелке (times раз). */
export function xfRotate(x: Xf | undefined, times = 1): CanonXf {
  const c = canonXf(x);
  return { flip_x: c.flip_x, rot: (((c.rot + 90 * times) % 360) + 360) % 360 };
}

export function getXform(def: LevelDef, x: number, y: number): TileXformDef | undefined {
  return def.tile_xform?.find((t) => t.x === x && t.y === y);
}

/** Записывает преобразование клетки (единичное удаляет запись). */
export function setXform(def: LevelDef, x: number, y: number, xf: Xf | undefined): void {
  const list = def.tile_xform ?? [];
  const i = list.findIndex((t) => t.x === x && t.y === y);
  const c = xf ? canonXf(xf) : null;
  if (!c || (!c.flip_x && c.rot === 0)) {
    if (i >= 0) list.splice(i, 1);
  } else {
    const rec: TileXformDef = { x, y };
    if (c.flip_x) rec.flip_x = true;
    if (c.rot) rec.rot = c.rot;
    if (i >= 0) list[i] = rec;
    else list.push(rec);
  }
  if (list.length) def.tile_xform = list;
  else delete def.tile_xform;
}

// ---------- Комнаты ----------

export const ROOM_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#c084fc', '#fb923c', '#2dd4bf', '#f87171', '#a3e635', '#818cf8'];

export function roomHas(room: RoomDef, x: number, y: number): boolean {
  const lx = x - room.x;
  const ly = y - room.y;
  if (lx < 0 || ly < 0 || lx >= room.width || ly >= room.height) return false;
  if (!room.mask) return true;
  const ch = room.mask[ly]?.[lx];
  return ch === '#' || ch === '1';
}

function materializeMask(room: RoomDef): void {
  if (room.mask) return;
  room.mask = Array.from({ length: room.height }, () => '#'.repeat(room.width));
}

/** Добавляет/убирает клетку у комнаты (границы подрастают сами). */
export function roomSet(room: RoomDef, x: number, y: number, on: boolean): void {
  if (on === roomHas(room, x, y)) return;
  if (on && (room.width <= 0 || room.height <= 0)) {
    // пустая комната: границы — эта единственная клетка
    room.x = x;
    room.y = y;
    room.width = 1;
    room.height = 1;
    room.mask = ['#'];
    return;
  }
  materializeMask(room);
  if (on && (x < room.x || y < room.y || x >= room.x + room.width || y >= room.y + room.height)) {
    const nx0 = Math.min(room.x, x);
    const ny0 = Math.min(room.y, y);
    const nx1 = Math.max(room.x + room.width, x + 1);
    const ny1 = Math.max(room.y + room.height, y + 1);
    const mask: string[] = [];
    for (let cy = ny0; cy < ny1; cy++) {
      let row = '';
      for (let cx = nx0; cx < nx1; cx++) row += roomHas(room, cx, cy) ? '#' : '.';
      mask.push(row);
    }
    room.x = nx0;
    room.y = ny0;
    room.width = nx1 - nx0;
    room.height = ny1 - ny0;
    room.mask = mask;
  }
  const lx = x - room.x;
  const ly = y - room.y;
  const row = room.mask![ly];
  room.mask![ly] = row.slice(0, lx) + (on ? '#' : '.') + row.slice(lx + 1);
}

/** Сжимает границы по клеткам комнаты; полный прямоугольник хранится без маски. false — комната пуста. */
export function normalizeRoom(room: RoomDef): boolean {
  if (!room.mask) return room.width > 0 && room.height > 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  room.mask.forEach((row, ly) => {
    for (let lx = 0; lx < row.length; lx++) {
      if (row[lx] !== '#' && row[lx] !== '1') continue;
      x0 = Math.min(x0, lx);
      y0 = Math.min(y0, ly);
      x1 = Math.max(x1, lx);
      y1 = Math.max(y1, ly);
    }
  });
  if (x1 < 0) return false;
  const mask = room.mask.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1));
  room.x += x0;
  room.y += y0;
  room.width = x1 - x0 + 1;
  room.height = y1 - y0 + 1;
  if (mask.every((r) => !r.includes('.'))) delete room.mask;
  else room.mask = mask;
  return true;
}

export function roomCellCount(room: RoomDef): number {
  if (!room.mask) return room.width * room.height;
  return room.mask.reduce((n, r) => n + [...r].filter((c) => c === '#' || c === '1').length, 0);
}

/** Комнаты, которым принадлежит клетка. */
export function roomsAt(def: LevelDef, x: number, y: number): RoomDef[] {
  return (def.rooms ?? []).filter((r) => roomHas(r, x, y));
}

export function newRoomId(def: LevelDef): string {
  const ids = new Set((def.rooms ?? []).map((r) => r.id));
  let n = (def.rooms?.length ?? 0) + 1;
  while (ids.has(`room_${n}`)) n++;
  return `room_${n}`;
}

// ---------- Размер уровня ----------

/**
 * Меняет размер: left/top/right/bottom — сколько клеток добавить с каждой стороны (минус — обрезать). Всё, что лежит на уровне
 * (враги, декор, объекты, нитки, комнаты, повороты тайлов), сдвигается вместе с содержимым.
 */
export function resizeLevel(def: LevelDef, left: number, top: number, right: number, bottom: number): void {
  const ts = def.tile_size;
  const W = def.width + left + right;
  const H = def.height + top + bottom;
  if (W < 1 || H < 1) return;
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const ox = x - left;
      const oy = y - top;
      row += ox >= 0 && oy >= 0 && ox < def.width && oy < def.height ? def.rows[oy][ox] : EMPTY_CHAR;
    }
    rows.push(row);
  }
  def.rows = rows;
  def.width = W;
  def.height = H;
  if (!(EMPTY_CHAR in def.legend)) def.legend[EMPTY_CHAR] = null;

  def.player_spawn = { x: def.player_spawn.x + left, y: def.player_spawn.y + top };
  for (const e of def.enemies ?? []) {
    e.x += left;
    e.y += top;
    if (e.anchor_y !== undefined) e.anchor_y += top;
  }
  for (const d of def.decor ?? []) {
    d.x += left;
    d.y += top;
  }
  for (const t of def.terminals ?? []) {
    t.x += left;
    t.y += top;
  }
  for (const o of def.objects ?? []) {
    o.x += left * ts;
    o.y += top * ts;
  }
  for (const t of def.threads ?? []) {
    t.x += left * ts;
    t.y += top * ts;
  }
  for (const z of def.zones ?? []) {
    z.x0 += left;
    z.x1 += left;
    z.y0 += top;
    z.y1 += top;
  }
  for (const z of def.spawn_zones ?? []) {
    z.x += left;
    z.y += top;
  }
  if (def.tile_xform) {
    for (const t of def.tile_xform) {
      t.x += left;
      t.y += top;
    }
    def.tile_xform = def.tile_xform.filter((t) => t.x >= 0 && t.y >= 0 && t.x < W && t.y < H);
    if (!def.tile_xform.length) delete def.tile_xform;
  }
  if (def.rooms) {
    for (const r of def.rooms) {
      const shifted = { ...r, x: r.x + left, y: r.y + top };
      const mask: string[] = [];
      for (let y = 0; y < H; y++) {
        let row = '';
        for (let x = 0; x < W; x++) row += roomHas(shifted, x, y) ? '#' : '.';
        mask.push(row);
      }
      r.x = 0;
      r.y = 0;
      r.width = W;
      r.height = H;
      r.mask = mask;
    }
    def.rooms = def.rooms.filter(normalizeRoom);
    if (!def.rooms.length) delete def.rooms;
  }
}

/** Чистит уровень перед записью: легенда, комнаты без пустых, пустые массивы убраны. */
export function finalizeLevel(def: LevelDef): void {
  pruneLegend(def);
  if (def.rooms) {
    def.rooms = def.rooms.filter(normalizeRoom);
    if (!def.rooms.length) delete def.rooms;
  }
  const optional = ['decor', 'threads', 'objects', 'terminals', 'tile_xform', 'zones', 'spawn_zones'] as const;
  for (const k of optional) if (Array.isArray(def[k]) && (def[k] as unknown[]).length === 0) delete def[k];
}

/** Пустой новый уровень: пол по нижнему ряду. */
export function newLevel(id: string, name: string, tileId: string | null, width = 40, height = 20, tileSize = 32): LevelDef {
  const floor = tileId ? '#'.repeat(width) : '.'.repeat(width);
  const rows = Array.from({ length: height }, (_, y) => (y === height - 1 ? floor : '.'.repeat(width)));
  return {
    $schema: '../schemas/level.schema.json',
    id,
    display_name: name,
    tile_size: tileSize,
    width,
    height,
    legend: tileId ? { '#': tileId, '.': null } : { '.': null },
    rows,
    player_spawn: { x: 2, y: height - 2 },
    enemies: []
  };
}
