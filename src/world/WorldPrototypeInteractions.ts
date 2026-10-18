import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Particles } from '../effects/Particles.ts';
import type { Player } from '../entities/Player.ts';
import type { InputState } from '../core/InputManager.ts';
import { ItemSocketPuzzle, type PuzzleItem, type PuzzleSocket } from '../systems/ItemSocketPuzzle.ts';
import { CipherTerminalPuzzle, type CipherClue } from '../systems/CipherTerminalPuzzle.ts';

/**
 * Интерактивные сущности и головоломки прототипа мира:
 * 1. Головоломка с таблеткой (ItemSocketPuzzle) в нижнем отсеке (подбор на E, переноска, установка в слот).
 * 2. Настенные цифры шифра на стенах уровней (Хаб, Коридор, Комната молнии, Нижний отсек).
 * 3. Шифровальная машина (CipherTerminalPuzzle) в маленькой комнате слева с интерактивным терминалом.
 */
export class WorldPrototypeInteractions {
  private readonly worldLayer: Container;
  private readonly fx: Particles;
  private readonly player: Player;

  // Системы головоломок
  public readonly socketPuzzle: ItemSocketPuzzle;
  public readonly cipherPuzzle: CipherTerminalPuzzle;

  // Графические контейнеры
  private readonly puzzleContainer = new Container();
  private readonly tabletGraphic = new Graphics();
  private readonly socketGraphic = new Graphics();
  private readonly terminalGraphic = new Graphics();
  private readonly cluesContainer = new Container();
  private readonly clueVisuals: Map<string, { container: Container; text: Text; marker: Graphics; clue: CipherClue }> = new Map();

  // Подсказка над героем
  private readonly promptContainer = new Container();
  private readonly promptBg = new Graphics();
  private readonly promptText: Text;

  private time = 0;
  private modalElem: HTMLElement | null = null;
  private toastElem: HTMLElement | null = null;
  private toastTimer = 0;
  private isModalOpen = false;

  constructor(worldLayer: Container, fx: Particles, player: Player) {
    this.worldLayer = worldLayer;
    this.fx = fx;
    this.player = player;

    // 1. Инициализация головоломки с таблеткой
    // Координаты: таблетка на постаменте в нижнем отсеке (x: 72*32=2304, y: 33*32=1056)
    // Сокет: на стене справа в нижнем отсеке (x: 92*32=2944, y: 35*32=1120)
    const initialItem: PuzzleItem = {
      id: 'energy_tablet',
      name: 'Энерго-таблетка',
      x: 72 * 32 + 16,
      y: 33 * 32 + 16,
      pickupRadius: 38,
      state: 'on_ground'
    };

    const initialSocket: PuzzleSocket = {
      id: 'lower_hub_socket',
      name: 'Гнездо питания нижнего отсека',
      x: 92 * 32 + 16,
      y: 35 * 32 + 16,
      interactionRadius: 44,
      requiredItemIds: ['energy_tablet'],
      isOccupied: false
    };

    this.socketPuzzle = new ItemSocketPuzzle({
      id: 'world_socket_puzzle',
      name: 'Установка таблетки питания',
      items: [initialItem],
      sockets: [initialSocket],
      onItemInserted: () => {
        this.showToast('⚡ ЭНЕРГО-ТАБЛЕТКА УСТАНОВЛЕНА! Питание нижнего отсека подано!');
        this.fx.burst(initialSocket.x, initialSocket.y - 10, {
          count: 24,
          colors: [0x4ade80, 0x22c55e, 0xffffff, 0x38bdf8],
          speed: [40, 130],
          angle: -Math.PI / 2,
          spread: 1.5,
          life: [0.3, 0.7],
          size: [2, 3],
          gravity: 80
        });
      }
    });

    // 2. Инициализация настенного шифра и терминала
    // Терминал в шифровальной комнате: x: 42*32=1344, y: 14*32=448
    // Настенные цифры:
    // [I] = 3 (Хаб, x: 7*32=224, y: 26*32=832)
    // [II] = 7 (Коридор, x: 27*32=864, y: 27*32=864)
    // [III] = 1 (Комната молнии 1, x: 45*32=1440, y: 22*32=704)
    // [IV] = 5 (Нижняя комната, x: 86*32=2752, y: 34*32=1088)
    const clues: CipherClue[] = [
      { id: 'clue_1', orderIndex: 0, digit: 3, x: 7 * 32 + 16, y: 26 * 32 + 16, label: 'Хаб [I]: 3', isDiscovered: false, discoveryRadius: 48 },
      { id: 'clue_2', orderIndex: 1, digit: 7, x: 27 * 32 + 16, y: 27 * 32 + 16, label: 'Коридор [II]: 7', isDiscovered: false, discoveryRadius: 48 },
      { id: 'clue_3', orderIndex: 2, digit: 1, x: 45 * 32 + 16, y: 22 * 32 + 16, label: 'Сектор боев 1 [III]: 1', isDiscovered: false, discoveryRadius: 48 },
      { id: 'clue_4', orderIndex: 3, digit: 5, x: 86 * 32 + 16, y: 34 * 32 + 16, label: 'Нижний сектор [IV]: 5', isDiscovered: false, discoveryRadius: 48 }
    ];

    this.cipherPuzzle = new CipherTerminalPuzzle({
      id: 'world_cipher_puzzle',
      codeLength: 4,
      secretCode: '3715',
      clues,
      terminalLocation: {
        x: 42 * 32 + 16,
        y: 14 * 32 + 16,
        interactionRadius: 48
      },
      onClueDiscovered: (clue) => {
        const roman = ['I', 'II', 'III', 'IV'][clue.orderIndex] || `${clue.orderIndex + 1}`;
        this.showToast(`💡 Обнаружен символ шифра на стене: [${roman}] = ${clue.digit}`);
        this.fx.burst(clue.x, clue.y, {
          count: 14,
          colors: [0x38bdf8, 0x0ea5e9, 0xffffff],
          speed: [30, 90],
          angle: -Math.PI / 2,
          spread: 1.2,
          life: [0.2, 0.5],
          size: [1, 2]
        });
      },
      onSolved: () => {
        this.showToast('🔓 ШИФР ВЕРЕН! Система деблокирована, шлюз открыт!');
        const term = this.cipherPuzzle.getState().terminalLocation;
        this.fx.burst(term.x, term.y, {
          count: 35,
          colors: [0x4ade80, 0x38bdf8, 0xfacc15, 0xffffff],
          speed: [50, 160],
          angle: -Math.PI / 2,
          spread: 1.8,
          life: [0.4, 0.9],
          size: [2, 4]
        });
      }
    });

    // Настройка подсказки взаимодействия
    const style = new TextStyle({
      fontFamily: 'Courier New, monospace',
      fontSize: 11,
      fontWeight: 'bold',
      fill: 0xffffff,
      align: 'center'
    });
    this.promptText = new Text({ text: '', style });
    this.promptContainer.addChild(this.promptBg);
    this.promptContainer.addChild(this.promptText);
    this.promptContainer.visible = false;

    // Сборка слоёв
    this.puzzleContainer.addChild(this.cluesContainer);
    this.puzzleContainer.addChild(this.socketGraphic);
    this.puzzleContainer.addChild(this.tabletGraphic);
    this.puzzleContainer.addChild(this.terminalGraphic);
    this.puzzleContainer.addChild(this.promptContainer);
    this.worldLayer.addChild(this.puzzleContainer);

    this.setupWallClues();
    this.createToastDOM();
    this.createTerminalModalDOM();
  }

  /** Создание визуальных меток цифр на стенах */
  private setupWallClues(): void {
    const clues = this.cipherPuzzle.getState().clues;
    const romans = ['I', 'II', 'III', 'IV'];

    for (const clue of clues) {
      const group = new Container();
      group.position.set(clue.x, clue.y);

      const marker = new Graphics();
      // Рамка микрочипа на плате
      marker.rect(-16, -16, 32, 32);
      marker.fill({ color: 0x0b1320, alpha: 0.85 });
      marker.stroke({ width: 1.5, color: 0x38bdf8, alpha: 0.7 });

      // Медные ножки чипа
      for (let i = -12; i <= 12; i += 8) {
        marker.moveTo(i, -16).lineTo(i, -20);
        marker.moveTo(i, 16).lineTo(i, 20);
      }
      marker.stroke({ width: 1, color: 0xd97706, alpha: 0.9 });

      const roman = romans[clue.orderIndex] || `${clue.orderIndex + 1}`;
      const textStyle = new TextStyle({
        fontFamily: 'Courier New, monospace',
        fontSize: 10,
        fontWeight: 'bold',
        fill: 0x38bdf8,
        align: 'center'
      });
      const text = new Text({ text: `${roman}\n${clue.digit}`, style: textStyle });
      text.anchor.set(0.5, 0.5);

      group.addChild(marker);
      group.addChild(text);
      this.cluesContainer.addChild(group);

      this.clueVisuals.set(clue.id, { container: group, text, marker, clue });
    }
  }

  /** Создание всплывающего уведомления в DOM */
  private createToastDOM(): void {
    let elem = document.getElementById('world-game-toast');
    if (!elem) {
      elem = document.createElement('div');
      elem.id = 'world-game-toast';
      elem.style.position = 'fixed';
      elem.style.top = '18px';
      elem.style.left = '50%';
      elem.style.transform = 'translateX(-50%)';
      elem.style.background = 'rgba(15, 23, 42, 0.92)';
      elem.style.border = '1px solid #38bdf8';
      elem.style.boxShadow = '0 0 15px rgba(56, 189, 248, 0.35)';
      elem.style.borderRadius = '6px';
      elem.style.padding = '8px 16px';
      elem.style.color = '#fff';
      elem.style.fontFamily = 'Courier New, monospace';
      elem.style.fontSize = '13px';
      elem.style.fontWeight = '700';
      elem.style.pointerEvents = 'none';
      elem.style.transition = 'opacity 0.25s, transform 0.25s';
      elem.style.opacity = '0';
      elem.style.zIndex = '9999';
      document.body.appendChild(elem);
    }
    this.toastElem = elem;
  }

  public showToast(msg: string): void {
    if (!this.toastElem) return;
    this.toastElem.textContent = msg;
    this.toastElem.style.opacity = '1';
    this.toastElem.style.transform = 'translateX(-50%) translateY(0)';
    this.toastTimer = 3.2; // секунды
  }

  /** Создание интерактивного модального окна терминала шифровальной машины */
  private createTerminalModalDOM(): void {
    let modal = document.getElementById('cipher-terminal-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cipher-terminal-modal';
      modal.style.position = 'fixed';
      modal.style.inset = '0';
      modal.style.background = 'rgba(4, 8, 16, 0.78)';
      modal.style.backdropFilter = 'blur(4px)';
      modal.style.display = 'none';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
      modal.style.zIndex = '10000';

      modal.innerHTML = `
        <div style="width: 480px; max-width: 94vw; background: #0c121e; border: 2px solid #22c55e; box-shadow: 0 0 25px rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 20px; color: #22c55e; font-family: 'Courier New', monospace;">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #22c55e; padding-bottom: 8px; margin-bottom: 14px;">
            <div style="font-weight: 700; font-size: 15px; letter-spacing: 1px;">📟 ТЕРМИНАЛ ШИФРОВАНИЯ (СЕКТОР 0-A)</div>
            <button id="cipher-close-btn" style="background: none; border: 1px solid #22c55e; color: #22c55e; padding: 2px 8px; cursor: pointer; border-radius: 4px; font-weight: bold;">✕ ESC</button>
          </div>

          <div style="font-size: 11px; color: #86efac; margin-bottom: 12px; line-height: 1.4;">
            Соберите 4 цифры шифра со стен уровней (Хаб, Коридор, Сектор 1, Нижний сектор) и введите код для снятия блокировки.
          </div>

          <!-- Панель найденных подсказок -->
          <div style="background: #060911; border: 1px solid #166534; border-radius: 6px; padding: 10px; margin-bottom: 14px;">
            <div style="font-size: 10px; color: #4ade80; margin-bottom: 6px; font-weight: 700;">ЖУРНАЛ СКАНИРОВАНИЯ СТЕН:</div>
            <div id="cipher-clues-summary" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; font-size: 13px; font-weight: bold;">
              <!-- Заполняется динамически -->
            </div>
          </div>

          <!-- Экран ввода кода -->
          <div style="background: #020617; border: 1px solid #22c55e; border-radius: 6px; padding: 12px; text-align: center; margin-bottom: 14px;">
            <div style="font-size: 11px; color: #4ade80; margin-bottom: 4px;">ТЕКУЩИЙ ВВОД КОДА:</div>
            <div id="cipher-code-display" style="font-size: 28px; letter-spacing: 12px; font-weight: 900; color: #facc15; min-height: 38px;">
              _ _ _ _
            </div>
            <div id="cipher-status-msg" style="font-size: 11px; color: #86efac; margin-top: 6px; min-height: 16px;">
              Введите 4 цифры
            </div>
          </div>

          <!-- Цифровая клавиатура -->
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
            <button class="cipher-num-btn" data-digit="1" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">1</button>
            <button class="cipher-num-btn" data-digit="2" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">2</button>
            <button class="cipher-num-btn" data-digit="3" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">3</button>
            <button class="cipher-num-btn" data-digit="4" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">4</button>
            <button class="cipher-num-btn" data-digit="5" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">5</button>
            <button class="cipher-num-btn" data-digit="6" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">6</button>
            <button class="cipher-num-btn" data-digit="7" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">7</button>
            <button class="cipher-num-btn" data-digit="8" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">8</button>
            <button class="cipher-num-btn" data-digit="9" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">9</button>
            <button id="cipher-clear-btn" style="background: #1f2937; border: 1px solid #ef4444; color: #ef4444; font-size: 13px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">⌫ СТЕРЕТЬ</button>
            <button class="cipher-num-btn" data-digit="0" style="background: #111d33; border: 1px solid #22c55e; color: #fff; font-size: 18px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">0</button>
            <button id="cipher-submit-btn" style="background: #166534; border: 1px solid #22c55e; color: #fff; font-size: 13px; font-weight: bold; padding: 10px; border-radius: 4px; cursor: pointer;">✓ ВВОД</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      modal.querySelector('#cipher-close-btn')?.addEventListener('click', () => this.closeTerminalModal());
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeTerminalModal();
      });

      modal.querySelectorAll('.cipher-num-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const d = parseInt((btn as HTMLElement).dataset.digit || '0', 10);
          this.cipherPuzzle.inputDigit(d);
          this.updateTerminalModalDisplay();
        });
      });

      modal.querySelector('#cipher-clear-btn')?.addEventListener('click', () => {
        this.cipherPuzzle.backspace();
        this.updateTerminalModalDisplay();
      });

      modal.querySelector('#cipher-submit-btn')?.addEventListener('click', () => {
        this.submitCipherInput();
      });

      window.addEventListener('keydown', (e) => {
        if (!this.isModalOpen) return;
        if (e.key === 'Escape') {
          this.closeTerminalModal();
          return;
        }
        if (e.key >= '0' && e.key <= '9') {
          this.cipherPuzzle.inputDigit(parseInt(e.key, 10));
          this.updateTerminalModalDisplay();
        } else if (e.key === 'Backspace') {
          this.cipherPuzzle.backspace();
          this.updateTerminalModalDisplay();
        } else if (e.key === 'Enter') {
          this.submitCipherInput();
        }
      });
    }
    this.modalElem = modal;
  }

  public openTerminalModal(): void {
    if (!this.modalElem) return;
    this.isModalOpen = true;
    this.modalElem.style.display = 'flex';
    this.updateTerminalModalDisplay();
  }

  public closeTerminalModal(): void {
    if (!this.modalElem) return;
    this.isModalOpen = false;
    this.modalElem.style.display = 'none';
  }

  private updateTerminalModalDisplay(): void {
    if (!this.modalElem) return;
    const cluesWrap = this.modalElem.querySelector('#cipher-clues-summary');
    if (cluesWrap) {
      cluesWrap.innerHTML = '';
      const clues = this.cipherPuzzle.getState().clues;
      const romans = ['I', 'II', 'III', 'IV'];
      clues.forEach((c: CipherClue) => {
        const item = document.createElement('div');
        item.style.padding = '6px';
        item.style.background = c.isDiscovered ? 'rgba(34, 197, 94, 0.15)' : 'rgba(100, 116, 139, 0.1)';
        item.style.border = c.isDiscovered ? '1px solid #22c55e' : '1px dashed #475569';
        item.style.borderRadius = '4px';
        const roman = romans[c.orderIndex] || `${c.orderIndex + 1}`;
        item.innerHTML = `
          <div style="font-size: 10px; color: ${c.isDiscovered ? '#86efac' : '#94a3b8'};">[${roman}]</div>
          <div style="color: ${c.isDiscovered ? '#facc15' : '#64748b'}; font-size: 16px;">${c.isDiscovered ? c.digit : '?'}</div>
        `;
        cluesWrap.appendChild(item);
      });
    }

    const codeDisplay = this.modalElem.querySelector('#cipher-code-display');
    const entered = this.cipherPuzzle.currentEnteredCode;
    const length = this.cipherPuzzle.length;
    let text = '';
    for (let i = 0; i < length; i++) {
      text += (i < entered.length ? entered[i] : '_') + ' ';
    }
    if (codeDisplay) codeDisplay.textContent = text.trim();

    const statusMsg = this.modalElem.querySelector('#cipher-status-msg') as HTMLElement;
    if (statusMsg) {
      if (this.cipherPuzzle.isSolved) {
        statusMsg.textContent = '✓ ШИФР ПРИНЯТ — СИСТЕМА ДЕБЛОКИРОВАНА!';
        statusMsg.style.color = '#4ade80';
      } else {
        statusMsg.textContent = entered.length === length ? 'Нажмите ВВОД для проверки' : `Введено ${entered.length}/${length} цифр`;
        statusMsg.style.color = '#86efac';
      }
    }
  }

  private submitCipherInput(): void {
    const res = this.cipherPuzzle.submit();
    this.updateTerminalModalDisplay();
    const statusMsg = this.modalElem?.querySelector('#cipher-status-msg') as HTMLElement;

    if (res.isCorrect) {
      if (statusMsg) {
        statusMsg.textContent = '✓ ВЕРНО! Шлюз разблокирован!';
        statusMsg.style.color = '#4ade80';
      }
      setTimeout(() => this.closeTerminalModal(), 1200);
    } else {
      if (statusMsg) {
        statusMsg.textContent = `✕ ОШИБКА: ${res.message}`;
        statusMsg.style.color = '#ef4444';
      }
    }
  }

  /** Обновление логики и отрисовки каждый кадр */
  public update(dt: number, input: InputState): void {
    this.time += dt;

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0 && this.toastElem) {
        this.toastElem.style.opacity = '0';
        this.toastElem.style.transform = 'translateX(-50%) translateY(-10px)';
      }
    }

    const playerX = this.player.body.x;
    const playerY = this.player.body.y;

    // 1. Проверка обнаружения настенных цифр
    this.cipherPuzzle.checkClueDiscovery(playerX, playerY);

    // 2. Обновление визуалов настенных меток
    for (const [, item] of this.clueVisuals.entries()) {
      const isDisc = item.clue.isDiscovered;
      const alpha = isDisc ? 0.95 : 0.45;
      item.container.alpha = alpha;
      const pulse = isDisc ? 0.9 + Math.sin(this.time * 3 + item.clue.orderIndex) * 0.1 : 0.4;
      item.text.alpha = pulse;
    }

    // 3. Таблетка и Сокет
    const item = this.socketPuzzle.getItems().find((i) => i.id === 'energy_tablet');
    const socket = this.socketPuzzle.getSockets().find((s) => s.id === 'lower_hub_socket');

    // Отрисовка сокета
    if (socket) {
      const g = this.socketGraphic;
      g.clear();
      // Гнездо в стене / на постаменте
      g.rect(socket.x - 14, socket.y - 14, 28, 28);
      g.fill({ color: 0x0f172a });
      g.stroke({ width: 2, color: socket.isOccupied ? 0x22c55e : 0xd97706 });

      // Центральный контакт
      g.circle(socket.x, socket.y, 6);
      g.fill({ color: socket.isOccupied ? 0x4ade80 : 0x78350f });

      // Неоновые линии дорожек
      const glowCol = socket.isOccupied ? 0x4ade80 : 0xf59e0b;
      g.moveTo(socket.x - 14, socket.y).lineTo(socket.x - 22, socket.y);
      g.moveTo(socket.x + 14, socket.y).lineTo(socket.x + 22, socket.y);
      g.stroke({ width: 1.5, color: glowCol, alpha: 0.8 });
    }

    // Отрисовка таблетки
    if (item) {
      const g = this.tabletGraphic;
      g.clear();

      let tx = item.x;
      let ty = item.y;

      if (item.state === 'carried') {
        // Таблетка в руках у героя над головой
        tx = playerX;
        ty = playerY - 34;
        item.x = tx;
        item.y = ty;
      } else if (item.state === 'on_ground') {
        // Парит с покачиванием
        ty += Math.sin(this.time * 4) * 3;
      }

      // Форма пилюли / таблетки
      const fillCol = item.state === 'inserted' ? 0x4ade80 : 0x38bdf8;
      const coreCol = item.state === 'inserted' ? 0x86efac : 0xfacc15;

      // Внешняя капсула
      g.roundRect(tx - 10, ty - 5, 20, 10, 4);
      g.fill({ color: fillCol });
      g.stroke({ width: 1, color: 0xffffff });

      // Золотой сердечник по центру
      g.roundRect(tx - 3, ty - 5, 6, 10, 2);
      g.fill({ color: coreCol });

      // Ореол свечения
      g.circle(tx, ty, 12);
      g.stroke({ width: 1, color: fillCol, alpha: 0.4 + Math.sin(this.time * 5) * 0.2 });
    }

    // 4. Отрисовка терминала шифровальной машины
    const termLoc = this.cipherPuzzle.getState().terminalLocation;
    const tg = this.terminalGraphic;
    tg.clear();
    // Корпус терминала
    tg.rect(termLoc.x - 16, termLoc.y - 20, 32, 40);
    tg.fill({ color: 0x1e293b });
    tg.stroke({ width: 2, color: 0x334155 });

    // Экран CRT
    tg.rect(termLoc.x - 12, termLoc.y - 16, 24, 18);
    tg.fill({ color: this.cipherPuzzle.isSolved ? 0x064e3b : 0x022c22 });
    tg.stroke({ width: 1, color: this.cipherPuzzle.isSolved ? 0x4ade80 : 0x22c55e });

    // Сканирующая полоса на экране
    const scanY = termLoc.y - 16 + ((this.time * 20) % 18);
    tg.moveTo(termLoc.x - 12, scanY).lineTo(termLoc.x + 12, scanY);
    tg.stroke({ width: 1, color: 0x86efac, alpha: 0.6 });

    // Клавиатура под экраном
    tg.rect(termLoc.x - 12, termLoc.y + 6, 24, 10);
    tg.fill({ color: 0x0f172a });
    tg.stroke({ width: 1, color: 0x475569 });

    // 5. Обработка подсказок и взаимодействий игрока
    let promptMsg: string | null = null;
    let promptX = playerX;
    let promptY = playerY - 48;

    // А. Взаимодействие с терминалом
    const isNearTerminal = this.cipherPuzzle.isNearTerminal(playerX, playerY);
    if (isNearTerminal && !this.isModalOpen) {
      promptMsg = this.cipherPuzzle.isSolved ? '[E] Терминал (Разблокирован)' : '[E] Терминал шифра';
      promptX = termLoc.x;
      promptY = termLoc.y - 30;

      if (input.interactPressed) {
        this.openTerminalModal();
      }
    }

    // Б. Взаимодействие с таблеткой и сокетом
    if (!this.isModalOpen && !isNearTerminal) {
      if (item && item.state === 'on_ground') {
        const dist = Math.hypot(playerX - item.x, playerY - item.y);
        if (dist <= item.pickupRadius) {
          promptMsg = '[E] Взять энерго-таблетку';
          promptX = item.x;
          promptY = item.y - 20;

          if (input.interactPressed) {
            this.socketPuzzle.tryPickup(playerX, playerY, item.id);
            this.showToast('🔋 Энерго-таблетка подобрана! Перенесите её в гнездо питания.');
          }
        }
      } else if (item && item.state === 'carried' && socket && !socket.isOccupied) {
        const dist = Math.hypot(playerX - socket.x, playerY - socket.y);
        if (dist <= socket.interactionRadius) {
          promptMsg = '[E] Вставить таблетку в слот';
          promptX = socket.x;
          promptY = socket.y - 24;

          if (input.interactPressed) {
            this.socketPuzzle.tryInsert(playerX, playerY, socket.id);
          }
        }
      }
    }

    // Обновление плашки подсказки
    if (promptMsg) {
      this.promptContainer.visible = true;
      this.promptContainer.position.set(promptX, promptY);
      this.promptText.text = promptMsg;

      // Центрирование фона вокруг текста
      const tw = this.promptText.width;
      const th = this.promptText.height;
      this.promptText.position.set(-tw / 2, -th / 2);

      const pb = this.promptBg;
      pb.clear();
      pb.roundRect(-tw / 2 - 6, -th / 2 - 3, tw + 12, th + 6, 4);
      pb.fill({ color: 0x0f172a, alpha: 0.88 });
      pb.stroke({ width: 1, color: 0x38bdf8, alpha: 0.9 });
    } else {
      this.promptContainer.visible = false;
    }
  }
}
