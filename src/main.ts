import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { SpriteLibrary } from './assets/SpriteLibrary.ts';
import type { BackgroundDef, EnemyDef, LevelDef, RigDef, TileSetDef } from './data/types.ts';
import { Enemy } from './entities/Enemy.ts';
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

// Все параллакс-фоны из data/backgrounds (уровень выбирает свой по background_id)
const BACKGROUNDS = Object.values(
  import.meta.glob('../data/backgrounds/*.json', { eager: true, import: 'default' }) as Record<string, BackgroundDef>
);

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

  // Размер видимой области в «виртуальных» пикселях: растёт вместе с окном, пиксели не растягиваются
  private viewW: number = GAME_CONFIG.VIRTUAL_WIDTH;
  private viewH: number = GAME_CONFIG.VIRTUAL_HEIGHT;
  private grid = new Graphics();
  private background: ParallaxBackground | null = null;
  private scale = 1;
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

  /** Камера: следует за героем; если уровень меньше обзора по оси — центрируется (по X) / прижимается к низу (по Y). */
  private updateCamera(): void {
    const { x, y } = this.player.body;
    const lw = this.level.pixelWidth;
    const lh = this.level.pixelHeight;

    const camX = lw <= this.viewW
      ? -(this.viewW - lw) / 2
      : Math.max(0, Math.min(lw - this.viewW, x - this.viewW / 2));
    const camY = lh <= this.viewH
      ? lh - this.viewH
      : Math.max(0, Math.min(lh - this.viewH, y - this.viewH * 0.6));

    // Камера выровнена по физическим пикселям: тайлы остаются чёткими, герой и камера не дрожат друг относительно друга
    const snap = (v: number) => Math.round(v * this.scale) / this.scale;
    this.worldLayer.position.set(-snap(camX), -snap(camY));
    this.background?.update(snap(camX), this.scale);
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
      ...levelDef.enemies.map((e) => e.sprite_id)
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
      const enemy = new Enemy(def, spawn, this.level.tileSize, this.sprites);
      this.enemies.push(enemy);
      this.worldLayer.addChild(enemy.sprite);
    }

    this.player = new Player(playerData.sprite_id, rigDef, this.sprites);
    this.player.spawnAt(levelDef.player_spawn.x, levelDef.player_spawn.y, this.level.tileSize);
    this.worldLayer.addChild(this.player.sprite);
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

  /**
   * Главный цикл обновления физики и логики
   */
  private update(dt: number): void {
    dt = Math.min(dt, 1 / 30); // защита от «туннелирования» после лагов/вкладки в фоне

    // 1. Обновление таймера старения
    this.aging.update(dt);

    // 2. Игрок: ввод + физика на тайлах
    this.player.update(dt, this.input.poll(), this.level, this.aimInWorld());

    // 3. Камера
    this.updateCamera();
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
  if (import.meta.env.DEV) (window as unknown as { __game: GameApp }).__game = game; // отладка из консоли браузера
});
