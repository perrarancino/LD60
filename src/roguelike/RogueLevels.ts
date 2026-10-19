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
  def.objects = (def.objects ?? []).filter((o) => o.type !== 'door'); // дверей в рогалике нет: комната кончается сама, когда зачищена
  def.enemies = waves[0] ?? [];
  def.rogue = {
    hp_mult: base.rogue?.hp_mult ?? 1,
    waves: waves.slice(1)
  };
  return def;
}

