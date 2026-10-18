import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { SpriteLibrary } from './assets/SpriteLibrary.ts';
import type { BackgroundDef, EnemyDef, LevelDef, RigDef, TileSetDef } from './data/types.ts';
import { Enemy } from './entities/Enemy.ts';
import { Spider } from './entities/Spider.ts';
import { SpiderMother } from './entities/SpiderMother.ts';
import { Particles } from './effects/Particles.ts';
import { Worm } from './entities/Worm.ts';
import { Player } from './entities/Player.ts';
import { Level } from './world/Level.ts';
import { ParallaxBackground } from './world/ParallaxBackground.ts';
import { GAME_CONFIG } from './core/Constants.ts';
import { InputManager } from './core/InputManager.ts';
import { AgingSystem } from './systems/AgingSystem.ts';
import { EventBus } from './core/EventBus.ts';

// Загрузка начальных параметров игрока из конфигурационного JSON
import playerData from '../data/player/player_initial_state.json';
import enemiesData from '../data/enemies/enemies.json';
import tilesData from '../data/tiles/tiles.json';
import levelData from '../data/levels/test_level.json';
import playerRigData from '../data/rigs/player_rig.json';

// Все риги из data/rigs (враги-«сборные», например паук, выбирают свой по rig_id)
const RIGS = Object.values(
  import.meta.glob('../data/rigs/*.json', { eager: true, import: 'default' }) as Record<string, RigDef>
);

// Все параллакс-фоны из data/backgrounds (уровень выбирает свой по background_id)
const BACKGROUNDS = Object.values(
  import.meta.glob('../data/backgrounds/*.json', { eager: true, import: 'default' }) as Record<string, BackgroundDef>
);

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
  private aging: AgingSystem;

  private gameContainer: HTMLElement;
  private hudText!: Text;
  private timerText!: Text;
  private sprites = new SpriteLibrary();
  private worldLayer!: Container;
  private level!: Level;
  private player!: Player;
  private enemies: Enemy[] = [];
  private spiders: Spider[] = [];
  private worms: Worm[] = [];
  private mothers: SpiderMother[] = [];
  private fx = new Particles(); // частицы: брызги, пыль, след

  // Размер видимой области в «виртуальных» пикселях: растёт вместе с окном, пиксели не растягиваются
  private viewW: number = GAME_CONFIG.VIRTUAL_WIDTH;
  private viewH: number = GAME_CONFIG.VIRTUAL_HEIGHT;
  private grid = new Graphics();
  private background: ParallaxBackground | null = null;
  private scale = 1;
  private cameraY = 0;
  private groundRefY = 0; // высота ног при последнем касании земли
  private cameraReady = false;
  private pointer: { x: number; y: number } | null = null; // курсор в пикселях окна

  constructor() {
    this.app = new Application();
    this.input = InputManager.get();
    this.aging = new AgingSystem(
      playerData.aging_system.time_limit_seconds,
      playerData.aging_system.warning_threshold_seconds,
      playerData.aging_system.critical_threshold_seconds
    );
    this.gameContainer = document.getElementById('game-container')!;
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
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('pointermove', (e) => (this.pointer = { x: e.clientX, y: e.clientY }));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        window.location.href = './editor.html';
      }
    });

    await this.setupScene();
    this.setupHUD();

    // Запуск основного игрового цикла (Pixi ticker)
    this.app.ticker.add((ticker) => {
      const dt = ticker.deltaTime / 60; // Перевод тиков в секунды
      this.update(dt);
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

    // Текст рисуем в родном разрешении, а не растягиваем
    for (const t of [this.timerText, this.hudText]) if (t) t.resolution = this.scale;

    this.drawGrid();
    this.background?.resize(this.viewW, this.viewH);
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
      const target = Math.max(0, Math.min(maxY, followFeet - this.viewH * CAMERA_REST_Y));
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
    this.worldLayer.position.set(-snap(camX), -snap(camY));
    this.background?.update(snap(camX), snap(camY), lh, this.scale);
  }

  /**
   * Сцена: фоновая сетка, тестовый уровень из data/levels, герой и враги
   */
  private async setupScene(): Promise<void> {
    this.app.stage.addChild(this.grid);
    this.drawGrid();

    const tileset = tilesData as TileSetDef;
    const levelDef = levelData as LevelDef;
    const enemyDefs = new Map((enemiesData as unknown as EnemyDef[]).map((e) => [e.id, e]));

    // Параллакс-фон уровня (если задан)
    const bgDef = levelDef.background_id ? BACKGROUNDS.find((b) => b.id === levelDef.background_id) : undefined;
    if (levelDef.background_id && !bgDef) throw new Error(`Уровень ссылается на неизвестный фон "${levelDef.background_id}"`);

    // Загружаем только те спрайты, которые реально нужны уровню
    const rigDef = playerRigData as RigDef;
    await this.sprites.load([
      ...(bgDef ? ParallaxBackground.spriteIds(bgDef) : []),
      playerData.sprite_id,
      ...rigDef.parts.map((p) => p.sprite_id),
      ...Level.spriteIds(levelDef, tileset),
      ...levelDef.enemies.map((e) => e.sprite_id),
      // части тела врагов, собранных из слоёв (паук, червь, паучиха), и тех, кого они порождают
      ...levelDef.enemies.flatMap((e) => this.enemySpriteIds(enemyDefs, e.enemy_id, e.sprite_id))
    ]);

    if (bgDef) {
      this.background = new ParallaxBackground(bgDef, this.sprites);
      this.grid.visible = false; // вместо технической сетки — фон
      this.app.stage.addChildAt(this.background.container, 0);
      this.background.resize(this.viewW, this.viewH);
    }

    this.worldLayer = new Container();
    this.app.stage.addChild(this.worldLayer);

    this.level = new Level(levelDef, tileset, this.sprites);
    this.worldLayer.addChild(this.level.container);

    for (const spawn of levelDef.enemies) {
      const def = enemyDefs.get(spawn.enemy_id);
      if (!def) throw new Error(`Уровень ссылается на неизвестного врага "${spawn.enemy_id}"`);
      if (def.behavior_type === 'crawler') {
        // Ползающий враг (паук): процедурное тело по поверхностям тайлов
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const spider = new Spider(def, spawn, this.level, rig, this.sprites);
        this.spiders.push(spider);
        this.worldLayer.addChild(spider.container);
        continue;
      }
      if (def.behavior_type === 'spawner') {
        // Паучиха-матка: сидит на фоне (под тайлами), шатает лапками и выплёвывает паучков
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const mother = new SpiderMother(def, spawn, this.level.tileSize, rig, this.sprites, this.fx,
          (x, y, vx, vy) => this.spawnBaby(enemyDefs, def, x, y, vx, vy), (baby) => this.worldLayer.addChildAt(baby.container, this.worldLayer.getChildIndex(this.fx.container)));
        this.mothers.push(mother);
        this.worldLayer.addChildAt(mother.container, this.worldLayer.getChildIndex(this.level.container));
        continue;
      }
      if (def.behavior_type === 'burrower') {
        // Червь-землерой: рисуется под тайлами, чтобы часть тела внутри блоков была скрыта
        const rig = RIGS.find((r) => r.id === def.rig_id);
        if (!rig) throw new Error(`Враг "${def.id}" ссылается на неизвестный риг "${def.rig_id}"`);
        const worm = new Worm(def, spawn, this.level, rig, this.sprites, this.worms);
        this.worms.push(worm);
        this.worldLayer.addChildAt(worm.container, this.worldLayer.getChildIndex(this.level.container));
        continue;
      }
      const enemy = new Enemy(def, spawn, this.level.tileSize, this.sprites);
      this.enemies.push(enemy);
      this.worldLayer.addChild(enemy.sprite);
    }

    this.player = new Player(playerData.sprite_id, rigDef, this.sprites);
    this.player.spawnAt(levelDef.player_spawn.x, levelDef.player_spawn.y, this.level.tileSize);
    this.worldLayer.addChild(this.player.sprite);
    this.worldLayer.addChild(this.fx.container); // частицы поверх всего
    this.updateCamera();
  }

  /**
   * Настройка интерфейса (HUD): таймер старения и счетчики деталей
   */
  private setupHUD(): void {
    const hudLayer = new Container();
    this.app.stage.addChild(hudLayer);

    const style = new TextStyle({
      fontFamily: 'Courier New',
      fontSize: 10,
      fill: GAME_CONFIG.TEXT_COLOR,
      stroke: { color: 0x000000, width: 2 }
    });

    this.timerText = new Text({ text: 'РЕАКТОР: 05:00', style });
    this.timerText.position.set(10, 8);
    hudLayer.addChild(this.timerText);

    this.hudText = new Text({
      text: `HP: 100/100 | ДЕТАЛИ: 0/5 | РЕЗИСТОРЫ: 0/3`,
      style
    });
    this.hudText.position.set(10, 22);
    hudLayer.addChild(this.hudText);
    this.timerText.resolution = this.hudText.resolution = this.scale;

    // Слушатель тиков подсистемы старения
    EventBus.get().on('aging:tick', (state) => {
      const minutes = Math.floor(state.timeRemaining / 60).toString().padStart(2, '0');
      const seconds = Math.floor(state.timeRemaining % 60).toString().padStart(2, '0');
      this.timerText.text = `РЕАКТОР: ${minutes}:${seconds}`;

      if (state.isCritical) {
        this.timerText.style.fill = GAME_CONFIG.ACCENT_RED;
      } else if (state.isWarning) {
        this.timerText.style.fill = GAME_CONFIG.ACCENT_AMBER;
      }
    });
  }

  /** Паучок, выплюнутый маткой: летит из точки (x, y), садится на поверхность и дальше ползает как обычный паук. */
  private spawnBaby(defs: Map<string, EnemyDef>, mother: EnemyDef, x: number, y: number, vx: number, vy: number): Spider | null {
    const cfg = mother.spawns;
    const babyDef = cfg && defs.get(cfg.enemy_id);
    const rig = babyDef?.rig_id ? RIGS.find((r) => r.id === babyDef.rig_id) : undefined;
    if (!cfg || !babyDef || !rig) return null;
    const spawn = { enemy_id: babyDef.id, sprite_id: cfg.sprite_id ?? babyDef.sprite_variants[0], x: 0, y: 0 };
    const baby = new Spider(babyDef, spawn, this.level, rig, this.sprites, { scale: cfg.scale, lifetime: cfg.lifetime_seconds, fx: this.fx });
    baby.launch(x, y, vx, vy);
    this.spiders.push(baby); // слой выбирает матка: сначала ниже себя, потом передний
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
        ...rig.parts.map((p) => p.sprite_id),
        ...(rig.crawler?.legs.flatMap((l) => [l.upper_sprite_id, l.lower_sprite_id]) ?? []),
        ...(rig.segmented ? [rig.segmented.head.sprite_id, rig.segmented.body.sprite_id, rig.segmented.tail.sprite_id] : []),
        ...(rig.wobbler ? [rig.wobbler.sprite_id, ...(rig.wobbler.thread ? [rig.wobbler.thread.sprite_id] : []), ...rig.wobbler.limbs.map((l) => l.sprite_id)] : [])
      );
    }
    if (def.spawns) ids.push(...this.enemySpriteIds(defs, def.spawns.enemy_id, def.spawns.sprite_id, depth + 1));
    return ids;
  }

  /**
   * Главный цикл обновления физики и логики
   */
  private update(dt: number): void {
    dt = Math.min(dt, 1 / 30); // защита от «туннелирования» после лагов/вкладки в фоне

    // 1. Обновление таймера старения
    this.aging.update(dt);

    // 2. Игрок: ввод + физика на тайлах
    this.player.update(dt, this.input.poll(), this.level, this.aimInWorld());

    // 3. Враги
    for (const spider of this.spiders) spider.update(dt);
    for (const worm of this.worms) worm.update(dt);
    for (const mother of this.mothers) mother.update(dt);
    this.fx.update(dt);
    // Выплюнутые паучки живут ограниченное время
    for (let i = this.spiders.length - 1; i >= 0; i--) {
      if (!this.spiders[i].expired) continue;
      this.spiders[i].container.destroy({ children: true });
      this.spiders.splice(i, 1);
    }

    // 4. Камера
    this.updateCamera(dt);
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
  if (import.meta.env.DEV) (window as unknown as { __game: GameApp }).__game = game; // отладка из консоли браузера
});
