/** Типы данных из data/*.json (см. data/schemas/). */

export interface SpriteAnimationDef {
  frames: number[];
  frame_duration_ms?: number;
  loop: boolean;
}

export interface HitboxDef {
  offset_x: number;
  offset_y: number;
  width: number;
  height: number;
}

export interface SpriteDef {
  id: string;
  category: string;
  image: string; // относительно assets/sprites/
  frame_width: number;
  frame_height: number;
  frames: number;
  columns?: number;
  origin: { x: number; y: number };
  hitbox?: HitboxDef;
  animations: Record<string, SpriteAnimationDef>;
}

export interface TileDef {
  id: string;
  display_name?: string;
  sprite_id: string;
  solid: boolean;
  one_way?: boolean;
}

export interface TileSetDef {
  tile_size: number;
  tiles: TileDef[];
}

export interface EnemySpawnDef {
  enemy_id: string;
  sprite_id: string;
  x: number;
  y: number;
}

export interface LevelDef {
  id: string;
  display_name?: string;
  background_id?: string;
  tile_size: number;
  width: number;
  height: number;
  legend: Record<string, string | null>;
  rows: string[];
  player_spawn: { x: number; y: number };
  enemies: EnemySpawnDef[];
}

export interface EnemyDef {
  id: string;
  display_name: string;
  sprite_variants: string[];
  stats: { max_health: number; contact_damage: number; movement_speed: number };
  behavior_type: string;
}

export interface RigPartDef {
  name: string;
  sprite_id: string;
  role: 'head' | 'torso' | 'arm' | 'leg';
  side?: 1 | -1; // 1 — левая на экране (Fhand/Fleg), -1 — правая
  pivot: { x: number; y: number };
  length?: number; // для ног: длина в пикселях (от бедра до стопы)
  rope?: { segments: number }; // рука-канат: слой режется на сегменты с verlet-физикой
}

export interface RigDef {
  id: string;
  canvas: { width: number; height: number };
  anchor: { x: number; y: number };
  parts: RigPartDef[]; // снизу вверх
}

export interface BackgroundLayerDef {
  name: string;
  sprite_id: string;
  parallax_x: number;
  parallax_y: number;
}

export interface BackgroundDef {
  id: string;
  sky_color: string;
  scale: number;
  ground_offset?: number; // на сколько px от низа уровня приподняты слои (нижний край фона над землёй)
  layers: BackgroundLayerDef[]; // снизу вверх
}
