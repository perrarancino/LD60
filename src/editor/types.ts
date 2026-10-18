export interface SpriteAnimationDef {
  frames: number[];
  frame_duration_ms?: number;
  loop: boolean;
}

export interface SpriteDef {
  id: string;
  category: string;
  image: string;
  frame_width: number;
  frame_height: number;
  frames: number;
  origin: { x: number; y: number };
  hitbox?: { offset_x: number; offset_y: number; width: number; height: number };
  animations?: Record<string, SpriteAnimationDef>;
}

export interface TileDef {
  id: string;
  display_name?: string;
  sprite_id: string;
  solid: boolean;
  one_way?: boolean;
  slope?: 'up_right' | 'up_left' | 'ceil_right' | 'ceil_left';
  fill_sprite_id?: string;
  loop_frames?: number;
}

export interface TileSetDef {
  tile_size: number;
  tiles: TileDef[];
}

export interface RoomDef {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  beveled?: boolean;
}

export interface MobSpawnZoneDef {
  id: string;
  name?: string;
  enemy_id: string;
  sprite_id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  surface?: 'floor' | 'ceiling' | 'wall';
}

export interface EnemyDef {
  id: string;
  display_name: string;
  sprite_variants: string[];
  stats?: { max_health: number; contact_damage: number; movement_speed: number };
  behavior_type?: string;
}

export interface EnemySpawnDef {
  enemy_id: string;
  sprite_id: string;
  x: number;
  y: number;
  surface?: 'floor' | 'ceiling' | 'wall_left' | 'wall_right';
  is_boss?: boolean;
  boss_id?: string;
}

export interface LevelTransitionDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  target_level: string;
  target_spawn: { x: number; y: number };
  label?: string;
  requires_resistors?: number;
}

export interface CableDef {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sag: number;
  color: string;
  thickness: number;
  type?: 'sata' | 'power' | 'ide' | 'ground';
}

export interface DecorDef {
  sprite_id: string;
  x: number;
  y: number;
  layer?: 'back' | 'front';
}

export interface LevelDef {
  $schema?: string;
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
  transitions?: LevelTransitionDef[];
  cables?: CableDef[];
  rooms?: RoomDef[];
  spawn_zones?: MobSpawnZoneDef[];
  decor?: DecorDef[];
}

export interface PlaytestState {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  facing: 1 | -1;
  coyoteTimer: number;
  jumpBufferTimer: number;
}

export interface BackgroundLayerDef {
  name: string;
  sprite_id: string;
  parallax_x: number;
  parallax_y?: number;
  crop_left?: number;
  mirror?: boolean;
  visible?: boolean;
}

export interface BackgroundDef {
  $schema?: string;
  id: string;
  description?: string;
  sky_color: string;
  scale: number;
  ground_offset?: number;
  ground_color?: string;
  layers: BackgroundLayerDef[];
}

export type ToolType = 'brush' | 'eraser' | 'fill' | 'player_spawn' | 'enemy_spawn' | 'select' | 'move' | 'transition' | 'cable' | 'room' | 'passage' | 'walkability' | 'mob_zone' | 'boss_spawn' | 'bevel' | 'decor';

export type ResizeDirection = 'top' | 'bottom' | 'left' | 'right';

export interface WorldRegionDef {
  id: string;
  display_name: string;
  category: string;
  description: string;
  has_resistor: boolean;
  boss_id: string | null;
  connected_regions: string[];
}

export interface WorldLayoutDef {
  map_name: string;
  navigation_model: string;
  central_hub_id: string;
  description: string;
  regions: WorldRegionDef[];
}

export interface EntityDragState {
  type: 'player' | 'enemy' | 'decor';
  index: number; // -1 для игрока
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface EditorConfigResponse {
  ld60Path: string;
  tiles: TileSetDef | null;
  sprites: { sprites: SpriteDef[] } | null;
  enemies: EnemyDef[];
  bosses: any[];
  world: WorldLayoutDef | null;
  backgrounds: BackgroundDef[];
  levels: Array<{ filename: string; data: LevelDef }>;
}
