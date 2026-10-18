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
  loop_frames?: number; // спрайт — лист из стольких кадров-тайлов; в ряду тайлов кадры чередуются по кругу с начала ряда
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
  surface?: 'floor' | 'ceiling' | 'wall_left' | 'wall_right';
  length?: number; // длина червя в сегментах (по умолчанию случайная в пределах рига)
  anchor_y?: number; // для висящих на нитке: ряд тайлов, где закреплён верх нитки (по умолчанию -2)
}

/** Декор уровня (без коллизии): точка привязки спрайта ставится в (x, y) тайлов. back — за тайлами, front — поверх них. */
export interface DecorDef {
  sprite_id: string;
  x: number;
  y: number;
  layer?: 'back' | 'front';
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
  decor?: DecorDef[];
  enemies: EnemySpawnDef[];
}

export interface EnemyDef {
  id: string;
  display_name: string;
  sprite_variants: string[];
  rig_id?: string;
  stats: { max_health: number; contact_damage: number; movement_speed: number };
  behavior_type: string;
  spawns?: SpawnsDef; // для spawner: кого и как выплёвывает
}

export interface RigPartDef {
  name: string;
  sprite_id: string;
  role: 'head' | 'torso' | 'arm' | 'leg';
  side?: 1 | -1; // 1 — левая на экране (Fhand/Fleg), -1 — правая
  pivot: { x: number; y: number };
  face?: { sprite_id?: string; feature_colors?: string[]; region?: { x0: number; y0: number; x1: number; y1: number }; max_shift: { x: number; y: number } }; // для головы: лицо (глаза, рот) двигается по черепу к курсору — отдельным слоем (sprite_id) или чертами, вырезанными из слоя головы (feature_colors)
  gaze_origin?: { x: number; y: number }; // для головы: середина глаз на холсте — от неё считается направление взгляда на курсор
  length?: number; // для ног: длина в пикселях (от бедра до стопы)
  rope?: { segments: number }; // рука-канат: слой режется на сегменты с verlet-физикой
}

export interface CrawlerLegDef {
  name: string;
  upper_sprite_id: string; // верхняя фаланга (бедро -> колено)
  lower_sprite_id: string; // нижняя фаланга (колено -> стопа)
  hip: { x: number; y: number }; // суставы на холсте в позе из рисунка
  knee: { x: number; y: number };
  foot: { x: number; y: number };
  gait_group: 0 | 1;
}

export interface CrawlerDef {
  body_raise: number; // на сколько px тело поднято над поверхностью ногами
  leg_spread?: number; // множитель разноса стоп по сравнению с рисунком
  leg_splay?: number; // дополнительный разброс стоп наружу от центра тела, px
  body_centre_x?: number; // центр тела по X на холсте (по умолчанию — якорь)
  legs: CrawlerLegDef[];
}

export interface SegmentDef {
  sprite_id: string;
  center: { x: number; y: number }; // центр части на холсте
}

export interface SegmentedDef {
  thickness: number;
  length_min: number;
  length_max: number;
  head: SegmentDef;
  body: SegmentDef;
  tail: SegmentDef;
  head_to_body: number;
  body_to_body: number;
  body_to_tail: number;
}

export interface WobblerLimbDef {
  name: string;
  sprite_id: string; // полнохолстная маска лапки (какие пиксели рисунка — её)
  root: { x: number; y: number }; // корень лапки на холсте
  bones?: number; // число костей (по умолчанию 6)
}

export interface ThreadDef {
  sprite_id: string;
  attach: { x: number; y: number }; // точка холста, к которой привязана нитка
  width_center?: number;
}

export interface WobblerDef {
  thread?: ThreadDef;
  sprite_id: string; // полный рисунок существа — текстура общей сетки
  mouth: { x: number; y: number };
  limbs: WobblerLimbDef[];
}

export interface SpawnsDef {
  enemy_id: string;
  sprite_id?: string;
  interval_seconds: [number, number];
  max_alive: number;
  scale?: number;
  lifetime_seconds?: number;
}

export interface RigDef {
  id: string;
  canvas: { width: number; height: number };
  anchor: { x: number; y: number };
  crawler?: CrawlerDef;
  segmented?: SegmentedDef;
  wobbler?: WobblerDef;
  parts: RigPartDef[]; // снизу вверх
}

export interface BackgroundLayerDef {
  name: string;
  sprite_id: string;
  parallax_x: number;
  crop_left?: number; // отрезать столько левых столбцов картинки («битый» край, дающий шов при тайлинге)
  mirror?: boolean; // тайлить зеркально: края тайлов всегда совпадают
}

export interface BackgroundDef {
  id: string;
  sky_color: string;
  scale: number;
  ground_color?: string; // цвет «земли» под нижним краем фона (заливка вниз до края экрана)
  ground_offset?: number; // на сколько px от низа уровня приподняты слои (нижний край фона над землёй)
  layers: BackgroundLayerDef[]; // снизу вверх
}
