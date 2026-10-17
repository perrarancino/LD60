import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { SpriteLibrary } from './assets/SpriteLibrary.ts';
import type { EnemyDef, LevelDef, TileSetDef } from './data/types.ts';
import { Enemy } from './entities/Enemy.ts';
import { Player } from './entities/Player.ts';
import { Level } from './world/Level.ts';
import { GAME_CONFIG } from './core/Constants.ts';
import { InputManager } from './core/InputManager.ts';
import { AgingSystem } from './systems/AgingSystem.ts';
import { EventBus } from './core/EventBus.ts';

// Загрузка начальных параметров игрока из конфигурационного JSON
import playerData from '../data/player/player_initial_state.json';
import enemiesData from '../data/enemies/enemies.json';
import tilesData from '../data/tiles/tiles.json';
import levelData from '../data/levels/test_level.json';

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

    await this.setupScene();
    this.setupHUD();

    // Запуск основного игрового цикла (Pixi ticker)
    this.app.ticker.add((ticker) => {
      const dt = ticker.deltaTime / 60; // Перевод тиков в секунды
      this.update(dt);
    });
  }

  /**
   * Расчет целочисленного масштаба для сохранения четкости пикселей при любых размерах окна
   */
  private handleResize(): void {
    const windowW = window.innerWidth;
    const windowH = window.innerHeight;

    // Вычисляем максимальный целый множитель масштабирования
    const scale = Math.max(1, Math.min(
      Math.floor(windowW / GAME_CONFIG.VIRTUAL_WIDTH),
      Math.floor(windowH / GAME_CONFIG.VIRTUAL_HEIGHT)
    ));

    const finalW = GAME_CONFIG.VIRTUAL_WIDTH * scale;
    const finalH = GAME_CONFIG.VIRTUAL_HEIGHT * scale;

    const canvas = this.app.canvas;
    canvas.style.width = `${finalW}px`;
    canvas.style.height = `${finalH}px`;
  }

  /**
   * Сцена: фоновая сетка, тестовый уровень из data/levels, герой и враги
   */
  private async setupScene(): Promise<void> {
    // Фоновая сетка токоведущих дорожек материнской платы (неподвижная)
    const grid = new Graphics();
    grid.setStrokeStyle({ width: 1, color: 0x18202c, alpha: 0.6 });
    for (let x = 0; x < GAME_CONFIG.VIRTUAL_WIDTH; x += 16) {
      grid.moveTo(x, 0).lineTo(x, GAME_CONFIG.VIRTUAL_HEIGHT);
    }
    for (let y = 0; y < GAME_CONFIG.VIRTUAL_HEIGHT; y += 16) {
      grid.moveTo(0, y).lineTo(GAME_CONFIG.VIRTUAL_WIDTH, y);
    }
    grid.stroke();
    this.app.stage.addChild(grid);

    const tileset = tilesData as TileSetDef;
    const levelDef = levelData as LevelDef;
    const enemyDefs = new Map((enemiesData as unknown as EnemyDef[]).map((e) => [e.id, e]));

    // Загружаем только те спрайты, которые реально нужны уровню
    await this.sprites.load([
      playerData.sprite_id,
      ...Level.spriteIds(levelDef, tileset),
      ...levelDef.enemies.map((e) => e.sprite_id)
    ]);

    this.worldLayer = new Container();
    this.app.stage.addChild(this.worldLayer);

    this.level = new Level(levelDef, tileset, this.sprites);
    this.worldLayer.addChild(this.level.container);
    // Прижимаем уровень к низу экрана
    this.worldLayer.y = GAME_CONFIG.VIRTUAL_HEIGHT - this.level.pixelHeight;

    for (const spawn of levelDef.enemies) {
      const def = enemyDefs.get(spawn.enemy_id);
      if (!def) throw new Error(`Уровень ссылается на неизвестного врага "${spawn.enemy_id}"`);
      const enemy = new Enemy(def, spawn, this.level.tileSize, this.sprites);
      this.enemies.push(enemy);
      this.worldLayer.addChild(enemy.sprite);
    }

    this.player = new Player(playerData.sprite_id, this.sprites);
    this.player.spawnAt(levelDef.player_spawn.x, levelDef.player_spawn.y, this.level.tileSize);
    this.worldLayer.addChild(this.player.sprite);
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
    this.player.update(dt, this.input.poll(), this.level);

    // 3. Камера следует за героем по горизонтали и не выходит за границы уровня
    const maxScroll = Math.max(0, this.level.pixelWidth - GAME_CONFIG.VIRTUAL_WIDTH);
    const scroll = Math.max(0, Math.min(maxScroll, this.player.body.x - GAME_CONFIG.VIRTUAL_WIDTH / 2));
    this.worldLayer.x = -Math.round(scroll);
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
});
