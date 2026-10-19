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
  slope?: Slope; // 45° диагональный скос тайла
  frame?: number; // кадр листа sprite_id (0 по умолчанию): каждый кадр листа — отдельный тайл, ничего не выбирается автоматически
  group?: string; // раздел в палитре редактора
}

export interface TileSetDef {
  tile_size: number;
  tiles: TileDef[];
}

/**
 * Комната уровня: клетки, которые герой видит, находясь в ней (остальное скрыто туманом войны), и «дом» для мобов: они замечают героя
 * и атакуют только в пределах своей комнаты. Границы — прямоугольник x, y, width, height (в клетках); mask — какие клетки внутри него
 * принадлежат комнате (ряды длиной width, "#" — клетка комнаты, "." — нет). Без mask комната — весь прямоугольник.
 */
export interface RoomDef {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  mask?: string[];
  color?: string;
  beveled?: boolean;
  location?: number; // номер локации (1, 2, 3...)
  background_id?: string; // фон, который включается, когда герой входит в комнату (плавная смена); без него — фон уровня
}

/** Туман войны: вне комнаты, где стоит герой, мир чёрный. current — виден только текущая комната, explored — и уже посещённые. */
export interface FogDef {
  mode?: 'current' | 'explored';
}

/** Поворот и отражение тайла в клетке (x, y): отражения применяются к рисунку, затем поворот по часовой стрелке (rot — 90, 180 или 270). */
export interface TileXformDef {
  x: number;
  y: number;
  flip_x?: boolean;
  flip_y?: boolean;
  rot?: number;
}

/** Нитка, поставленная точно на пиксель: x, y — пиксели мира. vine — физичная лиана свисает вниз от точки (pieces звеньев), sky — длинная нитка с верхом в (x, y) и свободным нижним концом на глубине length. */
export interface ThreadPlaceDef {
  kind: 'vine' | 'sky';
  x: number;
  y: number;
  pieces?: number;
  length?: number;
  swing?: number;
  bead?: boolean;
}

/** Объект уровня из каталога data/objects/placeables.json (дверь, батарейка, подставка и т.п.): x, y — пиксели мира, точка привязки спрайта. */
export interface LevelObjectDef {
  id: string;
  type: string;
  x: number;
  y: number;
  flip_x?: boolean;
  props?: Record<string, string | number | boolean>;
}

export type Slope = 'up_right' | 'up_left' | 'ceil_right' | 'ceil_left';

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

export interface EnemySpawnDef {
  enemy_id: string;
  sprite_id: string;
  x: number;
  y: number;
  surface?: 'floor' | 'ceiling' | 'wall_left' | 'wall_right';
  length?: number; // длина червя в сегментах (по умолчанию случайная в пределах рига)
  anchor_y?: number; // для висящих на нитке: ряд тайлов, где закреплён верх нитки (по умолчанию -2)
  is_boss?: boolean;
  boss_id?: string;
  room?: string; // id комнаты-«дома»: моб замечает героя и атакует только в ней; по умолчанию — комната, в которой он стоит
}

/** Декор уровня (без коллизии): точка привязки спрайта ставится в (x, y) тайлов. back — за тайлами, front — поверх них. */
export interface DecorDef {
  sprite_id: string;
  x: number;
  y: number;
  layer?: 'back' | 'front';
  flip_x?: boolean; // отражение рисунка по горизонтали (вокруг точки привязки)
  flip_y?: boolean; // по вертикали
}

/** Терминал брони на уровне: нижним центром в нижнюю границу клетки (x, y). */
export interface TerminalDef {
  sprite_id: string;
  x: number;
  y: number;
}

/** УСТАРЕЛО: зона автодекора. Игра её не раскладывает; редактор превращает зоны в обычные предметы при открытии уровня. */
export interface DecorZoneDef {
  kind: 'transistors' | 'webs';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  density?: number;
}

/** Цветокоррекция уровня: тона (RGB-добавки 0..1) теней и светов в начале уровня и (по желанию) в конце — по уровню они плавно переходят. */
export interface GradeDef {
  exposure?: number; // общая яркость (<1 — темнее)
  gamma?: number; // >1 — средние тона темнее
  tint?: [number, number, number]; // множитель цвета (общий оттенок кадра)
  saturation?: number;
  contrast?: number;
  vignette?: number;
  shadows?: [number, number, number];
  highlights?: [number, number, number];
  shadows_end?: [number, number, number];
  highlights_end?: [number, number, number];
}

export interface LevelDef {
  $schema?: string;
  id: string;
  display_name?: string;
  debug_key?: number; // отладка: клавиша 1–4 в игре переключает на этот уровень
  background_id?: string;
  tile_size: number;
  width: number;
  height: number;
  legend: Record<string, string | null>;
  rows: string[];
  player_spawn: { x: number; y: number };
  decor?: DecorDef[];
  terminals?: TerminalDef[]; // терминалы брони
  tile_xform?: TileXformDef[]; // повороты и отражения отдельных тайлов
  threads?: ThreadPlaceDef[]; // нитки, поставленные на конкретные пиксели
  objects?: LevelObjectDef[]; // двери, батарейки, подставки и прочие объекты из каталога
  fog?: FogDef | boolean; // туман войны по комнатам (нужен список rooms)
  start_armor?: number; // герой входит на уровень в частях этой модели (1 — прежний герой, 2 — герой второй локации)
  grade?: GradeDef;
  light?: { rim_color?: string; fog_color?: string }; // цвета света от фона на уровне (#rrggbb); по умолчанию зелёные
  zones?: DecorZoneDef[];
  enemies: EnemySpawnDef[];
  rooms?: RoomDef[];
  spawn_zones?: MobSpawnZoneDef[];
}

export interface EnemyDef {
  id: string;
  display_name: string;
  sprite_variants: string[];
  rig_id?: string;
  stats: { max_health: number; contact_damage: number; movement_speed: number };
  behavior_type: string;
  attack: { name: string; damage: number; cooldown_seconds: number; range?: number; projectile_type?: string; description?: string }; // главная атака: damage — урон герою (укус, бросок, таран)
  spawns?: SpawnsDef; // для spawner: кого и как выплёвывает
  summons?: SummonsDef; // для flying_bird (босс-птица): кого призывает, когда садится на пол; для flying_worm: паучки «Паучьего дождя»
}

/** Призыв босса-птицы: при посадке рядом с ней появляются count существ из enemy_ids (случайно), живых одновременно не больше max_alive. */
export interface SummonsDef {
  enemy_ids: string[];
  count: number;
  max_alive?: number;
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

/** Деталь, прикрепленная к части тела (щупальце головы босса): под рисунком части или поверх него, может качаться вокруг своей точки крепления. */
export interface AttachmentDef {
  sprite_id: string; // слой на полном холсте рига
  pivot?: { x: number; y: number }; // точка крепления на холсте (вокруг неё качается); без неё деталь неподвижна
  sway?: number; // амплитуда качания, рад
  speed?: number; // скорость качания, рад/с
  phase?: number; // сдвиг фазы, рад
}

/** Анимация детали существа-«сборки» (Critter): все детали вращаются/сдвигаются вокруг своей точки pivot на холсте рига. */
export interface CritterAnimDef {
  type: 'step' | 'swing' | 'wag' | 'bob' | 'bounce' | 'flap' | 'squash' | 'track' | 'peck' | 'tuck' | 'sink';
  amp: number; // step — размах по x, px; swing/wag/flap/track/peck — угол, рад; bob/bounce — px; squash — доля; tuck — доля длины, на которую деталь втягивается (по вертикали)
  rate?: number; // частота колебаний, рад/с (для step/swing/bounce — по фазе шага)
  phase?: number; // сдвиг фазы, рад
  lift?: number; // step: подъём в махе, px; tuck: на сколько px деталь ещё поднимается при втягивании
  always?: boolean; // swing: качается и на месте (иначе — только в движении)
  of?: string; // sink: имя детали (выше в списке), за чьим смещением вниз идёт эта деталь; вверх за ней не идёт
}

export interface CritterPartDef {
  name: string;
  sprite_id: string; // слой на полном холсте рига
  pivot: { x: number; y: number }; // точка, вокруг которой деталь вращается
  anims?: CritterAnimDef[];
}

/** Хвост-молния (процедурный, src/effects/LightningTail.ts), хлещущий героя: подбегает, замахивается и сбивает с ног. */
export interface CritterTailDef {
  root: { x: number; y: number }; // корень хвоста на холсте рига
  length: number; // длина в покое, px
  nodes?: number; // узлов в цепочке (по умолчанию 11)
  whip?: {
    reach: number; // на сколько px вперёд от точки привязки дотягивается хлёст
    windup: number; // время замаха, с
    lash: number; // время самого хлёста, с
    recover: number; // время возврата хвоста, с
    cooldown: [number, number]; // пауза между хлёстами (случайная в диапазоне), с
  };
}

/** Бросок прыгуна на героя (hopper): заметил — подпрыгивает ближе, приседает и прыгает прямо в него; после — отходит и ждёт перезарядки. */
export interface CritterLungeDef {
  sight: number; // px: на таком расстоянии по горизонтали замечает героя и идёт на него
  range: number; // px: с такого расстояния приседает перед броском
  windup: number; // с: приседание перед прыжком
  speed_y: number; // px/с: взлёт в прыжке
  max_vx: number; // px/с: потолок скорости вперёд в прыжке (дальше — недолёт)
  cooldown: [number, number]; // с: пауза между бросками
}

/** Стрельба стража (watcher): заряжает глаз и пускает синюю молнию, которая отражается от стен. */
export interface CritterShootDef {
  sight: number; // px: дальность, с которой начинает стрелять
  windup: number; // с: зарядка глаза перед выстрелом
  cooldown: [number, number]; // с: пауза между залпами
  count: number; // молний в залпе
  spread: number; // рад: разброс залпа (вокруг линии на героя)
  speed: number; // px/с
  bounces: number; // сколько раз молния отражается от стен
  life: number; // с: сколько живёт молния
  damage: number;
}

/** Небольшое существо из слоёв с процедурной анимацией: ходит (walker), скачет (hopper), летает (flyer) или стоит и следит (watcher). */
export interface CritterDef {
  kind: 'walker' | 'hopper' | 'flyer' | 'watcher';
  draw_facing: 1 | -1; // куда смотрит рисунок (−1 — влево): при движении в другую сторону зеркалится
  stride?: number; // рад фазы шага на пиксель пути
  sight?: number; // дальность, на которой замечает героя, px
  hit: Array<{ x: number; y: number; r: number }>; // круги попадания на холсте рига
  parts: CritterPartDef[]; // снизу вверх
  tail?: CritterTailDef; // процедурный хвост-молния поверх деталей
  lunge?: CritterLungeDef; // hopper: прыгает на героя
  shoot?: CritterShootDef; // watcher: стреляет отражающимися молниями
}

export interface SegmentDef {
  sprite_id: string;
  center: { x: number; y: number }; // центр части на холсте
  scale?: number; // масштаб рисунка (по умолчанию 1)
  hit_radius?: number; // круг попадания, px (по умолчанию — половина толщины червя)
  under?: AttachmentDef[]; // детали позади рисунка части
  over?: AttachmentDef[]; // детали поверх рисунка части
}

/** Здоровье частей червя: голова (её гибель — гибель всего существа), туловище, хвост. */
export interface SegmentHealthDef {
  head?: number; // по умолчанию stats.max_health врага
  body: number;
  tail: number;
}

/** Полёт босса-червя: голова целится в героя, поворачивая не быстрее turn_rate, и проносится сквозь него широкими петлями. */
export interface FlightDef {
  turn_rate: number; // рад/с: как круто голова поворачивает
  pass_distance: number; // px: ближе этого к цели голова перестаёт доворачивать и проносится мимо
  pass_time: [number, number]; // с: сколько длится пролёт мимо
  boost: number; // во сколько раз быстрее скорость при пролёте
  wave: { amp: number; k: number }; // извивание тела: поперечная амплитуда px и фазовая скорость по телу рад/px
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
  health?: SegmentHealthDef;
  flight?: FlightDef; // есть — босс: летает, иначе ползает по поверхностям
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

/** Слой босса-птицы: крыло (wing) машет вокруг pivot-плеча, у головы pivot — шея; остальные слои неподвижны на холсте рига. */
export interface BirdLayerDef {
  name: string;
  sprite_id: string;
  wing?: 'left' | 'right';
  pivot?: { x: number; y: number };
}

/** Круг попадания босса-птицы на холсте рига; круги крыльев качаются вместе с крылом. */
export interface BirdHitDef {
  part: 'body' | 'head' | 'wing_l' | 'wing_r';
  x: number;
  y: number;
  r: number;
}

/** Босс-птица: слои на общем холсте, точка тела (вокруг неё поворот и зеркало), низ лап, круги попадания, спрайт выпускаемых птичек. */
export interface BirdBossDef {
  body: { x: number; y: number };
  feet_y: number;
  draw_facing: 1 | -1;
  bird_sprite_id: string;
  layers: BirdLayerDef[]; // снизу вверх
  hit: BirdHitDef[];
}

/** Слой босса-краба: ноги (leg_*) качаются вокруг бедра pivot и подгоняются по foot_y к полу; торс неподвижен на холсте. */
export interface CrabLayerDef {
  name: string;
  sprite_id: string;
  role: 'torso' | 'leg_lb' | 'leg_lf' | 'leg_rf' | 'leg_rb';
  pivot?: { x: number; y: number };
  foot_y?: number;
}

/** Босс-краб: слои на общем холсте, торс с кругами попадания, клешни на неоновых нитях, шары (data/rigs/krab_boss_rig.json). */
export interface CrabBossDef {
  feet: { x: number; y: number };
  box: { w: number; h: number };
  height: number;
  thread_length: number;
  layers: CrabLayerDef[]; // снизу вверх
  body_hit: Array<{ x: number; y: number; r: number }>;
  claw: { sprite_id: string; pivot: { x: number; y: number }; length: number; hit: Array<{ x: number; y: number; r: number }> };
  shoulders: { left: { x: number; y: number }; right: { x: number; y: number } };
  orb: { sprite_id: string; radius: number };
}

export interface RigDef {
  id: string;
  canvas: { width: number; height: number };
  anchor: { x: number; y: number };
  crawler?: CrawlerDef;
  segmented?: SegmentedDef;
  wobbler?: WobblerDef;
  critter?: CritterDef;
  bird_boss?: BirdBossDef;
  crab_boss?: CrabBossDef;
  parts: RigPartDef[]; // снизу вверх
}

export interface BackgroundLayerDef {
  name: string;
  sprite_id: string;
  parallax_x: number;
  crop_left?: number; // отрезать столько левых столбцов картинки («битый» край, дающий шов при тайлинге)
  mirror?: boolean; // тайлить зеркально: края тайлов всегда совпадают
}

/** Фон-шейдер: «закрученная краска» (как фон Balatro) в трёх цветах: тёмный, средний, светлый. */
export interface BackgroundShaderDef {
  type: 'swirl';
  colors: [string, string, string]; // #rrggbb: основной, акцент, тёмный
  speed?: number; // скорость течения краски (1 — обычная)
  spin?: number; // сила закрутки (1 — обычная)
  contrast?: number; // контраст краски (3.5 — как в оригинале)
  pixel?: number; // размер «пикселя» шейдера в px арта (по умолчанию 3; 0 — не пикселизовать)
  zoom?: number; // частота пятен (по умолчанию 30; меньше — крупнее и спокойнее)
}

export interface BackgroundDef {
  id: string;
  sky_color: string;
  scale: number;
  ground_color?: string; // цвет «земли» под нижним краем фона (заливка вниз до края экрана)
  ground_offset?: number; // на сколько px от низа уровня приподняты слои (нижний край фона над землёй)
  layers: BackgroundLayerDef[]; // снизу вверх (у фона-шейдера пусто)
  shader?: BackgroundShaderDef; // вместо слоёв: фон рисует шейдер
  gradient?: Array<{ at: number; color: string }>; // вместо слоёв: вертикальный градиент по остановкам (at 0..1 сверху вниз, color #rrggbb), без параллакса
}
