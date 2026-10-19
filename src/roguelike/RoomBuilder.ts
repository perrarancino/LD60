import runData from '../../data/roguelike/run.json';
import templatesData from '../../data/roguelike/room_templates.json';
import enemiesData from '../../data/enemies/enemies.json';
import { mulberry32 } from '../world/autoDecor.ts';
import type { RunNode } from '../systems/Run.ts';
import type { DecorDef, EnemyDef, EnemySpawnDef, GradeDef, LevelDef, LevelObjectDef } from '../data/types.ts';

/** Подбор врагов: [id врага, сколько, где]. Где: floor — на полу, ceiling — на потолке, air — в воздухе, high — на полке повыше пола (стражи), hang — паучиха на нитке. */
type Group = [string, number, 'floor' | 'ceiling' | 'air' | 'high' | 'hang'];
interface Encounter {
  name: string;
  waves: Group[][];
}
interface Biome {
  name: string;
  hp_mult: number;
  background_id: string;
  tiles: { top: string[]; fill: string[] };
  grade?: GradeDef;
  light?: { rim_color: string; fog_color: string };
  decor: { floor: [string, 'back' | 'front'][]; ceiling: [string, 'back' | 'front'][] };
  templates: string[];
}
interface Template {
  id: string;
  name: string;
  rows: string[];
}

const TS = 32;
const BIOMES = runData.biomes as unknown as Record<string, Biome>;
const ENCOUNTERS = runData.encounters as unknown as Record<string, Encounter[][]>;
const TEMPLATES = (templatesData as unknown as { templates: Template[] }).templates;
const ENEMIES = new Map((enemiesData as unknown as EnemyDef[]).map((e) => [e.id, e]));
const REWARDS = runData.rewards;
const TILE_CHARS = 'abcdefghijklmnopqrstuvwxyz';

type Pt = { x: number; y: number };

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Сетка уровня: твёрдые клетки и поиск мест — пол, потолок, воздух, двери. */
class Grid {
  constructor(public readonly solid: boolean[][], public readonly w: number, public readonly h: number) {}

  public s(x: number, y: number): boolean {
    if (x < 0 || x >= this.w || y < 0) return true;
    if (y >= this.h) return true;
    return this.solid[y][x];
  }

  /** Клетки пола: воздух с твёрдым снизу и двумя свободными клетками над ним. */
  public floors(): Pt[] {
    const out: Pt[] = [];
    for (let y = 2; y < this.h - 1; y++) {
      for (let x = 1; x < this.w - 1; x++) {
        if (!this.s(x, y) && this.s(x, y + 1) && !this.s(x, y - 1) && !this.s(x, y - 2)) out.push({ x, y });
      }
    }
    return out;
  }

  /** Клетки под потолком: воздух с твёрдым сверху и тремя свободными клетками под ним. */
  public ceilings(): Pt[] {
    const out: Pt[] = [];
    for (let y = 1; y < this.h - 4; y++) {
      for (let x = 1; x < this.w - 1; x++) {
        if (!this.s(x, y) && this.s(x, y - 1) && !this.s(x, y + 1) && !this.s(x, y + 2) && !this.s(x, y + 3)) out.push({ x, y });
      }
    }
    return out;
  }

  /** Воздух с запасом вокруг: летунам и гнёздам. */
  public airs(): Pt[] {
    const out: Pt[] = [];
    for (let y = 2; y < this.h - 3; y++) {
      for (let x = 2; x < this.w - 2; x++) {
        let free = true;
        for (let dy = -1; dy <= 1 && free; dy++) for (let dx = -1; dx <= 1; dx++) if (this.s(x + dx, y + dy)) { free = false; break; }
        if (free) out.push({ x, y });
      }
    }
    return out;
  }

  /** Нижний пол в колонке col: воздух с твёрдым снизу и above свободными клетками над ним (у проёма в стене хватает одной). */
  private floorAt(col: number, above: number): number | null {
    for (let y = this.h - 2; y >= 2; y--) {
      if (this.s(col, y) || !this.s(col, y + 1)) continue;
      let free = true;
      for (let k = 1; k <= above; k++) if (this.s(col, y - k)) free = false;
      if (free) return y;
    }
    return null;
  }

  /** Двери: проём в стене (старые шаблоны) или пол у стены. Возвращает клетку двери (колонка, ряд пола-воздуха) для входа слева и выхода справа. */
  public doors(): { entry: Pt; exit: Pt } {
    const side = (col: number, inner: number): Pt => {
      const gap = this.floorAt(col, 1);
      if (gap !== null) return { x: col, y: gap }; // проём в самой стене
      return { x: inner, y: this.floorAt(inner, 2) ?? this.h - 3 };
    };
    return { entry: side(0, 1), exit: side(this.w - 1, this.w - 2) };
  }
}

function pickGroupSpots(spots: { floors: Pt[]; ceils: Pt[]; airs: Pt[]; highs: Pt[]; hangs: Pt[] }, kind: Group[2], n: number, taken: Pt[], keepOut: Pt | null, rand: () => number): Pt[] {
  const pool = kind === 'floor' ? spots.floors : kind === 'ceiling' ? spots.ceils : kind === 'air' ? spots.airs : kind === 'high' ? (spots.highs.length ? spots.highs : spots.floors) : spots.hangs;
  const out: Pt[] = [];
  for (const p of shuffle(pool, rand)) {
    if (out.length >= n) break;
    if (keepOut && Math.abs(p.x - keepOut.x) < 7 && Math.abs(p.y - keepOut.y) < 5) continue;
    const gap = kind === 'hang' ? 6 : 2;
    if ([...taken, ...out].some((t) => Math.abs(t.x - p.x) < gap && Math.abs(t.y - p.y) < 3)) continue;
    out.push(p);
  }
  // мест не хватило (тесная комната) — добираем без ограничений, чтобы подбор не терялся
  for (const p of shuffle(pool, rand)) {
    if (out.length >= n) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function spawnDef(enemyId: string, kind: Group[2], p: Pt, rand: () => number): EnemySpawnDef {
  const def = ENEMIES.get(enemyId);
  if (!def) throw new Error(`[RoomBuilder] неизвестный враг "${enemyId}"`);
  const sprite = def.sprite_variants[Math.floor(rand() * def.sprite_variants.length)];
  const spawn: EnemySpawnDef = { enemy_id: enemyId, sprite_id: sprite, x: p.x, y: p.y };
  if (kind === 'ceiling') spawn.surface = 'ceiling';
  else if (def.behavior_type === 'crawler' || def.behavior_type === 'burrower') spawn.surface = 'floor';
  if (def.behavior_type === 'burrower') spawn.length = 3 + Math.floor(rand() * 3);
  if (kind === 'hang') {
    spawn.y = p.y - 1 + 4; // паучиха: нить от потолка (ряд p.y - 1), сама ниже на 4 клетки
    spawn.anchor_y = p.y - 1;
  }
  return spawn;
}

/** Собирает уровень забега для узла: боевая комната из шаблона и биома либо арена босса. */
export function buildRogueLevel(node: RunNode, seed: number, levels: LevelDef[]): LevelDef {
  const rand = mulberry32(seed * 7919 + node.index * 104729 + 17);
  if (node.kind === 'boss') return buildBoss(node, levels);

  const biome = BIOMES[node.biome];
  // шаблоны уровня: у каждой комнаты уровня свой (перемешиваем одинаково для всех комнат уровня)
  const order = shuffle(biome.templates, mulberry32(seed * 31 + node.stage * 977 + 5));
  const tpl = TEMPLATES.find((t) => t.id === order[node.room % order.length]);
  if (!tpl) throw new Error(`[RoomBuilder] нет шаблона "${order[node.room % order.length]}"`);

  const h = tpl.rows.length;
  const w = tpl.rows[0].length;
  const solid = tpl.rows.map((r) => [...r].map((c) => c === '#'));
  const grid = new Grid(solid, w, h);

  // тайлы биома: верхние грани и заливка; каждому id — свой символ легенды
  const legend: Record<string, string | null> = { '.': null };
  const charOf = new Map<string, string>();
  const ch = (id: string): string => {
    let c = charOf.get(id);
    if (!c) {
      c = TILE_CHARS[charOf.size];
      charOf.set(id, c);
      legend[c] = id;
    }
    return c;
  };
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) {
      if (!solid[y][x]) { line += '.'; continue; }
      const list = !grid.s(x, y - 1) || y === 0 ? biome.tiles.top : biome.tiles.fill;
      line += ch(list[Math.floor(rand() * list.length)]);
    }
    rows.push(line);
  }

  // двери и точка появления героя
  const doors = grid.doors();
  const spawnCol = Math.min(w - 3, doors.entry.x + 2);
  const objects: LevelObjectDef[] = [
    { id: 'door_in', type: 'door', x: doors.entry.x * TS + TS / 2, y: (doors.entry.y + 1) * TS },
    { id: 'door_out', type: 'door', x: doors.exit.x * TS + TS / 2, y: (doors.exit.y + 1) * TS, flip_x: true, props: { rogue_exit: true, requires_clear: true } }
  ];

  // места для врагов и декора
  const floors = grid.floors();
  const ground = floors.reduce((m, p) => Math.max(m, p.y), 0);
  const spots = {
    floors,
    ceils: grid.ceilings(),
    airs: grid.airs().filter((p) => p.y <= ground - 2),
    highs: floors.filter((p) => p.y <= ground - 2),
    hangs: grid.ceilings().filter((p) => p.x > 2 && p.x < w - 3 && [1, 2, 3, 4, 5].every((k) => !grid.s(p.x, p.y + k))) // под потолком 5 свободных клеток
  };
  const hero: Pt = { x: spawnCol, y: doors.entry.y };

  const options = ENCOUNTERS[node.biome][node.room % ENCOUNTERS[node.biome].length];
  const enc = options[Math.floor(rand() * options.length)];
  const waves: EnemySpawnDef[][] = enc.waves.map((groups, wi) => {
    const out: EnemySpawnDef[] = [];
    const taken: Pt[] = [];
    for (const [id, n, kind] of groups) {
      const pts = pickGroupSpots(spots, kind, n, taken, wi === 0 ? hero : null, rand);
      for (const p of pts) {
        taken.push(p);
        out.push(spawnDef(id, kind, p, rand));
      }
    }
    return out;
  });

  // декор по полу и потолку (не у дверей и не у места появления героя)
  const decor: DecorDef[] = [];
  const nearDoor = (p: Pt) => [doors.entry, doors.exit].some((d) => Math.abs(p.x - d.x) <= 2 && Math.abs(p.y - d.y) <= 3);
  for (const p of shuffle(floors, rand).slice(0, Math.max(2, Math.floor(floors.length / 7)))) {
    if (nearDoor(p) || decor.some((d) => Math.abs(d.x - (p.x + 0.5)) < 3 && Math.abs(d.y - (p.y + 1)) < 2)) continue;
    const [sprite, layer] = biome.decor.floor[Math.floor(rand() * biome.decor.floor.length)];
    decor.push({ sprite_id: sprite, x: p.x + 0.5, y: p.y + 1, layer, ...(rand() < 0.5 ? { flip_x: true } : {}) });
  }
  for (const p of shuffle(spots.ceils, rand).slice(0, Math.max(1, Math.floor(spots.ceils.length / 14)))) {
    if (nearDoor(p) || decor.some((d) => Math.abs(d.x - (p.x + 0.5)) < 5 && d.y < 8 && Math.abs(d.y - p.y) < 2)) continue;
    const [sprite, layer] = biome.decor.ceiling[Math.floor(rand() * biome.decor.ceiling.length)];
    decor.push({ sprite_id: sprite, x: p.x + 0.5, y: p.y, layer });
  }

  const def: LevelDef = {
    id: `rogue_${node.index}`,
    display_name: `${biome.name}: ${enc.name}`,
    background_id: biome.background_id,
    tile_size: TS,
    width: w,
    height: h,
    legend,
    rows,
    player_spawn: { x: spawnCol, y: doors.entry.y },
    decor,
    objects,
    terminals: [],
    enemies: waves[0],
    rooms: [{ id: 'arena', name: enc.name, x: 0, y: 0, width: w, height: h, location: node.stage + 1 }],
    fog: false,
    ...(biome.grade ? { grade: biome.grade } : {}),
    ...(biome.light ? { light: biome.light } : {}),
    rogue: {
      node: node.index,
      boss: false,
      name: enc.name,
      waves: waves.slice(1),
      clear_gears: REWARDS.room_gears[node.room % REWARDS.room_gears.length],
      hp_mult: biome.hp_mult
    }
  };
  return def;
}

/** Арена босса: уровень из data/levels как есть, но без терминалов брони и со входом и выходом (выход открывается после победы). */
function buildBoss(node: RunNode, levels: LevelDef[]): LevelDef {
  const base = levels.find((l) => l.id === node.bossLevel);
  if (!base) throw new Error(`[RoomBuilder] нет уровня босса "${node.bossLevel}"`);
  const def = JSON.parse(JSON.stringify(base)) as LevelDef;
  delete def.debug_key;
  delete def.start_armor;
  def.terminals = [];
  def.fog = false;
  const solid = def.rows.map((r) => [...r].map((c) => !!def.legend[c]));
  const grid = new Grid(solid, def.width, def.height);
  const doors = grid.doors();
  def.objects = [
    ...(def.objects ?? []),
    { id: 'door_in', type: 'door', x: doors.entry.x * TS + TS / 2, y: (doors.entry.y + 1) * TS },
    { id: 'door_out', type: 'door', x: doors.exit.x * TS + TS / 2, y: (doors.exit.y + 1) * TS, flip_x: true, props: { rogue_exit: true, requires_clear: true } }
  ];
  def.rogue = { node: node.index, boss: true, name: def.display_name ?? 'Босс', waves: [], clear_gears: REWARDS.boss_gears, hp_mult: 1 };
  return def;
}
