import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { GAME_CONFIG } from './core/Constants.ts';
import { InputManager } from './core/InputManager.ts';
import { AgingSystem } from './systems/AgingSystem.ts';
import { EventBus } from './core/EventBus.ts';

// Загрузка начальных параметров игрока из конфигурационного JSON
import playerData from '../data/player/player_initial_state.json';

class GameApp {
  private app: Application;
  private input: InputManager;
  private aging: AgingSystem;

  private gameContainer: HTMLElement;
  private hudText!: Text;
  private timerText!: Text;
  private playerGraphics!: Graphics;

  private playerX = 120;
  private playerY = 180;
  private playerVy = 0;
  private isGrounded = true;

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

    this.setupScene();
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
   * Базовая сцена: дорожки текстолита и платформа
   */
  private setupScene(): void {
    const worldLayer = new Container();
    this.app.stage.addChild(worldLayer);

    // Фоновая сетка токоведущих дорожек материнской платы
    const grid = new Graphics();
    grid.setStrokeStyle({ width: 1, color: 0x18202c, alpha: 0.6 });
    for (let x = 0; x < GAME_CONFIG.VIRTUAL_WIDTH; x += 16) {
      grid.moveTo(x, 0).lineTo(x, GAME_CONFIG.VIRTUAL_HEIGHT);
    }
    for (let y = 0; y < GAME_CONFIG.VIRTUAL_HEIGHT; y += 16) {
      grid.moveTo(0, y).lineTo(GAME_CONFIG.VIRTUAL_WIDTH, y);
    }
    grid.stroke();
    worldLayer.addChild(grid);

    // Платформа пола (край текстолитовой платы)
    const floor = new Graphics();
    floor.rect(0, 210, GAME_CONFIG.VIRTUAL_WIDTH, 60);
    floor.fill(0x133025); // Темно-зеленый текстолит
    floor.stroke({ width: 2, color: 0x22c55e });
    worldLayer.addChild(floor);

    // Временная визуализация робота модели «Утиль»
    this.playerGraphics = new Graphics();
    this.drawRobot(this.playerGraphics, 0x00f0ff);
    worldLayer.addChild(this.playerGraphics);
  }

  private drawRobot(g: Graphics, color: number): void {
    g.clear();
    // Корпус робота (угловатый каркас)
    g.rect(-8, -16, 16, 16).fill(0x334155).stroke({ width: 1, color });
    // Визор / светящееся ядро
    g.rect(-4, -13, 8, 4).fill(color);
    // Опоры / манипуляторы
    g.rect(-6, 0, 4, 6).fill(0x1e293b);
    g.rect(2, 0, 4, 6).fill(0x1e293b);
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
    // 1. Обновление таймера старения
    this.aging.update(dt);

    // 2. Опрос ввода игрока
    const input = this.input.poll();

    // Горизонтальное перемещение
    this.playerX += input.horizontal * GAME_CONFIG.PLAYER_SPEED * dt;
    this.playerX = Math.max(16, Math.min(GAME_CONFIG.VIRTUAL_WIDTH - 16, this.playerX));

    // Прыжок и гравитация
    if (this.isGrounded && input.jumpPressed) {
      this.playerVy = GAME_CONFIG.JUMP_FORCE;
      this.isGrounded = false;
    }

    if (!this.isGrounded) {
      this.playerVy += GAME_CONFIG.GRAVITY * dt;
      this.playerY += this.playerVy * dt;

      // Коллизия с полом на высоте y = 210
      if (this.playerY >= 210) {
        this.playerY = 210;
        this.playerVy = 0;
        this.isGrounded = true;
      }
    }

    // Применение рассчитанных координат к объекту отрисовки
    this.playerGraphics.position.set(this.playerX, this.playerY);
  }
}

// Запуск приложения при готовности DOM
window.addEventListener('DOMContentLoaded', () => {
  const game = new GameApp();
  game.start().catch(console.error);
});
