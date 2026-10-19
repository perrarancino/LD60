import { Application, Container, Graphics } from 'pixi.js';
import { SpriteLibrary } from './assets/SpriteLibrary.ts';
import type { BackgroundDef, EnemyDef, EnemySpawnDef, LevelDef, RigDef, TileSetDef } from './data/types.ts';
import { Enemy } from './entities/Enemy.ts';
import { Spider } from './entities/Spider.ts';
import { SpiderMother } from './entities/SpiderMother.ts';
import { Particles } from './effects/Particles.ts';
import { ColorGrade } from './effects/ColorGrade.ts';
import { Lighting } from './effects/Lighting.ts';
import { PUNCH_FX, SMOKE_FX, SpriteEffects } from './effects/SpriteEffects.ts';
import { isPartDamageable } from './entities/Hittable.ts';
import type { Hittable } from './entities/Hittable.ts';
import { Worm } from './entities/Worm.ts';
import { WormBoss } from './entities/WormBoss.ts';
import type { WormBossHooks } from './entities/WormBoss.ts';
import { BirdBoss } from './entities/BirdBoss.ts';
import type { BirdBossHooks } from './entities/BirdBoss.ts';
import { BossBird } from './entities/BossBird.ts';
import { CrabBoss, CRAB_ORB_DAMAGE } from './entities/CrabBoss.ts';
import type { CrabBossHooks } from './entities/CrabBoss.ts';
import { CrabOrb } from './entities/CrabOrb.ts';
import { ShaderBackground } from './world/ShaderBackground.ts';
import { GradientBackground } from './world/GradientBackground.ts';
import { BossBar } from './ui/BossBar.ts';
import { Critter } from './entities/Critter.ts';
import { Player } from './entities/Player.ts';
import type { Strike } from './entities/Player.ts';
import { Level } from './world/Level.ts';
import { LevelObjects } from './world/Objects.ts';
import { RoomMap } from './world/Rooms.ts';
import { RoomFog } from './world/RoomFog.ts';
import { Minimap } from './ui/Minimap.ts';
import { Quest } from './systems/Quest.ts';
import type { Leash } from './world/Rooms.ts';
import { ParallaxBackground } from './world/ParallaxBackground.ts';
import { GAME_CONFIG } from './core/Constants.ts';
import { InputManager } from './core/InputManager.ts';
import { FpsCounter } from './core/FpsCounter.ts';
import { pal } from './core/Palette.ts';
import { DamageNumbers, loadDamageFont } from './effects/DamageNumbers.ts';
import { EventBus } from './core/EventBus.ts';
import { Armor, MODELS } from './systems/ArmorSystem.ts';
import { LootSystem } from './systems/LootSystem.ts';
import { ProjectileSystem } from './entities/ProjectileSystem.ts';
import { Hud } from './ui/Hud.ts';
import { TerminalUI } from './ui/TerminalUI.ts';
import { Terminal } from './entities/Terminal.ts';
import { CipherCluesView } from './entities/CipherCluesView.ts';
import { PasswordTerminalEntity } from './entities/PasswordTerminalEntity.ts';
import { WorldProgression } from './systems/WorldProgression.ts';
import { PuzzleSystem } from './systems/PuzzleSystem.ts';
import type { CipherTerminalPuzzle } from './systems/CipherTerminalPuzzle.ts';
import { Debris } from './effects/Debris.ts';
import { BLUE, LightningBeam, LightningFx, LIGHTNING_SPARKS } from './effects/Lightning.ts';
import { EnemyBolts } from './effects/EnemyBolts.ts';
import type { InputState } from './core/InputManager.ts';
import cursorUrl from '../assets/sprites/ui/cursor.png';
import { SoundManager } from './audio/SoundManager.ts';
import cursorInteractUrl from '../assets/sprites/ui/cursor_interact.png';
import { getSharedOutlineFilter } from './effects/OutlineFilter.ts';

// Загрузка начальных параметров игрока из конфигурационного JSON
import playerData from '../data/player/player_initial_state.json';
import enemiesData from '../data/enemies/enemies.json';
import tilesData from '../data/tiles/tiles.json';

// Все уровни из data/levels/
const LEVELS = Object.values(
  import.meta.glob('../data/levels/*.json', { eager: true, import: 'default' }) as Record<string, LevelDef>
);

const urlParams = new URLSearchParams(window.location.search);
const requestedLevel = urlParams.get('level');
/** Уровень открыт отладочной клавишей (1–5): без тумана войны, все двери открыты — карту видно и проходить можно целиком. */
const DEBUG_MODE = urlParams.get('debug') === '1';
let activeLevelDef: LevelDef = (requestedLevel
  ? LEVELS.find(l => l.id === requestedLevel || l.id.includes(requestedLevel) || (requestedLevel === 'map' && l.id === 'world_prototype'))
  : undefined) ?? (LEVELS.find(l => l.id === 'world_prototype') || LEVELS[0]); // без ?level= игра сразу открывает полную карту (первая локация)

/**
 * Свежая версия уровня с диска: редактор открывает игру с ?live=1, и сервер (vite или exe-редактор) отдаёт уровень, только что сохранённый
 * в data/levels, — пересборка игры не нужна. Не вышло — играем вшитую в сборку версию.
 */
async function loadLiveLevel(base: LevelDef): Promise<LevelDef> {
  if (urlParams.get('live') !== '1') return base;
  try {
    const res = await fetch(`./api/ld60/level?id=${encodeURIComponent(base.id)}`, { cache: 'no-store' });
    if (res.ok) return (await res.json()) as LevelDef;
  } catch { /* сервера с уровнями нет — вшитая версия */ }
  return base;
}

// Куда поставить героя: у двери (?door=id, пришёл с другого уровня) или в точку (?spawn=x,y — клетки, «играть отсюда» из редактора)
const requestedDoor = urlParams.get('door');
const requestedSpawn = (urlParams.get('spawn') ?? '').split(',').map(Number);

// Все риги из data/rigs (враги-«сборные», например паук, выбирают свой по rig_id)
const RIGS = Object.values(
  import.meta.glob('../data/rigs/*.json', { eager: true, import: 'default' }) as Record<string, RigDef>
);

// Все параллакс-фоны из data/backgrounds (уровень выбирает свой по background_id)
const BACKGROUNDS = Object.values(
  import.meta.glob('../data/backgrounds/*.json', { eager: true, import: 'default' }) as Record<string, BackgroundDef>
);

// Удар героя
const FIST_RADIUS = 6; // px: «толщина» кулака при проверке попаданий
const FORE_ARM_START = 0.4; // с какой доли длины руки от плеча считается ударной частью (плечо в теле не бьёт)
const PUNCH_SPARKS = [0xffffff, 0xdbe9f7, 0x9fb4c8]; // искры удара — цвета эффекта punch
const ZAP_COLORS = [pal('cobalt', 5), pal('cobalt', 6), pal('cobalt', 7), pal('electric', 7)]; // искры электрокрысы
const WHIP_DAMAGE = 22; // урон хвоста электрокрысы
const SPIDER_SIGHT = 170; // px: паук замечает героя и бежит к нему
const BABY_SIGHT = 520; // px: паучки матки бегут на героя почти из всей комнаты
const THROWN_SPIDER_SIGHT = 300; // px: пауки, которых швырнул краб
const BOSS_SPIDER_SIGHT = 480; // px: паучки из тела босса-червя
const BOSS_SPIDER_LIFE = 22; // с: через сколько паучки босса-червя исчезают
const BOSS_SPIDER_SCALE = 0.85;
const BOSS_SPIDER_CONTACT = 0.7; // доля контактного урона обычного паука: роем они бьют чаще
const BOSS_SPIDER_MAX = 8; // сколько паучков босса-червя может быть живо разом (если не задано в data)
const CONTACT_COOLDOWN = 1.0; // с: пауза между контактными ударами одного моба
const HIT_SHAKE = 1.5; // px арта: тряска камеры при попадании
const CRIT_SHAKE = 2.5;
const SHAKE_DECAY = 14; // 1/с: как быстро тряска затухает
const SHAKE_FREQ = 17; // Гц: частота колебаний тряски
const BIRD_HP = 5; // здоровье птички босса-птицы: гибнет от любого удара
const BIRD_DAMAGE = 10; // клевок птички
const BOSS_FEATHERS = [pal('cobalt', 5), pal('cobalt', 6), pal('cobalt', 7), pal('gold', 5)]; // перья босса-птицы
const ORB_HP = 4; // шар краба: разбивается любым ударом
const CRAB_FEATHERS = [pal('virus', 4), pal('virus', 5), pal('virus', 6), pal('gold', 5)]; // искры гибели краба
const LAND_DUST = [0x9fb4c8, 0x6f8296, 0xdbe9f7]; // пыль при тяжёлом приземлении героя

/** Здоровье врага: сколько осталось, из скольких; view — что рисуется (убирается при смерти); remove — вычеркнуть из списков игры. */
interface Mob {
  hp: number;
  max: number;
  view: Container;
  remove: () => void;
}

// Вертикальная камера: плавно следует за героем (экспоненциальное сглаживание)
const CAMERA_REST_Y = 0.64; // доля высоты экрана, на которой камера старается держать ноги героя
const CAMERA_FOLLOW_GROUNDED = 5; // 1/с: скорость сближения, когда герой стоит на земле
const CAMERA_FOLLOW_AIR = 3; // 1/с: в воздухе камера следует чуть мягче
const CAMERA_AIR_MIN_SHARE = 0.3; // доля высоты полёта, за которой камера идёт в воздухе при малых прыжках (экран не дёргается от каждого прыжка)
const CAMERA_AIR_FULL_AT = 220; // px: при отрыве от земли на столько и больше (подъём по стене, длинное падение) камера следует за героем полностью
const CAMERA_TOP_MARGIN = 76; // px: ближе к верху ноги не подпускаем (иначе не влезет голова) — страховка
const CAMERA_BOTTOM_MARGIN = 24; // px от низа экрана — страховка

class GameApp {
  private app: Application;
  private input: InputManager;

  private gameContainer: HTMLElement;
  private sprites = new SpriteLibrary();
  private worldLayer!: Container;
  private level!: Level;
  private player!: Player;
  private enemies: Enemy[] = [];
  private spiders: Spider[] = [];
  private worms: Worm[] = [];
  private mothers: SpiderMother[] = [];
  private bosses: WormBoss[] = [];
  private birdBosses: BirdBoss[] = []; // боссы-птицы второй локации
  private birds: BossBird[] = []; // птички, которых выпускает босс-птица
  private crabBosses: CrabBoss[] = []; // финальный босс-краб
  private orbs: CrabOrb[] = []; // золотые шары краба
  private bossBar = new BossBar(); // полоса здоровья босса в бою
  private readonly bossSummons = new Set<Critter>(); // обитатели локации, которых босс-птица призвала на посадке (и краб швырнул)
  private readonly thrownSpiders = new Set<Spider>(); // пауки, которых швырнул краб
  private enemyDefs = new Map<string, EnemyDef>();
  private critters: Critter[] = []; // мелкие мобы второй локации: крыса, воробей, страж
  private fx = new Particles(); // частицы: брызги, пыль, след
  private sceneLayer!: Container; // фон, мир и свет — всё, что проходит цветокоррекцию (интерфейс — отдельно)
  private grade: ColorGrade | null = null; // цветокоррекция уровня
  private lighting: Lighting | null = null; // освещение: свечение фиолетовых деталей мобов и зелёный свет от фона
  private spriteFx!: SpriteEffects; // покадровые эффекты: удар по врагу, дым отскока от стены
  private punchHits = new Set<Hittable>(); // кого уже задел текущий удар (один удар — одно попадание)
  private punchHitId = 0;
  private readonly mobs = new Map<Hittable, Mob>(); // здоровье врагов
  private readonly numbers = new DamageNumbers(); // цифры урона (поверх цветокоррекции, под ним ничего нет)
  private shake = 0; // px арта: текущая сила тряски камеры
  private shakePhase = 0;
  private readonly combat = (playerData as unknown as { combat?: { punch_damage: [number, number]; crit_chance?: number; crit_multiplier?: number } }).combat
    ?? { punch_damage: [5, 8] as [number, number] };

  private loot!: LootSystem;
  private projectiles!: ProjectileSystem;
  private hud!: Hud;
  private terminalUI!: TerminalUI;
  private terminals: Terminal[] = [];
  private cipherPuzzle!: CipherTerminalPuzzle;
  private cipherCluesView!: CipherCluesView;
  private passwordTerminal: PasswordTerminalEntity | null = null;
  private rooms!: RoomMap; // комнаты уровня: туман войны и привязка мобов
  private fog: RoomFog | null = null; // туман войны по комнатам (уровень с полем fog и комнатами)
  private readonly minimap = new Minimap(); // миникарта слева сверху
  private objects: LevelObjects | null = null; // двери, квестовые предметы, подставки
  private readonly leashOf = new Map<Hittable, Leash>(); // моб -> его комната
  private lastErrorAt = 0;
  private readonly gone = new WeakSet<Hittable>(); // уже погибшие и убранные с экрана: по ним не бьём и не уничтожаем повторно
  private debris = new Debris();
  private boltFx = new LightningFx(); // вспышка молнии каждого третьего удара
  private beam!: LightningBeam; // луч молнии из руки
  private enemyBolts!: EnemyBolts; // синие отражающиеся молнии стража
  private readonly bossSpiders = new Set<Spider>(); // паучки из тела босса-червя
  private flashLayer = new Graphics(); // вспышка на весь экран
  private flashAlpha = 0;
  private flashColor = pal('gold', 7); // цвет вспышки на весь экран (молния героя — золотая, удары краба — розовая)
  private flashDone = -1; // номер удара, для которого вспышка уже сработала
  private deathTimer = 0; // с до возрождения (герой погиб)
  private readonly contactDmg = new Map<Hittable, number>(); // контактный урон мобов по герою
  private readonly contactCd = new Map<Hittable, number>(); // пауза между ударами одного моба

  // Размер видимой области в «виртуальных» пикселях: растёт вместе с окном, пиксели не растягиваются
  private viewW: number = GAME_CONFIG.VIRTUAL_WIDTH;
  private viewH: number = GAME_CONFIG.VIRTUAL_HEIGHT;
  private grid = new Graphics();
  private readonly backgrounds: Array<{ id: string; bg: ParallaxBackground | ShaderBackground | GradientBackground; alpha: number }> = []; // все фоны уровня: свой у комнаты — включается при входе героя
  private activeBg = '';
  private bgBottom = 0; // низ, на котором «стоит» фон: у уровня из комнат — низ комнаты героя (иначе на высокой карте фон остался бы внизу карты, вне кадра)
  private scale = 1;
  private cameraY = 0;
  private groundRefY = 0; // высота ног при последнем касании земли
  private cameraReady = false;
  private pointer: { x: number; y: number } | null = null; // курсор в пикселях окна
  private defaultCursorStyle = `url("${cursorUrl}") 0 0, auto`;
  private hoverCursorStyle = `url("${cursorInteractUrl}") 0 0, pointer`;
  private currentCursor = '';

  private setCursor(hovered: boolean): void {
    const style = hovered ? this.hoverCursorStyle : this.defaultCursorStyle;
    if (this.currentCursor !== style) {
      this.currentCursor = style;
      this.app.canvas.style.cursor = style;
    }
  }

  constructor() {
    this.app = new Application();
    this.input = InputManager.get();
    this.gameContainer = document.getElementById('game-container')!;
    this.hud = new Hud();
    this.terminalUI = new TerminalUI();
    this.cipherPuzzle = PuzzleSystem.get().cipherTerminalPuzzle;
    SoundManager.get().init();

    window.addEventListener('keydown', (e) => {
      this.passwordTerminal?.handleKeyInput(e);
    });

    // Смена брони: прежняя надетая часть отваливается физическим обломком (падает, подпрыгивает, потом исчезает), герой перекрашивается
    EventBus.get().on('armor:changed', (e: { slot: 'head' | 'torso' | 'arms' | 'legs'; from: number; to: number }) => {
      if (!this.player) return;
      const b = this.player.body;
      const pieces = this.player.detachPieces(e.slot);
      if (pieces.length) {
        this.debris.spawn(pieces, -this.player.facingDir);
        this.fx.burst(b.x, b.y - 28, { count: 14, colors: [0xd5ebff, 0x97b2c9, 0xfbc53d], speed: [60, 170], spread: Math.PI * 2, life: [0.2, 0.45], size: [1, 2] });
      }
      this.player.setArmor(Armor.get().equipped);
      if (e.to > 0) this.fx.burst(b.x, b.y - 28, { count: 10, colors: LIGHTNING_SPARKS, speed: [40, 120], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
    });
  }

  public async start(): Promise<void> {
    // Асинхронная инициализация PixiJS v8 в режиме пиксель-арта
    await this.app.init({
      width: GAME_CONFIG.VIRTUAL_WIDTH,
      height: GAME_CONFIG.VIRTUAL_HEIGHT,
      backgroundColor: GAME_CONFIG.BACKGROUND_COLOR,
      roundPixels: true,
      antialias: false,
      resolution: 1
    });

    this.gameContainer.appendChild(this.app.canvas);
    document.body.style.cursor = this.defaultCursorStyle;
    this.gameContainer.style.cursor = this.defaultCursorStyle;
    this.setCursor(false);
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('pointermove', (e) => (this.pointer = { x: e.clientX, y: e.clientY }));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        window.location.href = './editor.html';
      }
      // Отладка: клавиши 1–5 переключают уровень (у уровня в JSON задан debug_key): 1 — полная карта (world_prototype) с мобами, туманом и закрытыми дверьми, 2 — локация 2, 3 — босс-червь, 4 — босс-птица, 5 — краб
      if (/^[1-9]$/.test(e.key) && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const next = LEVELS.find((l) => l.debug_key === Number(e.key));
        if (next && (next.id !== activeLevelDef.id || DEBUG_MODE)) {
          const url = new URL(window.location.href);
          url.searchParams.set('level', next.id);
          url.searchParams.delete('debug'); // клавиша открывает уровень как обычно: туман, закрытые двери
          url.searchParams.delete('door');
          url.searchParams.delete('spawn');
          window.location.href = url.toString();
        }
      }
    });

    activeLevelDef = await loadLiveLevel(activeLevelDef);
    document.title = `${activeLevelDef.display_name} — LD60`;
    console.log(`[Game] Загружен уровень: ${activeLevelDef.display_name} (ID: ${activeLevelDef.id})`);
    await loadDamageFont();
    await this.setupScene();

    // Запуск основного игрового цикла (Pixi ticker)
    const fps = new FpsCounter(this.app.ticker); // счётчик FPS в углу (F3 — скрыть, F4 — лимит кадров)
    this.app.ticker.add((ticker) => {
      const dt = ticker.deltaTime / 60; // Перевод тиков в секунды
      fps.tick(ticker.deltaMS);
      try {
        this.update(dt);
      } catch (e) {
        // сбой в одном кадре не должен останавливать игру целиком: пишем в консоль (раз в секунду, чтобы не заливать её) и идём дальше
        const now = performance.now();
        if (now - this.lastErrorAt > 1000) console.error('[Game] ошибка в кадре:', e);
        this.lastErrorAt = now;
      }
    });
  }

  /**
   * Полноэкранный режим без растягивания и с рендером в родном разрешении экрана:
   * холст = физические пиксели окна, сцена масштабируется целым числом (по высоте окна к эталонной),
   * поэтому повёрнутые части тела и подпиксельные сдвиги рисуются без «дрожания» пикселей низкого разрешения,
   * а область обзора камеры растёт вместе с окном.
   */
  private handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const physW = Math.round(window.innerWidth * dpr);
    const physH = Math.round(window.innerHeight * dpr);

    this.scale = Math.max(1, Math.round(physH / GAME_CONFIG.VIRTUAL_HEIGHT)); // целых физ. пикселей на 1 пиксель арта
    this.viewW = physW / this.scale;
    this.viewH = physH / this.scale;

    this.app.renderer.resize(physW, physH);
    this.app.stage.scale.set(this.scale);
    const canvas = this.app.canvas;
    canvas.style.width = `${physW / dpr}px`;
    canvas.style.height = `${physH / dpr}px`;

    this.drawGrid();
    this.lighting?.resize(physW, physH, this.scale);
    for (const b of this.backgrounds) b.bg.resize(this.viewW, this.viewH);
    if (this.level) this.updateCamera();
  }

  /** Фоновая сетка токоведущих дорожек материнской платы (неподвижная, на весь обзор). */
  private drawGrid(): void {
    const g = this.grid;
    g.clear();
    g.setStrokeStyle({ width: 1, color: 0x18202c, alpha: 0.6 });
    for (let x = 0; x < this.viewW; x += 16) g.moveTo(x, 0).lineTo(x, this.viewH);
    for (let y = 0; y < this.viewH; y += 16) g.moveTo(0, y).lineTo(this.viewW, y);
    g.stroke();
  }

  /** Курсор мыши в мировых координатах (null, пока мышь не двигали). */
  private aimInWorld(): { x: number; y: number } | null {
    if (!this.pointer) return null;
    const canvas = this.app.canvas;
    const rect = canvas.getBoundingClientRect();
    const toPhys = canvas.width / rect.width; // CSS px -> физические px
    return {
      x: ((this.pointer.x - rect.left) * toPhys) / this.scale - this.worldLayer.x,
      y: ((this.pointer.y - rect.top) * toPhys) / this.scale - this.worldLayer.y
    };
  }

  /**
   * Камера. По X следует за героем (если уровень уже обзора — центрируется). По Y — плавное следование: камера
   * экспоненциально подтягивается к высоте героя (на земле быстрее, в воздухе мягче); страховочные поля не дают герою
   * выйти из кадра при быстром падении.
   */
  private updateCamera(dt = 0): void {
    const body = this.player.body;
    const lw = this.level.pixelWidth;
    const lh = this.level.pixelHeight;

    const camX = lw <= this.viewW
      ? -(this.viewW - lw) / 2
      : Math.max(0, Math.min(lw - this.viewW, body.x - this.viewW / 2));

    let camY: number;
    if (lh <= this.viewH) {
      camY = lh - this.viewH;
    } else {
      const maxY = lh - this.viewH;
      const feet = body.y;
      if (!this.cameraReady || body.grounded) this.groundRefY = feet;
      // В воздухе камера следует за высотой героя не полностью: при малых прыжках — лишь частично (плавно растёт доля до полной
      // при большом отрыве от земли), так нет резких скачков экрана
      const dy = feet - this.groundRefY;
      const t = Math.max(0, Math.min(1, (Math.abs(dy) - 80) / (CAMERA_AIR_FULL_AT - 80)));
      const share = body.grounded ? 1 : CAMERA_AIR_MIN_SHARE + (1 - CAMERA_AIR_MIN_SHARE) * t * t * (3 - 2 * t);
      const followFeet = this.groundRefY + dy * share;
      let target = Math.max(0, Math.min(maxY, followFeet - this.viewH * CAMERA_REST_Y));
      const focus = this.crabBosses.find((b) => b.active)?.focusTop();
      if (focus !== undefined) target = Math.max(0, Math.min(target, focus - 14)); // верх босса остаётся в кадре (ноги героя держат страховочные поля ниже)
      if (!this.cameraReady) {
        this.cameraY = target;
        this.cameraReady = true;
      } else {
        const rate = body.grounded ? CAMERA_FOLLOW_GROUNDED : CAMERA_FOLLOW_AIR;
        this.cameraY += (target - this.cameraY) * (1 - Math.exp(-rate * dt));
      }
      // Страховка: герой не должен выходить за поля кадра
      this.cameraY = Math.min(this.cameraY, feet - CAMERA_TOP_MARGIN);
      this.cameraY = Math.max(this.cameraY, feet - (this.viewH - CAMERA_BOTTOM_MARGIN));
      this.cameraY = Math.max(0, Math.min(maxY, this.cameraY));
      camY = this.cameraY;
    }

    // Камера выровнена по физическим пикселям: тайлы остаются чёткими, герой и камера не дрожат друг относительно друга
    const snap = (v: number) => Math.round(v * this.scale) / this.scale;
    // тряска: затухающее колебание по времени (две несоизмеримые частоты — траектория не по прямой), без случайных скачков кадр к кадру;
    // сдвиг выравнивается по физическим пикселям, поэтому ход плавный, а не ступенями по пикселю арта
    this.shake *= Math.exp(-SHAKE_DECAY * dt);
    if (this.shake < 0.02) this.shake = 0;
    this.shakePhase += dt * Math.PI * 2 * SHAKE_FREQ;
    const sx = this.shake ? snap(this.shake * Math.sin(this.shakePhase)) : 0;
    const sy = this.shake ? snap(this.shake * Math.sin(this.shakePhase * 1.37 + 1.9)) : 0;
    this.worldLayer.position.set(-snap(camX) + sx, -snap(camY) + sy);
    this.numbers.container.position.copyFrom(this.worldLayer.position);
    for (const b of this.backgrounds) if (b.alpha > 0.001) b.bg.update(snap(camX), snap(camY), this.bgBottom || lh, this.scale);
    // тайлы вне экрана (с запасом в клетку) не рисуются — ни в кадре, ни в проходах света
    const m = this.level.tileSize;
    this.level.cull(snap(camX) - m, snap(camX) + this.viewW + m, snap(camY) - m, snap(camY) + this.viewH + m);
  }

  /**
   * Сцена: фоновая сетка, тестовый уровень из data/levels, герой и враги
   */
  private async setupScene(): Promise<void> {
    this.sceneLayer = new Container();
    this.app.stage.addChild(this.sceneLayer);
    this.sceneLayer.addChild(this.grid);
    this.drawGrid();

    const tileset = tilesData as TileSetDef;
    const levelDef = activeLevelDef;
    const enemyDefs = new Map((enemiesData as unknown as EnemyDef[]).map((e) => [e.id, e]));
    this.enemyDefs = enemyDefs;

    // Параллакс-фон уровня (если задан)
    const bgDef = levelDef.background_id ? BACKGROUNDS.find((b) => b.id === levelDef.background_id) : undefined;
    if (levelDef.background_id && !bgDef) throw new Error(`Уровень ссылается на неизвестный фон "${levelDef.background_id}"`);

    // Загружаем только те спрайты, которые реально нужны уровню
    // Герой собирается из частей двух моделей (прежний герой и герой второй локации) — какие части надеты, решает броня (терминалы)
    const modelRigs = MODELS.map((m) => {
      const rig = RIGS.find((r) => r.id === m.rig_id);
      if (!rig) throw new Error(`Модель героя ссылается на неизвестный риг "${m.rig_id}"`);
      return rig;
    });
    const heroSpriteId = MODELS[0].sprite_id;
    const rigDef = modelRigs[0];
    await this.sprites.load([
      PUNCH_FX.sprite,
      SMOKE_FX.sprite,
      'bullet1',
      'mat_scrap',
      'ui_cursor',
      'ui_cursor_interact',
      ...(levelDef.terminals ?? []).map((t) => t.sprite_id),
      ...this.levelBackgrounds(levelDef).flatMap((b) => ParallaxBackground.spriteIds(b)),
      heroSpriteId,
      ...MODELS.map((m) => m.sprite_id),
      ...modelRigs.flatMap((r) => r.parts.flatMap((p) => [p.sprite_id, ...(p.face?.sprite_id ? [p.face.sprite_id] : [])])),
      ...Level.spriteIds(levelDef, tileset),
      ...levelDef.enemies.map((e) => e.sprite_id),
      // спрайты врагов из зон спавна
      ...(levelDef.spawn_zones ?? []).map((z) => z.sprite_id || enemyDefs.get(z.enemy_id)?.sprite_variants[0] || '').filter(Boolean),
      // части тела врагов, собранных из слоёв (паук, червь, паучиха), и тех, кого они порождают
      ...levelDef.enemies.flatMap((e) => this.enemySpriteIds(enemyDefs, e.enemy_id, e.sprite_id)),
      ...(levelDef.spawn_zones ?? []).flatMap((z) => {
        const sId = z.sprite_id || enemyDefs.get(z.enemy_id)?.sprite_variants[0] || '';
        return sId ? this.enemySpriteIds(enemyDefs, z.enemy_id, sId) : [];
      })
    ]);

    // Фон уровня и фоны комнат (room.background_id): у каждого свой объект, показывается тот, что у комнаты героя (плавная смена)
    const bgDefs = this.levelBackgrounds(levelDef);
    for (const def of bgDefs) {
      const bg = def.gradient ? new GradientBackground(def) : def.shader ? new ShaderBackground(def) : new ParallaxBackground(def, this.sprites);
      const isDefault = def.id === levelDef.background_id;
      this.backgrounds.push({ id: def.id, bg, alpha: isDefault ? 1 : 0 });
      bg.container.visible = isDefault;
      this.sceneLayer.addChild(bg.container);
      bg.resize(this.viewW, this.viewH);
    }
    if (bgDefs.length) {
      this.grid.visible = false; // вместо технической сетки — фон
      this.activeBg = levelDef.background_id ?? bgDefs[0].id;
      this.backgrounds.forEach((b, i) => this.sceneLayer.setChildIndex(b.bg.container, i + 1)); // сразу за сеткой (она первая в сцене)
    }

    this.worldLayer = new Container();
    this.sceneLayer.addChild(this.worldLayer);

    this.level = new Level(levelDef, tileset, this.sprites);
    this.worldLayer.addChild(this.level.backLayer); // декор за тайлами (куллер) и отростки паутины
    this.worldLayer.addChild(this.level.container);
    this.worldLayer.addChild(this.level.frontLayer); // декор поверх тайлов (транзисторы)

    this.rooms = new RoomMap(levelDef.rooms, this.level.tileSize, levelDef.width, levelDef.height);
    WorldProgression.get().reset();
    WorldProgression.get().debugOpenAll = DEBUG_MODE;

    // Настенный шифр: спавн цифр от 0 до 9 с римскими номерами в комнатах 1-й локации
    this.cipherPuzzle.spawnCluesForLevel(levelDef, this.level, this.rooms);
    this.cipherCluesView = new CipherCluesView(this.cipherPuzzle);
    this.worldLayer.addChild(this.cipherCluesView.container);

    // Собираем всех врагов: фиксированные спавны + сгенерированные строго на полу из зон спавна
    const allEnemies = [...levelDef.enemies];
    if (levelDef.spawn_zones) {
      for (const zone of levelDef.spawn_zones) {
        const floorPoints = this.level.findFloorPositionsInZone(zone);
        if (floorPoints.length > 0) {
          const count = Math.min(zone.count, floorPoints.length);
          for (let i = 0; i < count; i++) {
            const pickIdx = Math.floor(Math.random() * floorPoints.length);
            const pt = floorPoints.splice(pickIdx, 1)[0];
            const def = enemyDefs.get(zone.enemy_id);
            if (!def) continue;
            const spriteId = zone.sprite_id || def.sprite_variants[0] || '';
            allEnemies.push({
              enemy_id: zone.enemy_id,
              sprite_id: spriteId,
              x: pt.x,
              y: pt.y,
              surface: 'floor'
            });
          }
        }
      }
    }

    for (const spawn of allEnemies) {
      const def = enemyDefs.get(spawn.enemy_id);
      if (!def) throw new Error(`Уровень ссылается на неизвестного врага "${spawn.enemy_id}"`);
      if (def.behavior_type === 'crawler') {
        // Ползающий враг (паук): процедурное тело по поверхностям тайлов
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const spider = new Spider(def, spawn, this.level, rig, this.sprites);
        spider.leash = this.bindRoom(spider, spawn);
        this.spiders.push(spider);
        this.worldLayer.addChild(spider.container);
        this.trackSpider(spider, def.stats.max_health, def.stats.contact_damage);
        continue;
      }
      if (def.behavior_type === 'spawner') {
        // Паучиха-матка: сидит на фоне (под тайлами), шатает лапками и выплёвывает паучков
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const motherRoom = this.homeLeash(spawn);
        const mother = new SpiderMother(def, spawn, this.level.tileSize, rig, this.sprites, this.fx,
          (x, y, vx, vy) => this.spawnBaby(enemyDefs, def, x, y, vx, vy, motherRoom), (baby) => this.worldLayer.addChildAt(baby.container, this.worldLayer.getChildIndex(this.fx.container)));
        mother.leash = this.bindRoom(mother, spawn);
        mother.target = () => ({ x: this.player.body.x, y: this.player.body.y - 20 });
        this.mothers.push(mother);
        this.worldLayer.addChildAt(mother.container, this.worldLayer.getChildIndex(this.level.container));
        this.track(mother, def.stats.max_health, mother.container, () => this.mothers.splice(this.mothers.indexOf(mother), 1));
        this.contactDmg.set(mother, def.stats.contact_damage);
        continue;
      }
      if (def.behavior_type === 'flying_worm') {
        // Босс-червь: летает сквозь тайлы за героем, рисуется под тайлами (часть тела в блоках скрыта маской)
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const boss = new WormBoss(def, spawn, this.level, rig, this.sprites, this.wormBossHooks(def));
        boss.leash = this.bindRoom(boss, spawn);
        this.bosses.push(boss);
        this.worldLayer.addChildAt(boss.container, this.worldLayer.getChildIndex(this.level.container));
        this.contactDmg.set(boss, def.stats.contact_damage);
        continue;
      }
      if (def.behavior_type === 'critter') {
        // Мелкие мобы второй локации: ходят, скачут, летают, следят за героем
        this.createCritter(def, spawn, false);
        continue;
      }
      if (def.behavior_type === 'flying_bird') {
        // Босс-птица второй локации: пролёты, стая птичек, посадка с призывом; рисуется поверх героя
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const boss = new BirdBoss(def, spawn, this.level, rig, this.sprites, this.birdBossHooks(def, rig));
        boss.leash = this.bindRoom(boss, spawn);
        this.birdBosses.push(boss);
        this.worldLayer.addChild(boss.container);
        continue;
      }
      if (def.behavior_type === 'crab_boss') {
        // Финальный босс-краб: ходит, прыгает, клешни на неоновых нитях, шары, метание мобов; рисуется поверх героя
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const boss = new CrabBoss(def, spawn, this.level, rig, this.sprites, this.crabBossHooks(rig));
        boss.leash = this.bindRoom(boss, spawn);
        this.crabBosses.push(boss);
        this.worldLayer.addChild(boss.container);
        continue;
      }
      if (def.behavior_type === 'burrower') {
        // Червь-землерой: рисуется под тайлами, чтобы часть тела внутри блоков была скрыта
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const worm = new Worm(def, spawn, this.level, rig, this.sprites, this.worms);
        worm.leash = this.bindRoom(worm, spawn);
        worm.hero = () => this.heroBox();
        worm.onBite = (x, y, dirX, dmg) => this.strikeHero(x, y, dirX, dmg, false);
        this.worms.push(worm);
        this.worldLayer.addChildAt(worm.container, this.worldLayer.getChildIndex(this.level.container));
        this.contactDmg.set(worm, def.stats.contact_damage);
        continue;
      }
      const enemy = new Enemy(def, spawn, this.level.tileSize, this.sprites);
      enemy.leash = this.bindRoom(enemy, spawn);
      this.enemies.push(enemy);
      this.worldLayer.addChild(enemy.sprite);
      this.track(enemy, def.stats.max_health, enemy.sprite, () => this.enemies.splice(this.enemies.indexOf(enemy), 1));
      this.contactDmg.set(enemy, def.stats.contact_damage);
    }

    // Уровень может выдать героя уже в броне (поле start_armor)
    if (levelDef.start_armor) Armor.get().grantTier(levelDef.start_armor);

    // Терминалы брони: стоят за героем
    for (const t of levelDef.terminals ?? []) {
      const term = new Terminal(t, this.level.tileSize, this.sprites);
      this.terminals.push(term);
      this.worldLayer.addChild(term.container);
    }

    // Объекты уровня: двери, квестовые предметы, подставки (стоят за героем)
    this.objects = new LevelObjects(levelDef, this.sprites, {
      travel: (levelId, doorId) => this.travelTo(levelId, doorId),
      teleport: (x, y) => this.teleportHero(x, y),
      denied: (x, y) => this.fx.burst(x, y, { count: 8, colors: [0xff0b08, 0xfc896b, 0xffe1d2], speed: [30, 90], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] }),
      collected: (x, y) => this.fx.burst(x, y, { count: 14, colors: LIGHTNING_SPARKS, speed: [40, 130], spread: Math.PI * 2, life: [0.2, 0.45], size: [1, 2] })
    });
    this.worldLayer.addChild(this.objects.container);
    this.level.obstacleCheck = (cx, cy) => this.objects?.isDoorBlocking(cx, cy) ?? false;

    // Терминал пароля на спрайте
    const pwdObj = levelDef.objects?.find((o) => o.type === 'password');
    if (pwdObj) {
      this.passwordTerminal = new PasswordTerminalEntity(pwdObj, this.sprites, this.cipherPuzzle);
      this.worldLayer.addChild(this.passwordTerminal.container);
    } else {
      this.passwordTerminal = null;
    }

    this.player = new Player(heroSpriteId, rigDef, this.sprites, modelRigs[1] ?? null);
    this.player.setArmor(Armor.get().equipped);
    const ts = this.level.tileSize;
    const door = requestedDoor ? this.objects.doorPoint(requestedDoor) : null;
    if (door) this.player.spawnAt(door.x / ts - 0.5, door.y / ts - 1, ts); // пришёл через дверь: встаёт у её двойника
    else if (requestedSpawn.length === 2 && requestedSpawn.every((n) => Number.isFinite(n))) this.player.spawnAt(requestedSpawn[0], requestedSpawn[1], ts);
    else this.player.spawnAt(levelDef.player_spawn.x, levelDef.player_spawn.y, ts);
    this.worldLayer.addChild(this.player.sprite);
    for (const b of this.birdBosses) this.worldLayer.addChild(b.container); // босс-птица пролетает поверх героя
    for (const b of this.crabBosses) this.worldLayer.addChild(b.container); // краб тоже
    this.rooms.updateHero(Math.floor(this.player.body.x / ts), Math.floor((this.player.body.y - 16) / ts));

    this.loot = new LootSystem(this.sprites, this.fx);
    this.worldLayer.addChild(this.loot.container);

    this.projectiles = new ProjectileSystem(
      this.sprites,
      this.fx,
      (t, x, y, dx, p, dmg) => this.damage(t, x, y, dx, p, dmg)
    );
    this.worldLayer.addChild(this.projectiles.container);
    this.worldLayer.addChild(this.debris.container); // отвалившиеся части брони
    this.beam = new LightningBeam(
      (t, x, y, dx, p, dmg) => this.damage(t, x, y, dx, p, dmg),
      (x, y, n) => this.fx.burst(x, y, { count: n, colors: LIGHTNING_SPARKS, speed: [30, 110], spread: Math.PI * 2, life: [0.1, 0.25], size: [1, 2] })
    );
    this.worldLayer.addChild(this.beam.container);
    this.worldLayer.addChild(this.boltFx.container);
    this.enemyBolts = new EnemyBolts(this.fx);
    this.worldLayer.addChild(this.enemyBolts.container);

    this.worldLayer.addChild(this.fx.container); // частицы поверх всего
    this.spriteFx = new SpriteEffects(this.sprites);
    this.worldLayer.addChild(this.spriteFx.container);
    // Отскок от стены: клуб дыма у стены на уровне корпуса
    this.player.onWallKick = (x, y, wallDir, along) => this.wallKickSmoke(x, y, wallDir, along);
    // Бросок: в момент отпускания снаряд стартует из кисти бросающей руки, в сторону курсора
    this.player.onThrowRelease = (x, y, dirX, dirY) => {
      const aim = this.aimInWorld() ?? { x: x + dirX * 100, y: y + dirY * 100 };
      this.projectiles.triggerSpecialAttack(x, y, aim.x, aim.y, this.hittables(), this.level);
    };
    // Тяжёлое приземление (герой теряет равновесие): пыль в обе стороны и тряска
    this.player.onHardLanding = (x, y, power) => this.hardLanding(x, y, power);
    // Обычное приземление с высоты: пыль из-под ног по силе удара
    this.player.onLanding = (x, y, power) => this.landingDust(x, y, power);
    // Освещение поверх мира, под интерфейсом (интерфейс добавится в сцену позже)
    // тени отбрасывают существа и транзисторы (слой декора поверх тайлов); тайлы, декор за тайлами и эффекты — нет
    this.lighting = new Lighting(this.app.renderer, this.worldLayer, [
      this.level.backLayer, this.level.container, this.fx.container, this.spriteFx.container, this.loot.container, this.projectiles.container,
      this.debris.container, this.beam.container, this.boltFx.container, this.enemyBolts.container, this.cipherCluesView.container, ...this.terminals.map((t) => t.container)
    ], this.level.container, [this.level.frontLayer], () => this.spiders.map((s) => s.container),
    () => [...this.spiders, ...this.worms, ...this.mothers, ...this.bosses].map((e) => e.container)); // мобы со светящимися пикселями сами светят
    if (levelDef.light) {
      const hex = (v?: string) => (v ? parseInt(v.slice(1), 16) : null);
      this.lighting.setColors(hex(levelDef.light.rim_color), hex(levelDef.light.fog_color));
    }
    // Мир на экран не рисуется напрямую: он один раз за кадр рисуется в текстуру (Lighting.update), а на экран выводится спрайтом из неё
    // с фильтром кромки, теней и тумана; слою мира в сцене места нет
    this.sceneLayer.removeChild(this.worldLayer);
    this.sceneLayer.addChild(this.lighting.sceneView);
    this.app.stage.addChild(this.lighting.overlay); // свет жуков и неон — поверх цветокоррекции, под интерфейсом
    if (!DEBUG_MODE && levelDef.fog && this.rooms.any) {
      this.fog = new RoomFog(this.level, this.rooms); // туман: вне комнаты героя всё чёрное, смена плавная (закрывает и свет жуков)
      this.app.stage.addChild(this.fog.container);
    }
    this.minimap.container.visible = (!!levelDef.fog && this.rooms.any) || (DEBUG_MODE && this.level.widthTiles > 60);
    this.app.stage.addChild(this.minimap.container);
    this.app.stage.addChild(this.flashLayer); // вспышка молнии на весь экран
    this.app.stage.addChild(this.numbers.container); // цифры урона — поверх всего, их не трогают ни свет, ни цветокоррекция
    this.app.stage.addChild(this.bossBar.container); // полоса здоровья босса
    if (levelDef.grade) {
      this.grade = new ColorGrade(levelDef.grade);
      this.grade.apply(this.sceneLayer);
    }
    this.lighting.resize(this.app.renderer.width, this.app.renderer.height, this.scale);
    this.updateCamera();
  }

  /** Фоны уровня: его собственный и фоны комнат (без повторов). */
  private levelBackgrounds(levelDef: LevelDef): BackgroundDef[] {
    const ids = [levelDef.background_id, ...(levelDef.rooms ?? []).map((r) => r.background_id)].filter((id): id is string => !!id);
    return [...new Set(ids)].map((id) => {
      const def = BACKGROUNDS.find((b) => b.id === id);
      if (!def) throw new Error(`Уровень ссылается на неизвестный фон "${id}"`);
      return def;
    });
  }

  /**
   * Смена фона по комнате: у комнаты героя задан background_id — плавно включается он (новый проявляется поверх прежнего, потом прежний гаснет);
   * вне комнат (коридоры) остаётся прежний.
   */
  private updateBackgrounds(dt: number): void {
    // фон стоит на низе комнаты героя (плавно): у многокомнатной карты нижний край мира далеко от героя
    const ts = this.level.tileSize;
    let bottom = 0;
    for (const idx of this.rooms.current) {
      const r = this.rooms.defs[idx];
      if (r) bottom = Math.max(bottom, (r.y + r.height) * ts);
    }
    if (bottom > 0) this.bgBottom = this.bgBottom ? this.bgBottom + (bottom - this.bgBottom) * (1 - Math.exp(-6 * dt)) : bottom;
    if (this.backgrounds.length < 2) return;
    for (const idx of this.rooms.current) {
      const id = this.rooms.defs[idx]?.background_id ?? activeLevelDef.background_id;
      if (id && id !== this.activeBg) {
        this.activeBg = id;
        const top = this.backgrounds.find((b) => b.id === id);
        if (top) {
          this.sceneLayer.setChildIndex(top.bg.container, this.backgrounds.length); // новый — выше прежних
          top.alpha = Math.min(top.alpha, 0.001);
        }
      }
      break;
    }
    const active = this.backgrounds.find((b) => b.id === this.activeBg);
    if (!active) return;
    active.alpha = Math.min(1, active.alpha + dt * 1.6);
    for (const b of this.backgrounds) {
      if (b !== active && active.alpha >= 1) b.alpha = 0; // новый проявился полностью — прежний убираем
      b.bg.container.visible = b === active || b.alpha > 0;
      b.bg.container.alpha = b === active ? active.alpha : 1;
    }
  }

  /** Комната-«дом» моба по его клетке спавна (или явному spawn.room); null — уровень без комнат / моб вне комнат. */
  private homeLeash(spawn: EnemySpawnDef): Leash | null {
    if (!this.rooms.any) return null;
    const room = this.rooms.homeOf(spawn.x, spawn.y, spawn.room);
    return room === null ? null : this.rooms.leash(room);
  }

  /** Привязывает моба к его комнате (замечает героя и бьёт только в ней); возвращает привязку для самого моба. */
  private bindRoom(target: Hittable, spawn: EnemySpawnDef): Leash | null {
    const leash = this.homeLeash(spawn);
    if (leash) {
      this.leashOf.set(target, leash);
      const roomDef = this.rooms.defs.find((r) => r.id === leash.id);
      WorldProgression.get().registerEnemy(leash.id, roomDef?.name ?? leash.id);
    }
    return leash;
  }

  /** Дверь ведёт на другой уровень: страница перезагружается с адресом уровня и двери, у которой герой появится. */
  private travelTo(levelId: string, doorId: string): void {
    Quest.get().carryOver(); // предметы и флаги переходят вместе с героем
    const url = new URL(window.location.href);
    url.searchParams.set('level', levelId);
    url.searchParams.delete('spawn');
    if (doorId) url.searchParams.set('door', doorId);
    else url.searchParams.delete('door');
    window.location.href = url.toString();
  }

  /** Перенос героя в точку (низ двери, мир px) внутри уровня: вспышка, камера не плывёт издалека. */
  private teleportHero(x: number, y: number): void {
    const ts = this.level.tileSize;
    const b = this.player.body;
    this.fx.burst(b.x, b.y - 28, { count: 12, colors: LIGHTNING_SPARKS, speed: [40, 120], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
    this.player.spawnAt(x / ts - 0.5, y / ts - 1, ts);
    this.fx.burst(x, y - 28, { count: 12, colors: LIGHTNING_SPARKS, speed: [40, 120], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
    this.cameraReady = false;
  }

  /** Всё, по чему можно ударить. */
  private *hittables(): Iterable<Hittable> {
    yield* this.enemies;
    yield* this.spiders;
    yield* this.worms;
    yield* this.mothers;
    yield* this.bosses;
    yield* this.birdBosses;
    yield* this.birds;
    yield* this.crabBosses;
    yield* this.orbs;
    yield* this.critters;
  }

  /**
   * Попадания кулака героя: пока кулак выброшен, проверяется отрезок «предплечье — кулак» с толщиной FIST_RADIUS против кругов
   * попадания врагов. Каждый удар задевает каждого врага один раз: вспышка, отдача, эффект punch по направлению удара и искры.
   */
  private resolveStrike(): void {
    const strike = this.player.strike;
    if (!strike) return;
    if (strike.id !== this.punchHitId) {
      this.punchHitId = strike.id;
      this.punchHits.clear();
    }
    const ax = strike.x1 + (strike.x2 - strike.x1) * FORE_ARM_START;
    const ay = strike.y1 + (strike.y2 - strike.y1) * FORE_ARM_START;
    for (const target of [...this.hittables()]) { // копия: попадание может выбить часть или убить цель — списки меняются на ходу
      if (this.gone.has(target) || this.punchHits.has(target)) continue; // цель могла погибнуть от цепной молнии раньше, чем до неё дошла очередь
      const contact = this.strikeContact(strike, ax, ay, target);
      if (!contact) continue;
      this.punchHits.add(target);
      target.onHit(strike.dirX, strike.dirY, contact.part);
      this.landPunch(contact.x, contact.y, strike);
      this.damage(target, contact.x, contact.y, strike.dirX, contact.part);
      const armor = Armor.get();
      if (armor.hasLightning && strike.id % armor.flashEvery === 0 && this.flashDone !== strike.id) {
        this.flashDone = strike.id; // одна вспышка на удар
        this.lightningFlash(contact.x, contact.y, target, contact.part, strike.dirX);
      }
    }
  }

  /** Регистрирует врага: здоровье, что рисуется и как вычеркнуть его из списков игры. */
  private track(target: Hittable, maxHp: number, view: Container, remove: () => void): void {
    this.mobs.set(target, { hp: maxHp, max: maxHp, view, remove });
  }

  private trackSpider(spider: Spider, maxHp: number, contact = 0, sight = SPIDER_SIGHT): void {
    spider.hero = () => ({ x: this.player.body.x, y: this.player.body.y });
    spider.sight = sight; // заметив героя, паук бежит к нему
    if (contact > 0) this.contactDmg.set(spider, contact);
    this.track(spider, maxHp, spider.container, () => {
      this.spiders.splice(this.spiders.indexOf(spider), 1);
      spider.expired = true; // матка считает живых паучков по этому флагу
    });
  }

  /** Урон от удара: случайный в диапазоне, иногда критический; цифра урона и тряска; при нуле — смерть. */
  private damage(target: Hittable, x: number, y: number, dirX: number, part?: number, customDmg?: number): void {
    if (this.gone.has(target)) return;
    const mob = this.mobs.get(target);
    const byParts = isPartDamageable(target);
    if (!mob && !byParts) return;
    const [lo, hi] = this.combat.punch_damage;
    const isPunch = customDmg === undefined; // крит и броня рук работают только для ударов
    const crit = isPunch && Math.random() < (this.combat.crit_chance ?? 0);
    let dmg = isPunch ? Math.round((lo + Math.floor(Math.random() * (hi - lo + 1))) * Armor.get().punchMult) : customDmg;
    if (crit) dmg = Math.round(dmg * (this.combat.crit_multiplier ?? 2));
    if (isPartDamageable(target) && target.damageScale) dmg = Math.max(1, Math.round(dmg * target.damageScale(part))); // босс-птица: в полёте перья гасят удар
    this.numbers.spawn(x, y - 6, dmg, crit, dirX);
    this.shake = Math.max(this.shake, crit ? CRIT_SHAKE : HIT_SHAKE);
    if (isPartDamageable(target)) {
      // существо из частей (червь, босс): урон идёт в ту часть, в которую попали; выбитая часть исчезает, гибель головы — гибель всего
      if (part !== undefined && target.damagePart(part, dmg) === 'dead') this.removeWhole(target);
      return;
    }
    mob!.hp -= dmg;
    if (mob!.hp <= 0) this.kill(target, mob!);
  }

  /** Погибло существо из частей: вычёркиваем из списков игры и убираем с экрана (эффекты смерти — позже). */
  private removeWhole(target: Hittable): void {
    if (this.gone.has(target)) return; // уже убран (например, добит цепной молнией): повторное уничтожение роняло игровой цикл
    this.gone.add(target);

    const leash = this.leashOf.get(target);
    if (leash) WorldProgression.get().onEnemyKilled(leash.id);

    const drop = <T>(list: T[], item: unknown) => {
      const i = list.indexOf(item as T);
      if (i >= 0) list.splice(i, 1);
    };
    const view = (target as unknown as { container: Container }).container;
    const isBoss = target instanceof WormBoss || target instanceof BirdBoss || target instanceof CrabBoss;
    this.loot.spawnFromEnemy(view.x, view.y, isBoss ? 'boss' : 'worm');
    SoundManager.get().playKill();
    this.contactDmg.delete(target);
    drop(this.worms, target);
    drop(this.bosses, target);
    drop(this.birdBosses, target);
    drop(this.crabBosses, target);
    if (target instanceof CrabBoss) {
      // гибель краба: взрыв неоновых искр, сильная тряска и вспышка; шары разбиваются
      this.fx.burst(view.x, view.y - 60, { count: 110, colors: CRAB_FEATHERS, speed: [60, 320], spread: Math.PI * 2, life: [0.4, 1.2], size: [1, 3], gravity: 140, drag: 2 });
      this.shake = Math.max(this.shake, 6);
      this.flashAlpha = 0.4;
      for (const orb of this.orbs) orb.burst();
    }
    if (target instanceof BirdBoss) {
      // гибель босса-птицы: взрыв перьев, тряска; его птички рассыпаются
      this.fx.burst(view.x, view.y, { count: 70, colors: BOSS_FEATHERS, speed: [60, 280], spread: Math.PI * 2, life: [0.3, 0.9], size: [1, 3], gravity: 120, drag: 2 });
      this.shake = Math.max(this.shake, 4.5);
      this.flashAlpha = 0.25;
      for (const bird of this.birds) bird.burst(6);
    }
    view.destroy({ children: true });
  }

  /** Смерть врага: он выходит из игры и исчезает (эффекты смерти — позже). */
  private kill(target: Hittable, mob: Mob): void {
    if (this.gone.has(target)) return;
    this.gone.add(target);
    if (target instanceof CrabOrb) {
      target.burst(); // шар краба разбит кулаком, добычи нет
      this.mobs.delete(target);
      mob.remove();
      mob.view.destroy({ children: true });
      return;
    }
    if (target instanceof BossBird) {
      target.burst(7); // птичка босса рассыпается пёрышками, добычи с неё нет
      this.mobs.delete(target);
      mob.remove();
      mob.view.destroy({ children: true });
      return;
    }

    const leash = this.leashOf.get(target);
    if (leash) WorldProgression.get().onEnemyKilled(leash.id);
    let enemyType = 'enemy';
    if (target instanceof Spider) enemyType = 'spider';
    else if (target instanceof SpiderMother) enemyType = 'mother';
    else if (target instanceof Worm) enemyType = 'worm';
    else if (target instanceof WormBoss) enemyType = 'boss';
    else if (target instanceof Critter) enemyType = 'critter';
    this.loot.spawnFromEnemy(mob.view.x, mob.view.y, enemyType);
    SoundManager.get().playKill();

    this.contactDmg.delete(target);
    this.mobs.delete(target);
    mob.remove();
    mob.view.destroy({ children: true });
  }

  // ---------- Здоровье героя

  /**
   * Урон герою. Возвращает true, если урон засчитан; false — не засчитан (неуязвимость после попадания и у терминала, или сработал шанс брони).
   * Шанс брони показывается серыми искрами. Здоровье закончилось — герой падает и возрождается у начала уровня, потеряв часть металлолома.
   */
  private hurtPlayer(amount: number, fromDirX: number): boolean {
    const armor = Armor.get();
    const b = this.player.body;
    const r = armor.hurt(amount);
    if (r === 'ignored') return false;
    if (r === 'blocked') {
      this.fx.burst(b.x, b.y - 28, { count: 8, colors: [0xd5ebff, 0x97b2c9], speed: [40, 110], spread: Math.PI * 2, life: [0.12, 0.3], size: [1, 2] });
      return false;
    }
    this.numbers.spawn(b.x, b.y - 48, amount, false, fromDirX);
    this.shake = Math.max(this.shake, CRIT_SHAKE);
    this.hud.flashHurt();
    this.fx.burst(b.x, b.y - 28, { count: 10, colors: [0xff0b08, 0xfc896b, 0xffe1d2], speed: [50, 140], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
    if (r === 'dead') {
      this.deathTimer = 1.5;
      this.player.knockdown(fromDirX, 1.3, true);
    }
    return true;
  }

  /** Возрождение после гибели: у начала уровня, с полным здоровьем; часть металлолома потеряна. */
  private respawnPlayer(): void {
    const armor = Armor.get();
    armor.loseScrapOnDeath();
    armor.revive();
    WorldProgression.get().resetEngagement();
    const sp = activeLevelDef.player_spawn;
    this.player.spawnAt(sp.x, sp.y, this.level.tileSize);
    this.fx.burst(this.player.body.x, this.player.body.y - 28, { count: 22, colors: LIGHTNING_SPARKS, speed: [60, 190], spread: Math.PI * 2, life: [0.25, 0.5], size: [1, 3] });
  }

  /** Касание мобов: каждый наносит контактный урон (из данных врага), не чаще раза в CONTACT_COOLDOWN секунд. */
  private checkContactDamage(dt: number): void {
    const b = this.player.body;
    for (const [target, cd] of this.contactCd) {
      if (cd - dt <= 0) this.contactCd.delete(target); else this.contactCd.set(target, cd - dt);
    }
    for (const [target, dmg] of this.contactDmg) {
      if (dmg <= 0 || this.contactCd.has(target)) continue;
      const home = this.leashOf.get(target);
      if (home && !home.hero()) continue; // моб бьёт, только пока герой в его комнате
      for (const c of target.hitCircles()) {
        const nx = Math.max(b.left, Math.min(c.x, b.right));
        const ny = Math.max(b.top, Math.min(c.y, b.bottom));
        if (Math.hypot(c.x - nx, c.y - ny) > c.r * 0.8) continue;
        this.contactCd.set(target, CONTACT_COOLDOWN);
        this.hurtPlayer(dmg, b.x >= c.x ? 1 : -1);
        break;
      }
    }
  }

  /**
   * Вспышка молнии (каждый третий удар с бронёй на руках): яркая вспышка в точке удара, усиленный урон цели и цепные разряды на ближайших врагов.
   */
  private lightningFlash(x: number, y: number, primary: Hittable, part: number | undefined, dirX: number): void {
    const armor = Armor.get();
    const [lo, hi] = this.combat.punch_damage;
    const dmg = Math.max(1, Math.round(((lo + hi) / 2) * armor.punchMult * armor.flashMult));
    this.boltFx.flash(x, y, 30, 0.22);
    this.flashColor = pal('gold', 7);
    this.flashAlpha = 0.28;
    this.shake = Math.max(this.shake, CRIT_SHAKE + 0.8);
    this.damage(primary, x, y, dirX, part, dmg);
    const near: { t: Hittable; cx: number; cy: number; part?: number; d: number }[] = [];
    for (const t of this.hittables()) {
      if (t === primary) continue;
      let best: { x: number; y: number; part?: number; d: number } | null = null;
      for (const c of t.hitCircles()) {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d <= armor.flashRadius + c.r && (!best || d < best.d)) best = { x: c.x, y: c.y, part: c.part, d };
      }
      if (best) near.push({ t, cx: best.x, cy: best.y, part: best.part, d: best.d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const n of near.slice(0, armor.flashTargets)) {
      this.boltFx.bolt({ x, y }, { x: n.cx, y: n.cy }, 0.22);
      this.boltFx.flash(n.cx, n.cy, 16, 0.16);
      n.t.onHit(Math.sign(n.cx - x) || 1, 0, n.part);
      this.damage(n.t, n.cx, n.cy, Math.sign(n.cx - x) || 1, n.part, Math.max(1, Math.round(dmg * 0.7)));
    }
  }

  /** Приземление с высоты: пыль разлетается по земле из-под ног, сильнее — гуще и дальше, при сильном — лёгкая тряска. */
  private landingDust(x: number, y: number, power: number): void {
    for (const side of [-1, 1]) {
      this.fx.burst(x + side * 3, y - 1, {
        count: 3 + Math.round(5 * power), colors: LAND_DUST, speed: [25, 60 + 60 * power], angle: side > 0 ? -0.2 : Math.PI + 0.2, spread: 0.3,
        life: [0.2, 0.4], size: [1, 2], gravity: 120, drag: 4
      });
    }
    if (power > 0.5) this.shake = Math.max(this.shake, 1.2 * power);
  }

  /** Тяжёлое приземление героя: пыль разлетается по земле в обе стороны, камеру трясёт по силе удара. */
  private hardLanding(x: number, y: number, power: number): void {
    for (const side of [-1, 1]) {
      this.fx.burst(x + side * 4, y - 1, {
        count: 8 + Math.round(6 * power), colors: LAND_DUST, speed: [40, 130], angle: side > 0 ? -0.25 : Math.PI + 0.25, spread: 0.35,
        life: [0.25, 0.55], size: [1, 2], gravity: 120, drag: 3
      });
      this.spriteFx.spawn(SMOKE_FX, x + side * 8, y - 4, {
        angle: Math.random() * Math.PI * 2, scale: 0.5 + 0.3 * power, vx: side * (50 + 30 * power), vy: -12, speed: 1
      });
    }
    this.shake = Math.max(this.shake, 1.5 + 2.5 * power);
  }

  /** Точка касания кулака с ближайшим кругом цели (null — не достал). */
  private strikeContact(strike: Strike, ax: number, ay: number, target: Hittable): { x: number; y: number; part?: number } | null {
    const bx = strike.x2;
    const by = strike.y2;
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby || 1;
    let best: { x: number; y: number; part?: number } | null = null;
    let bestGap = 0;
    for (const c of target.hitCircles()) {
      const t = Math.max(0, Math.min(1, ((c.x - ax) * abx + (c.y - ay) * aby) / len2));
      const px = ax + abx * t;
      const py = ay + aby * t;
      const gap = Math.hypot(c.x - px, c.y - py) - c.r - FIST_RADIUS;
      if (gap > 0 || (best && gap >= bestGap)) continue;
      best = { x: px, y: py, part: c.part };
      bestGap = gap;
    }
    return best;
  }

  /**
   * Отскок от стены: 3–4 клуба дыма разного размера веером разлетаются от стены в разные стороны. Крупный — по центру веера и медленный,
   * мелкие улетают дальше и быстрее по краям.
   */
  private wallKickSmoke(x: number, y: number, wallDir: -1 | 1, along = false): void {
    const count = 3 + Math.floor(Math.random() * 2);
    const away = wallDir > 0 ? Math.PI : 0; // направление от стены
    // вдоль стены (герой лезет вверх по ней) — дым уходит вниз и чуть от стены; от стены — веером от неё
    const base = along ? Math.PI / 2 + (wallDir > 0 ? 0.35 : -0.35) : away;
    const fan = along ? 1.4 : 2.3; // рад: ширина веера
    const middle = Math.floor((count - 1) / 2);
    for (let i = 0; i < count; i++) {
      const big = i === middle;
      const a = base + fan * (i / (count - 1) - 0.5) + (Math.random() - 0.5) * 0.3;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const speed = big ? 55 + Math.random() * 20 : 140 + Math.random() * 70;
      const scale = big ? 0.9 + Math.random() * 0.25 : 0.35 + Math.random() * 0.4;
      this.spriteFx.spawn(SMOKE_FX, x + dx * 3, y + dy * 3, {
        angle: Math.random() * Math.PI * 2,
        scale,
        vx: dx * speed,
        vy: dy * speed - 10, // дым чуть поднимается
        speed: 0.85 + Math.random() * 0.4
      });
    }
  }

  /** Эффект удара в точке попадания: картинка punch повёрнута по направлению удара + искры. */
  private landPunch(x: number, y: number, strike: Strike): void {
    const angle = Math.atan2(strike.dirY, strike.dirX);
    const hx = x + strike.dirX * FIST_RADIUS;
    const hy = y + strike.dirY * FIST_RADIUS;
    this.spriteFx.spawn(PUNCH_FX, hx, hy, { angle });
    this.fx.burst(hx, hy, {
      count: 8, colors: PUNCH_SPARKS, speed: [60, 150], angle, spread: 0.8, life: [0.12, 0.3], size: [1, 2], drag: 5, grow: 0.4
    });
  }

  /** Золотые шары краба: катятся, сталкиваются навстречу друг другу и ломаются, бьют героя; сломанные убираются. */
  private updateOrbs(dt: number): void {
    for (const orb of this.orbs) orb.update(dt);
    for (let i = 0; i < this.orbs.length; i++) {
      for (let j = i + 1; j < this.orbs.length; j++) {
        if (CrabOrb.collide(this.orbs[i], this.orbs[j])) this.shake = Math.max(this.shake, 1.6);
      }
    }
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      if (!orb.expired) continue;
      this.gone.add(orb);
      this.mobs.delete(orb);
      orb.container.destroy({ children: true });
      this.orbs.splice(i, 1);
    }
  }

  /** Эффекты броска воробья: пыль и искры на приседании, взрыв пыли и рывок камеры на отрыве, след в полёте, ударная пыль и тряска на приземлении. */
  private lungeFx(kind: 'wind' | 'leap' | 'trail' | 'land', x: number, y: number, k: number, dirX: number): void {
    const SPARK = [pal('cobalt', 6), pal('cobalt', 7), pal('electric', 7), pal('gold', 6)];
    switch (kind) {
      case 'wind':
        if (Math.random() < 0.5) {
          // сходящиеся к телу искры (энергия копится) и пыль из-под лап
          const a = Math.random() * Math.PI * 2;
          const r = 22 + 10 * (1 - k);
          const life = 0.16 + Math.random() * 0.1;
          this.fx.emit(x + Math.cos(a) * r, y - 14 + Math.sin(a) * r * 0.7, (-Math.cos(a) * r) / life, (-Math.sin(a) * r * 0.7) / life, SPARK[Math.floor(Math.random() * SPARK.length)], life, 1 + k * 1.5, { grow: 0.4 });
        }
        if (Math.random() < 0.25 + 0.4 * k) this.fx.emit(x + (Math.random() - 0.5) * 14, y - 1, (Math.random() - 0.5) * 50, -8 - Math.random() * 18, LAND_DUST[Math.floor(Math.random() * LAND_DUST.length)], 0.3 + Math.random() * 0.2, 1 + Math.random(), { drag: 3 });
        break;
      case 'leap':
        this.fx.burst(x, y - 1, { count: 18, colors: LAND_DUST, speed: [50, 150], angle: -dirX * 0.3 + (dirX > 0 ? Math.PI : 0), spread: 1.1, life: [0.25, 0.55], size: [1, 3], gravity: -30, drag: 2.5 });
        this.fx.burst(x, y - 12, { count: 12, colors: SPARK, speed: [90, 220], angle: dirX > 0 ? Math.PI : 0, spread: 0.5, life: [0.12, 0.3], size: [1, 2], drag: 3 });
        this.shake = Math.max(this.shake, 1.8);
        break;
      case 'trail':
        this.fx.emit(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 8, -dirX * 20, 0, SPARK[Math.floor(Math.random() * SPARK.length)], 0.2 + Math.random() * 0.15, 1 + Math.random() * 1.5, { grow: 0.3 });
        break;
      case 'land': {
        this.fx.burst(x, y - 1, { count: 22, colors: LAND_DUST, speed: [60, 170], angle: 0, spread: 0.18, life: [0.25, 0.6], size: [1, 3], gravity: -20, drag: 2.5 }); // пыль вправо…
        this.fx.burst(x, y - 1, { count: 22, colors: LAND_DUST, speed: [60, 170], angle: Math.PI, spread: 0.18, life: [0.25, 0.6], size: [1, 3], gravity: -20, drag: 2.5 }); // …и влево
        this.fx.burst(x, y - 6, { count: 10, colors: SPARK, speed: [50, 150], angle: -Math.PI / 2, spread: 0.9, life: [0.15, 0.35], size: [1, 2], gravity: 200 });
        this.shake = Math.max(this.shake, 2.8);
        break;
      }
    }
  }

  /** Тело героя в мире (прямоугольник) — по нему мобы засчитывают броски, укусы и молнии. */
  private heroBox(): { left: number; right: number; top: number; bottom: number } {
    const b = this.player.body;
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  }

  /** Атака моба по герою: урон (если засчитан — не неуязвимость и не шанс брони) и, если нужно, сбивание с ног. */
  private strikeHero(_x: number, _y: number, dirX: number, damage: number, knock: boolean): boolean {
    if (!this.hurtPlayer(damage, dirX)) return false;
    if (knock && Armor.get().hp > 0) this.player.knockdown(dirX);
    return true;
  }

  /** Связь босса-червя с игрой: герой, урон ему, паучки из тела, тряска. */
  private wormBossHooks(def: EnemyDef): WormBossHooks {
    return {
      hero: () => this.heroBox(),
      hurt: (amount, dirX, knock) => this.strikeHero(0, 0, dirX, amount, knock),
      spawnSpider: (x, y, vx, vy) => this.spawnBossSpider(def, x, y, vx, vy),
      shake: (power) => {
        this.shake = Math.max(this.shake, power);
      },
      fx: this.fx
    };
  }

  /** Паучок из тела босса-червя: вылетает из точки, падает на поверхность и бежит на героя; живых не больше max_alive. */
  private spawnBossSpider(boss: EnemyDef, x: number, y: number, vx: number, vy: number): boolean {
    for (const sp of this.bossSpiders) if (sp.expired || this.gone.has(sp)) this.bossSpiders.delete(sp);
    if (this.bossSpiders.size >= (boss.summons?.max_alive ?? BOSS_SPIDER_MAX)) return false;
    const id = boss.summons?.enemy_ids[0] ?? 'spider';
    const def = this.enemyDefs.get(id);
    const rig = def?.rig_id ? RIGS.find((r) => r.id === def.rig_id) : undefined;
    if (!def || !rig) return false;
    const spawn = { enemy_id: def.id, sprite_id: def.sprite_variants[0], x: 0, y: 0 };
    const spider = new Spider(def, spawn, this.level, rig, this.sprites, { scale: BOSS_SPIDER_SCALE, lifetime: BOSS_SPIDER_LIFE, fx: this.fx });
    spider.launch(x, y, vx, vy);
    this.spiders.push(spider);
    this.trackSpider(spider, Math.max(1, Math.round(def.stats.max_health * BOSS_SPIDER_SCALE)), Math.max(1, Math.round(def.stats.contact_damage * BOSS_SPIDER_CONTACT)), BOSS_SPIDER_SIGHT);
    this.worldLayer.addChildAt(spider.container, this.worldLayer.getChildIndex(this.fx.container));
    this.bossSpiders.add(spider);
    return true;
  }

  /** Связь босса-краба с игрой: герой, урон ему, шары, метание мобов, тряска. */
  private crabBossHooks(rig: RigDef): CrabBossHooks {
    const orbDef = rig.crab_boss!.orb;
    const hero = () => {
      const b = this.player.body;
      return { x: b.x, left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    return {
      hero,
      hurt: (amount, dirX, knock) => {
        if (this.hurtPlayer(amount, dirX) && knock && Armor.get().hp > 0) this.player.knockdown(dirX);
      },
      spawnOrb: (x, y) => {
        const orb = new CrabOrb(this.sprites, orbDef.sprite_id, orbDef.radius, this.level, x, y, hero, (dirX) => {
          if (this.hurtPlayer(CRAB_ORB_DAMAGE, dirX) && Armor.get().hp > 0) this.player.knockdown(dirX);
        }, this.fx);
        this.orbs.push(orb);
        this.worldLayer.addChildAt(orb.container, this.worldLayer.getChildIndex(this.fx.container));
        this.track(orb, ORB_HP, orb.container, () => this.orbs.splice(this.orbs.indexOf(orb), 1));
        return orb;
      },
      throwMob: (enemyId, x, y, vx, vy) => this.throwMob(enemyId, x, y, vx, vy),
      mobsAlive: () => {
        for (const c of this.bossSummons) if (this.gone.has(c)) this.bossSummons.delete(c);
        for (const sp of this.thrownSpiders) if (sp.expired || this.gone.has(sp)) this.thrownSpiders.delete(sp);
        return this.bossSummons.size + this.thrownSpiders.size;
      },
      flash: (alpha) => {
        this.flashColor = pal('virus', 6);
        this.flashAlpha = Math.max(this.flashAlpha, alpha);
      },
      shake: (power) => {
        this.shake = Math.max(this.shake, power);
      },
      fx: this.fx
    };
  }

  /** Краб швыряет моба: крыса и воробей летят по дуге (Critter.toss), паук — как выплюнутый маткой (Spider.launch). */
  private throwMob(enemyId: string, x: number, y: number, vx: number, vy: number): void {
    const def = this.enemyDefs.get(enemyId);
    if (!def) return;
    const spriteId = def.sprite_variants[0];
    if (def.behavior_type === 'crawler') {
      const rig = def.rig_id ? RIGS.find((r) => r.id === def.rig_id) : undefined;
      if (!rig) return;
      const spawn = { enemy_id: def.id, sprite_id: spriteId, x: 0, y: 0 };
      const spider = new Spider(def, spawn, this.level, rig, this.sprites, { scale: 1, lifetime: 30, fx: this.fx });
      spider.launch(x, y, vx, vy);
      this.spiders.push(spider);
      this.trackSpider(spider, def.stats.max_health, def.stats.contact_damage, THROWN_SPIDER_SIGHT);
      this.worldLayer.addChildAt(spider.container, this.worldLayer.getChildIndex(this.fx.container));
      this.thrownSpiders.add(spider);
      return;
    }
    const mob = this.createCritter(def, { enemy_id: enemyId, sprite_id: spriteId, x: Math.floor(x / this.level.tileSize), y: Math.floor(y / this.level.tileSize) }, true);
    mob.toss(x, y, vx, vy);
    this.bossSummons.add(mob);
    this.fx.burst(x, y, { count: 8, colors: ZAP_COLORS, speed: [40, 120], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
  }

  /** Мелкий моб второй локации (крыса, воробей, птичка, страж): тело, хлыст, комната, здоровье. runtime — появился в ходе боя (рисуется под героем). */
  private createCritter(def: EnemyDef, spawn: EnemySpawnDef, runtime: boolean): Critter {
    const rig = RIGS.find((r) => r.id === def.rig_id);
    if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
    const hero = () => {
      const b = this.player.body;
      return { x: b.x, y: b.y };
    };
    const mob = new Critter(def, spawn, this.level, rig, this.sprites, hero);
    // хлыст-молния электрокрысы: сбивает героя с ног (регдолл), на щелчке — искры
    mob.onWhipHit = (x, y, dirX) => {
      // хлыст отнимает здоровье и сбивает с ног; если урон не засчитан (шанс брони, неуязвимость) — героя не трогает
      if (!this.hurtPlayer(WHIP_DAMAGE, dirX)) return false;
      if (Armor.get().hp > 0) this.player.knockdown(dirX);
      this.fx.burst(x, y, { count: 14, colors: ZAP_COLORS, speed: [60, 180], spread: Math.PI * 2, life: [0.15, 0.4], size: [1, 2] });
      return true;
    };
    mob.onCrack = (x, y) => this.fx.burst(x, y, { count: 8, colors: ZAP_COLORS, speed: [40, 130], spread: Math.PI * 2, life: [0.12, 0.3], size: [1, 2] });
    // бросок воробья: прыгает в героя, на касании — урон
    mob.heroBox = () => this.heroBox();
    mob.onLungeHit = (x, y, dirX, dmg) => {
      if (!this.strikeHero(x, y, dirX, dmg, false)) return false;
      this.fx.burst(x, y, { count: 6, colors: [0xff0b08, 0xfc896b, 0xffe1d2], speed: [30, 90], spread: Math.PI * 2, life: [0.12, 0.3], size: [1, 2] });
      return true;
    };
    mob.onLungeFx = (kind, x, y, k, dirX) => this.lungeFx(kind, x, y, k, dirX);
    // страж: сходящиеся к глазу искры при зарядке и синяя молния на выстреле
    mob.onCharge = (x, y, k) => {
      if (Math.random() > 0.7) return;
      const a = Math.random() * Math.PI * 2;
      const r = 16 + 14 * (1 - k);
      const life = 0.14 + Math.random() * 0.1;
      this.fx.emit(x + Math.cos(a) * r, y + Math.sin(a) * r, (-Math.cos(a) * r) / life, (-Math.sin(a) * r) / life, BLUE.sparks[Math.floor(Math.random() * BLUE.sparks.length)], life, 1 + k * 1.5, { grow: 0.4 });
    };
    mob.onShoot = (x, y, angle, cfg) => {
      this.enemyBolts.fire(x, y, angle, { speed: cfg.speed, bounces: cfg.bounces, life: cfg.life, damage: cfg.damage });
      this.fx.burst(x, y, { count: 8, colors: ZAP_COLORS, angle, spread: 0.6, speed: [50, 140], life: [0.1, 0.25], size: [1, 2] });
    };
    mob.leash = this.bindRoom(mob, spawn);
    this.critters.push(mob);
    if (runtime) this.worldLayer.addChildAt(mob.container, this.worldLayer.getChildIndex(this.player.sprite));
    else this.worldLayer.addChild(mob.container);
    this.track(mob, def.stats.max_health, mob.container, () => this.critters.splice(this.critters.indexOf(mob), 1));
    if (!mob.passive) this.contactDmg.set(mob, def.stats.contact_damage);
    return mob;
  }

  /** Связь босса-птицы с игрой: герой, урон ему, птички, призыв на посадке, тряска. */
  private birdBossHooks(def: EnemyDef, rig: RigDef): BirdBossHooks {
    const birdSprite = rig.bird_boss!.bird_sprite_id;
    return {
      hero: () => {
        const b = this.player.body;
        return { x: b.x, left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      },
      hurt: (amount, dirX, knock) => {
        if (this.hurtPlayer(amount, dirX) && knock && Armor.get().hp > 0) this.player.knockdown(dirX);
      },
      spawnBird: (x, y, angle, enraged) => this.spawnBossBird(birdSprite, x, y, angle, enraged),
      birdsAlive: () => this.birds.length,
      summon: (x, floorY) => this.summonBeside(def, x, floorY),
      shake: (power) => {
        this.shake = Math.max(this.shake, power);
      },
      fx: this.fx
    };
  }

  /** Птичка босса: вылетает из клюва, гонится за героем; бьётся с одного удара, добычи не даёт. */
  private spawnBossBird(spriteId: string, x: number, y: number, angle: number, enraged: boolean): void {
    const hero = () => {
      const b = this.player.body;
      return { x: b.x, y: b.y - 30 };
    };
    const bird = new BossBird(
      this.sprites, spriteId, this.level, x, y, angle,
      {
        speed: enraged ? 185 : 160, turn: enraged ? 3.2 : 2.5, life: 6.5, damage: BIRD_DAMAGE,
        onPeck: (px, py, dirX, dmg) => {
          if (!this.hurtPlayer(dmg, dirX)) return false; // герой неуязвим или броня отвела — птичка летит дальше
          this.fx.burst(px, py, { count: 6, colors: [0xff0b08, 0xfc896b, 0xffe1d2], speed: [30, 90], spread: Math.PI * 2, life: [0.12, 0.3], size: [1, 2] });
          return true;
        }
      },
      hero, () => this.player.body, this.fx
    );
    this.birds.push(bird);
    this.worldLayer.addChildAt(bird.container, this.worldLayer.getChildIndex(this.fx.container));
    this.track(bird, BIRD_HP, bird.container, () => this.birds.splice(this.birds.indexOf(bird), 1));
  }

  /** Босс-птица села на пол: по бокам от неё с неба падают обитатели локации (по data/enemies.json: summons). */
  private summonBeside(boss: EnemyDef, x: number, floorY: number): void {
    const cfg = boss.summons;
    if (!cfg) return;
    for (const c of this.bossSummons) if (this.gone.has(c)) this.bossSummons.delete(c);
    const ts = this.level.tileSize;
    const row = Math.round(floorY / ts); // первая твёрдая клетка под птицей
    const cx0 = Math.floor(x / ts);
    const room = (cfg.max_alive ?? cfg.count) - this.bossSummons.size;
    const used = new Set<number>();
    for (let i = 0; i < Math.min(cfg.count, room); i++) {
      const id = cfg.enemy_ids[Math.floor(Math.random() * cfg.enemy_ids.length)];
      const def = this.enemyDefs.get(id);
      if (!def) continue;
      // ближайшая клетка пола сбоку с воздухом над ней; падает с высоты до четырёх клеток
      let spot: { cx: number; top: number } | null = null;
      const first = i % 2 === 0 ? -1 : 1; // первый слева, второй справа; упёрлись в стену — на другую сторону
      search: for (const side of [first, -first]) {
        for (const off of [4, 5, 3, 6, 7]) {
          const cx = cx0 + side * off;
          if (used.has(cx) || !this.level.isSolid(cx, row) || this.level.isSolid(cx, row - 1)) continue;
          let top = 1;
          while (top < 4 && !this.level.isSolid(cx, row - top - 1)) top++;
          spot = { cx, top };
          used.add(cx);
          break search;
        }
      }
      if (!spot) continue;
      const mob = this.createCritter(def, { enemy_id: id, sprite_id: def.sprite_variants[0], x: spot.cx, y: row - spot.top }, true);
      this.bossSummons.add(mob);
      this.fx.burst((spot.cx + 0.5) * ts, (row - spot.top + 0.5) * ts, { count: 12, colors: ZAP_COLORS, speed: [40, 130], spread: Math.PI * 2, life: [0.15, 0.4], size: [1, 2] });
    }
  }

  /** Паучок, выплюнутый маткой: летит из точки (x, y), садится на поверхность и дальше ползает как обычный паук. */
  private spawnBaby(defs: Map<string, EnemyDef>, mother: EnemyDef, x: number, y: number, vx: number, vy: number, room: Leash | null): Spider | null {
    const cfg = mother.spawns;
    const babyDef = cfg && defs.get(cfg.enemy_id);
    const rig = babyDef?.rig_id ? RIGS.find((r) => r.id === babyDef.rig_id) : undefined;
    if (!cfg || !babyDef || !rig) return null;
    const spawn = { enemy_id: babyDef.id, sprite_id: cfg.sprite_id ?? babyDef.sprite_variants[0], x: 0, y: 0 };
    const baby = new Spider(babyDef, spawn, this.level, rig, this.sprites, { scale: cfg.scale, lifetime: cfg.lifetime_seconds, fx: this.fx });
    baby.launch(x, y, vx, vy);
    if (room) {
      baby.leash = room; // паучки матки ползают в её комнате
      this.leashOf.set(baby, room);
    }
    this.spiders.push(baby); // слой выбирает матка: сначала ниже себя, потом передний
    this.trackSpider(baby, Math.max(1, Math.round(babyDef.stats.max_health * (cfg.scale ?? 1))), babyDef.stats.contact_damage, BABY_SIGHT);
    return baby;
  }

  /** Id всех спрайтов врага: вариант внешности, части рига (слои, ноги, сегменты, лапки) и спрайты порождаемых им врагов. */
  private enemySpriteIds(defs: Map<string, EnemyDef>, enemyId: string, spriteId?: string, depth = 0): string[] {
    const def = defs.get(enemyId);
    if (!def || depth > 3) return [];
    const rig = def.rig_id ? RIGS.find((r) => r.id === def.rig_id) : undefined;
    const ids: string[] = [...(spriteId ? [spriteId] : []), ...def.sprite_variants];
    if (rig) {
      ids.push(
        ...rig.parts.flatMap((p) => [p.sprite_id, ...(p.face?.sprite_id ? [p.face.sprite_id] : [])]),
        ...(rig.critter?.parts.map((p) => p.sprite_id) ?? []),
        ...(rig.crawler?.legs.flatMap((l) => [l.upper_sprite_id, l.lower_sprite_id]) ?? []),
        ...(rig.segmented
          ? [rig.segmented.head, rig.segmented.body, rig.segmented.tail].flatMap((s) => [s.sprite_id, ...[...(s.under ?? []), ...(s.over ?? [])].map((a) => a.sprite_id)])
          : []),
        ...(rig.wobbler ? [rig.wobbler.sprite_id, ...(rig.wobbler.thread ? [rig.wobbler.thread.sprite_id] : []), ...rig.wobbler.limbs.map((l) => l.sprite_id)] : [])
      );
    }
    if (rig?.crab_boss) ids.push(...rig.crab_boss.layers.map((l) => l.sprite_id), rig.crab_boss.claw.sprite_id, rig.crab_boss.orb.sprite_id);
    if (rig?.bird_boss) ids.push(rig.bird_boss.bird_sprite_id, ...rig.bird_boss.layers.map((l) => l.sprite_id));
    if (def.spawns) ids.push(...this.enemySpriteIds(defs, def.spawns.enemy_id, def.spawns.sprite_id, depth + 1));
    for (const id of def.summons?.enemy_ids ?? []) ids.push(...this.enemySpriteIds(defs, id, undefined, depth + 1)); // призванные боссом
    return ids;
  }

  /**
   * Главный цикл обновления физики и логики
   */
  private update(dt: number): void {
    dt = Math.min(dt, 1 / 30); // защита от «туннелирования» после лагов/вкладки в фоне

    const armor = Armor.get();
    getSharedOutlineFilter().update(dt, this.scale);
    const terminalOpen = this.terminalUI.isOpen;
    const frozen = terminalOpen || this.deathTimer > 0; // у терминала и после гибели герой стоит
    armor.invulnerable = terminalOpen || this.deathTimer > 0;
    armor.update(dt);

    // 1. Игрок и ввод
    const input = this.input.poll();
    const aim = this.aimInWorld();
    let anyHovered = false;
    let mouseInteracted = false;
    const pb = this.player.body;

    // Терминал брони: подсветка при наведении, клик мыши открывает окно
    let hoveredTerm: Terminal | null = null;
    for (const t of this.terminals) {
      const hovered = !frozen && aim !== null && t.containsPoint(aim.x, aim.y);
      if (hovered) {
        hoveredTerm = t;
        anyHovered = true;
      }
      t.update(dt, hovered);
    }

    if (input.mouseLeftPressed && hoveredTerm && !terminalOpen && this.deathTimer <= 0) {
      const dist = Math.hypot(pb.x - hoveredTerm.x, pb.y - hoveredTerm.y);
      if (dist <= 96) {
        this.terminalUI.open(hoveredTerm.style);
        mouseInteracted = true;
      } else {
        this.fx.burst(hoveredTerm.x, hoveredTerm.y - 30, { count: 8, colors: [0xff0b08, 0xfc896b, 0xffe1d2], speed: [30, 90], spread: Math.PI * 2, life: [0.15, 0.35], size: [1, 2] });
        mouseInteracted = true;
      }
    }

    // Объекты уровня: двери, предметы, подставки (подсветка при наведении, взаимодействие по клику мыши)
    const objRes = this.objects?.update(
      dt,
      { x: pb.x, y: pb.y },
      frozen,
      aim,
      input.mouseLeftPressed && !mouseInteracted && !terminalOpen && this.deathTimer <= 0
    );
    if (objRes?.hovered) anyHovered = true;
    if (objRes?.interacted) mouseInteracted = true;

    // Терминал ввода шифра — интерактивный спрайт: кнопки нажимаются кликом прямо на нём (PasswordTerminalEntity)
    if (!frozen && aim && this.passwordTerminal?.hitTest(aim.x, aim.y) && this.passwordTerminal.isNearbyHero({ x: pb.x, y: pb.y })) anyHovered = true;

    // Металлолом: подсветка и притягивание по клику мыши
    const lootRes = this.loot.updateMouse(aim, input.mouseLeftPressed && !mouseInteracted, pb.x, pb.y);
    if (lootRes.hovered) anyHovered = true;
    if (lootRes.interacted) mouseInteracted = true;

    // Обновление курсора мыши (обычный или курсор взаимодействия)
    this.setCursor(anyHovered);

    const live: InputState = frozen ? {
      ...input,
      horizontal: 0,
      vertical: 0,
      jumpPressed: false,
      jumpHeld: false,
      attackPressed: false,
      attackHeld: false,
      specialAttackPressed: false,
      specialAttackHeld: false,
      hubMenuPressed: false,
      mouseLeftPressed: false,
      mouseRightPressed: false
    } : {
      ...input,
      attackPressed: mouseInteracted ? false : input.attackPressed,
      attackHeld: mouseInteracted ? false : input.attackHeld
    };

    // Перехват клика по кнопкам терминала пароля (если герой рядом и кликнул по кнопке на спрайте)
    if (input.mouseLeftPressed && aim && this.passwordTerminal?.onClick(aim.x, aim.y)) {
      live.attackPressed = false;
      live.attackHeld = false;
    }

    // луч молнии: ПКМ зажата, броня на руках, есть энергия
    this.player.beamWanted = !frozen && armor.hasLightning && input.specialAttackHeld && armor.energy > 4;
    this.player.slowMult = this.bosses.reduce((m, boss) => Math.min(m, boss.heroSlow), 1); // неоновый дождь босса-червя: −15 % к скорости
    this.player.update(dt, live, this.level, aim);

    // 2. Спец-атака на правую кнопку мыши (ПКМ): без брони на руках — бросок шестерёнки (замах, в момент отпускания из кисти вылетает снаряд, тратит энергию)
    if (!armor.hasLightning && live.specialAttackPressed && aim && this.projectiles.ready && this.player.canThrow) {
      if (armor.canSpend(armor.gearCost)) this.player.startThrow(aim, true);
      else armor.spend(armor.gearCost); // не хватило энергии — шкала мигает
    }
    const bo = this.player.beamOrigin;
    if (bo) armor.energy = Math.max(0, armor.energy - armor.beamCost * dt);
    this.beam.update(dt, bo, this.level, this.hittables(), { dps: armor.beamDps, length: armor.beamLength, bounces: armor.beamBounces });

    // Настенный шифр: анимация цифр и проверка обнаружения роботом
    this.cipherCluesView.update(dt);
    const discoveredClue = this.cipherPuzzle.checkClueDiscovery(pb.x, pb.y);
    if (discoveredClue) {
      this.cipherCluesView.onClueDiscovered(discoveredClue);
      this.fx.burst(discoveredClue.x, discoveredClue.y, {
        count: 14,
        colors: [0x5bf5a3, 0xfbc53d, 0xffffff],
        speed: [40, 130],
        spread: Math.PI * 2,
        life: [0.2, 0.45],
        size: [1, 2]
      });
    }

    // Терминал ввода шифра: интерактивный спрайт (курсор — через setCursor выше)
    this.passwordTerminal?.update(dt, { x: pb.x, y: pb.y }, aim);

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.respawnPlayer();
    }
    // герой мигает, пока неуязвим после попадания
    this.player.sprite.alpha = armor.hurtTimer > 0 && Math.floor(armor.hurtTimer * 18) % 2 === 0 ? 0.45 : 1;

    // Комнаты: в какой стоит герой (от этого зависят мобы, арены и туман)
    if (this.rooms.any) {
      this.rooms.updateHero(Math.floor(pb.x / this.level.tileSize), Math.floor((pb.y - 16) / this.level.tileSize));
      const heroRoomIds = [...this.rooms.current].map((idx) => this.rooms.defs[idx]?.id).filter(Boolean) as string[];
      WorldProgression.get().updateHeroRooms(heroRoomIds);
      this.updateBackgrounds(dt);
    }

    // 3. Враги
    for (const enemy of this.enemies) enemy.update(dt);
    for (const spider of this.spiders) spider.update(dt);
    for (const worm of this.worms) worm.update(dt);
    for (const mother of this.mothers) mother.update(dt);
    for (const boss of this.bosses) boss.update(dt);
    for (const boss of this.birdBosses) boss.update(dt);
    for (const bird of this.birds) bird.update(dt);
    for (const boss of this.crabBosses) boss.update(dt);
    this.updateOrbs(dt);
    for (const mob of this.critters) mob.update(dt);
    this.resolveStrike();
    this.checkContactDamage(dt);
    this.projectiles.update(dt, this.level, this.hittables(), { x: this.player.body.x, y: this.player.body.y - 28 });
    this.enemyBolts.update(dt, this.level, this.heroBox(), (x, y, dirX, dmg) => this.strikeHero(x, y, dirX, dmg, false));
    this.loot.update(dt, this.level, this.player);
    this.debris.update(dt, this.level, armor.debrisLife);
    this.boltFx.update(dt);
    if (this.flashAlpha > 0) {
      this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.6);
      this.flashLayer.clear();
      if (this.flashAlpha > 0) this.flashLayer.rect(0, 0, this.app.renderer.width, this.app.renderer.height).fill({ color: this.flashColor, alpha: this.flashAlpha });
    }
    this.hud.update();
    {
      // полоса здоровья: босс-краб или птица, пока бой идёт
      const crab = this.crabBosses.find((b) => b.active);
      const bird = this.birdBosses.find((b) => b.active);
      const worm = this.bosses.find((b) => b.active);
      this.bossBar.update(dt, crab ? crab.health : bird ? bird.health : worm ? worm.health : null, this.viewW, crab ? 'virus' : bird ? 'cobalt' : 'void');
    }
    this.fx.update(dt);
    this.spriteFx.update(dt);
    this.numbers.update(dt);
    // Выплюнутые паучки живут ограниченное время
    for (let i = this.spiders.length - 1; i >= 0; i--) {
      if (!this.spiders[i].expired) continue;
      this.spiders[i].container.destroy({ children: true });
      this.spiders.splice(i, 1);
    }
    // Птички босса рассыпались сами (клюнули, врезались, вышел срок) — убираем
    for (let i = this.birds.length - 1; i >= 0; i--) {
      const bird = this.birds[i];
      if (!bird.expired) continue;
      this.gone.add(bird);
      this.mobs.delete(bird);
      bird.container.destroy({ children: true });
      this.birds.splice(i, 1);
    }

    // 4. Камера и анимация декора (отростки качаются только в обзоре)
    this.updateCamera(dt);
    const camLeft = -this.worldLayer.x;
    const b = this.player.body;
    this.level.update(dt, camLeft, camLeft + this.viewW, [{ left: b.left, right: b.right, top: b.top, bottom: b.bottom, vx: b.vx, vy: b.vy }]);
    // молнии светят: луч героя, вспышки и хвосты электрокрыс (рядом с героем) отдают источники света освещению
    if (this.lighting) {
      const extra = [...this.beam.lights, ...this.boltFx.lights];
      for (const c of this.critters) {
        const l = Math.abs(c.container.x - b.x) < 500 ? c.tailLight() : null;
        if (l) extra.push(l);
      }
      // Мягкий свет от сенсоров робота: подсвечивает окружение и коридоры вокруг героя
      extra.push({ x: b.x, y: b.y - 18, r: 80, i: 0.35, c: [0.35, 0.75, 1.0] });
      for (const boss of this.crabBosses) extra.push(...boss.lights());
      for (const boss of this.bosses) extra.push(...boss.lights());
      extra.push(...this.enemyBolts.lights);
      this.lighting.extraLights = extra;
    }
    this.lighting?.update();
    if (this.fog) {
      this.fog.container.position.copyFrom(this.worldLayer.position);
      this.fog.update(dt, -this.worldLayer.x, -this.worldLayer.y, this.viewW, this.viewH, { x: b.x, y: b.y - 20 });
    }
    if (this.minimap.container.visible) {
      this.minimap.update(dt, this.level, this.fog ? this.fog.explored : null, this.fog?.exploredChanged ?? false, { x: b.x, y: b.y - 20 });
      if (this.fog) this.fog.exploredChanged = false;
    }
    if (this.grade) {
      const span = Math.max(1, this.level.pixelWidth - this.viewW);
      this.grade.update(dt, Math.max(0, Math.min(1, camLeft / span)));
    }
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
  if (import.meta.env.DEV) {
    (window as unknown as { __game: GameApp; __armor: Armor }).__game = game; // отладка из консоли браузера
    (window as unknown as { __armor: Armor }).__armor = Armor.get();
  }
});
