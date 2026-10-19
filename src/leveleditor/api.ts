import type { BackgroundDef, EnemyDef, LevelDef, SpriteDef, TileSetDef } from '../data/types.ts';
import type { PlaceablesDef } from '../world/placeables.ts';

/** Данные проекта, которые отдаёт сервер редактора (vite в разработке или LD60Editor.exe). */
export interface ProjectData {
  ld60Path: string;
  tiles: TileSetDef;
  sprites: { sprites: SpriteDef[] };
  enemies: EnemyDef[];
  backgrounds: BackgroundDef[];
  placeables: PlaceablesDef;
  levels: Array<{ filename: string; data: LevelDef }>;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function loadProject(): Promise<ProjectData> {
  return json<ProjectData>(await fetch('/api/ld60/config', { cache: 'no-store' }));
}

export async function saveLevel(filename: string, level: LevelDef): Promise<{ filename: string }> {
  const res = await fetch('/api/ld60/level/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // текст файла готовит редактор (JSON с отступами, как в проекте): сервер записывает его как есть
    body: JSON.stringify({ filename, text: JSON.stringify(level, null, 2) + '\n' })
  });
  return json<{ filename: string }>(res);
}

export async function deleteLevel(filename: string): Promise<void> {
  await json(await fetch('/api/ld60/level/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  }));
}
