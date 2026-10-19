import type { RunNode } from '../systems/Run.ts';
import type { EnemySpawnDef, LevelDef } from '../data/types.ts';

/**
 * Уровень для узла забега: обычный файл из data/levels (его правят в редакторе). Для рогалика уровень слегка подготавливается: терминалы брони и туман
 * убираются, враги делятся на волны по полю `wave` (1 — первая, по умолчанию), здоровье врагов берётся из `rogue.hp_mult` уровня.
 * Первая волна кладётся в enemies, остальные — в rogue.waves (по порядку номеров).
 */
export function prepareRogueLevel(node: RunNode, levels: LevelDef[]): LevelDef {
  const base = levels.find((l) => l.id === node.levelId);
  if (!base) throw new Error(`[Рогалик] нет уровня "${node.levelId}" (data/roguelike/run.json)`);
  const def = JSON.parse(JSON.stringify(base)) as LevelDef;
  delete def.debug_key;
  delete def.start_armor;
  def.terminals = [];
  def.fog = false;

  const byWave = new Map<number, EnemySpawnDef[]>();
  for (const e of def.enemies) {
    const w = Math.max(1, Math.round(e.wave ?? 1));
    if (!byWave.has(w)) byWave.set(w, []);
    byWave.get(w)!.push(e);
  }
  const waves = [...byWave.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  ensureExit(def);
  def.enemies = waves[0] ?? [];
  def.rogue = {
    hp_mult: base.rogue?.hp_mult ?? 1,
    waves: waves.slice(1)
  };
  return def;
}

/**
 * У комнаты должна быть выходная дверь (свойство rogue_exit). Забыли поставить в редакторе — игра ставит её сама: у самого правого пола (нижнего, если таких несколько).
 */
function ensureExit(def: LevelDef): void {
  if (def.objects?.some((o) => o.props?.rogue_exit)) return;
  const solid = (x: number, y: number) => x < 0 || x >= def.width || y < 0 || y >= def.height || !!def.legend[def.rows[y][x]];
  let best: { x: number; y: number } | null = null;
  for (let x = def.width - 2; x >= 1 && !best; x--) {
    for (let y = def.height - 2; y >= 2; y--) {
      if (!solid(x, y) && solid(x, y + 1) && !solid(x, y - 1) && !solid(x, y - 2)) {
        best = { x, y };
        break;
      }
    }
  }
  if (!best) return;
  const ts = def.tile_size;
  const existing = (def.objects ?? []).filter((o) => o.id !== 'door_out');
  def.objects = [...existing, { id: 'door_out', type: 'door', x: best.x * ts + ts / 2, y: (best.y + 1) * ts, flip_x: true, props: { rogue_exit: true, requires_clear: true } }];
}
