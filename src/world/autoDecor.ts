import type { DecorZoneDef, LevelDef, SpriteDef } from '../data/types.ts';

/**
 * Раскладка автодекора по зонам уровня (level.zones): какие транзисторы, лианы и нитки где стоят. Чистые функции без графики —
 * по ним собирает уровень игра (Level, Webs) и рисует редактор, поэтому зоны выглядят в редакторе так же, как в игре.
 * Генератор детерминированный: раскладка одинакова при каждом запуске; порядок вызовов rand() нельзя менять — иначе всё «переедет».
 */

export const SPRITE_TRANSISTORS = ['deco_transistor', 'deco_transistor2'];

export const VINE_NODE = 7;
export const VINE_PIECE = VINE_NODE * 2; // px: шаг звеньев вдоль лианы
const VINE_TINTS = [0xffffff, 0xe3f1ff, 0xcfe6ff];
const SKY_ANCHOR_ROW = -2; // ряд тайлов, где закреплён верх длинной нитки
const SKY_SWING = [6, 14]; // px: размах качания нижнего конца
const SKY_SPEED = [0.35, 0.7]; // рад/с
const SKY_CLEARANCE = 8; // px: нитка с неба обрывается чуть выше первой платформы под ней

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Solid = (cx: number, cy: number) => boolean;

/** Клетки «ряд:колонка», над которыми уже стоит декор, поставленный вручную: транзисторы там не ставятся. */
export function reservedCells(def: LevelDef, spriteDef: (id: string) => SpriteDef | undefined): Set<string> {
  const ts = def.tile_size;
  const reserved = new Set<string>();
  for (const d of def.decor ?? []) {
    const sd = spriteDef(d.sprite_id);
    if (!sd) continue;
    const left = Math.floor((d.x * ts - sd.frame_width * sd.origin.x) / ts);
    const right = Math.floor((d.x * ts + sd.frame_width * (1 - sd.origin.x) - 1) / ts);
    for (let cx = left; cx <= right; cx++) reserved.add(`${Math.round(d.y)}:${cx}`);
  }
  return reserved;
}

export interface TransistorSpot {
  sprite_id: string;
  x: number; // px, середина клетки
  y: number; // px, верхняя грань клетки (ноги)
}

/** Зона транзисторов: на верхних гранях твёрдых клеток, случайно, но детерминированно (по density). */
export function layoutTransistors(def: LevelDef, zone: DecorZoneDef, index: number, solid: Solid, reserved: ReadonlySet<string>): TransistorSpot[] {
  const rand = mulberry32(index * 9973 + 101);
  const density = zone.density ?? 0.5;
  const ts = def.tile_size;
  const spawn = def.player_spawn;
  const out: TransistorSpot[] = [];
  for (let cy = Math.max(0, zone.y0); cy <= Math.min(def.height - 1, zone.y1); cy++) {
    for (let cx = Math.max(0, zone.x0); cx <= Math.min(def.width - 1, zone.x1); cx++) {
      const roll = rand();
      const pick = rand();
      if (!solid(cx, cy) || (cy > 0 && solid(cx, cy - 1)) || roll >= density) continue;
      if (reserved.has(`${cy}:${cx}`)) continue; // здесь уже стоит другой декор
      if (Math.abs(cx - spawn.x) <= 1 && cy === spawn.y + 1) continue; // не на месте появления героя
      out.push({ sprite_id: SPRITE_TRANSISTORS[pick < 0.5 ? 0 : 1], x: Math.round((cx + 0.5) * ts), y: Math.round(cy * ts) });
    }
  }
  return out;
}

export interface VineSpot {
  x: number; // корень (px)
  y: number;
  pieces: number;
  tint: number;
  bead: boolean;
}

export interface SkySpot {
  x: number;
  topY: number;
  bottomY: number;
  swing: number;
  speed: number;
  phase: number;
  bead: boolean;
}

/** Зона паутины: лианы под нижними гранями тайлов и длинные нитки с неба. */
export function layoutWebs(def: LevelDef, zone: DecorZoneDef, index: number, solid: Solid): { vines: VineSpot[]; sky: SkySpot[] } {
  const rand = mulberry32(index * 7919 + 4421);
  const density = zone.density ?? 0.5;
  const ts = def.tile_size;
  const W = def.width;
  const H = def.height;
  const isSolid = (cx: number, cy: number) => cx >= 0 && cx < W && cy >= 0 && cy < H && solid(cx, cy);
  const x0 = Math.max(0, zone.x0);
  const x1 = Math.min(W - 1, zone.x1);
  const y0 = Math.max(0, zone.y0);
  const y1 = Math.min(H - 1, zone.y1);
  const vines: VineSpot[] = [];
  const sky: SkySpot[] = [];

  // лианы под тайлами: пучок из 2–3 нитей разной длины (кратной звену), длина — до следующего тайла
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!(isSolid(cx, cy) && !isSolid(cx, cy + 1) && cy + 1 < H && rand() < Math.min(1, density * 1.3))) continue;
      let room = 0;
      for (let y = cy + 1; y < H && !isSolid(cx, y); y++) room += ts;
      const maxPieces = Math.min(6, Math.floor((room - 6) / VINE_PIECE));
      if (maxPieces < 1) continue;
      const count = 2 + (rand() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const x = cx * ts + 4 + ((i + 0.3 + rand() * 0.4) * (ts - 8)) / count;
        const pieces = 1 + Math.floor(rand() * maxPieces);
        const tint = VINE_TINTS[Math.floor(rand() * VINE_TINTS.length)];
        vines.push({ x, y: (cy + 1) * ts - 2, pieces, tint, bead: rand() < 0.45 });
      }
    }
  }

  // длинные нитки с неба: по одной примерно на каждые 2–3 колонки зоны (по density), с неравномерными промежутками
  const topY = SKY_ANCHOR_ROW * ts;
  for (let cx = x0; cx <= x1; cx++) {
    if (rand() >= density * 0.55) continue;
    const x = cx * ts + 4 + rand() * (ts - 8);
    const swing = SKY_SWING[0] + rand() * (SKY_SWING[1] - SKY_SWING[0]);
    let bottomY = (y0 + rand() * (y1 - y0 + 1)) * ts;
    // нитка обрывается над первой твёрдой клеткой под ней (с учётом размаха качания), а не проходит сквозь платформу
    const cl = Math.floor((x - swing - 4) / ts);
    const cr = Math.floor((x + swing + 4) / ts);
    for (let cy = 0; cy < H; cy++) {
      let hit = false;
      for (let c = cl; c <= cr; c++) if (isSolid(c, cy)) hit = true;
      if (hit) { bottomY = Math.min(bottomY, cy * ts - SKY_CLEARANCE); break; }
    }
    if (bottomY - topY < 4 * ts) continue;
    const speed = SKY_SPEED[0] + rand() * (SKY_SPEED[1] - SKY_SPEED[0]);
    sky.push({ x, topY, bottomY, swing, speed, phase: rand() * Math.PI * 2, bead: rand() < 0.5 });
  }
  return { vines, sky };
}
