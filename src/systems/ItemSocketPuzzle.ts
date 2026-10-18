import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Состояние интерактивного предмета на карте
 */
export type ItemState = 'on_ground' | 'carried' | 'inserted';

/**
 * Описание предмета/детали, которую можно подобрать и вставить
 */
export interface PuzzleItem {
  id: string;
  name: string;
  /** Координаты на карте */
  x: number;
  y: number;
  /** Радиус, в пределах которого игрок может подобрать деталь (в пикселях) */
  pickupRadius: number;
  /** Текущее состояние предмета */
  state: ItemState;
  /** ID гнезда, если деталь уже вставлена */
  insertedSocketId?: string;
}

/**
 * Описание гнезда/сокета на карте уровня
 */
export interface PuzzleSocket {
  id: string;
  name: string;
  /** Координаты гнезда на карте */
  x: number;
  y: number;
  /** Радиус, в пределах которого можно вставить предмет (в пикселях) */
  interactionRadius: number;
  /** Какой предмет (или предметы) подходят к этому гнезду */
  requiredItemIds: string[];
  /** Вставлена ли деталь */
  isOccupied: boolean;
  /** ID вставленного предмета */
  insertedItemId?: string;
}

/**
 * Конфигурация головоломки вставки детали в гнездо
 */
export interface ItemSocketPuzzleConfig {
  id?: string;
  name?: string;
  items?: PuzzleItem[];
  sockets?: PuzzleSocket[];
  /** Отправлять ли события в глобальный EventBus (по умолчанию: true) */
  emitEvents?: boolean;
  /** Коллбек при успешной вставке детали */
  onItemInserted?: (item: PuzzleItem, socket: PuzzleSocket) => void;
  /** Коллбек при полной победе (все обязательные слоты заполнены) */
  onSolved?: () => void;
}

/**
 * Подсказка о доступном взаимодействии для игрока рядом
 */
export interface InteractionPrompt {
  type: 'pickup' | 'insert' | 'drop' | null;
  targetId: string | null;
  targetName: string | null;
  distance: number;
  message: string;
}

/**
 * Логика головоломки: «Вставить деталь в нужное место на карте».
 *
 * Механика:
 * 1. На карте лежит деталь (или несколько деталей), например, энергоячейка или предохранитель.
 * 2. Робот подходит к детали и подбирает её в руки (state = 'carried').
 * 3. Деталь перемещается вместе с роботом.
 * 4. Робот подходит к целевому гнезду/слоту (socket) и активирует вставку.
 * 5. Деталь встаёт в гнездо (state = 'inserted'), слот активируется.
 * 6. Когда все требуемые слоты заполнены — фиксируется победа (isSolved = true),
 *    открывается шлюз / дверь, позволяя пройти дальше.
 */
export class ItemSocketPuzzle implements IPuzzle {
  public readonly id: string;
  public readonly name: string;

  private items: Map<string, PuzzleItem> = new Map();
  private sockets: Map<string, PuzzleSocket> = new Map();
  private carriedItemId: string | null = null;
  private isPuzzleSolved: boolean = false;
  private readonly emitEvents: boolean;

  private readonly onItemInsertedCallback?: (item: PuzzleItem, socket: PuzzleSocket) => void;
  private readonly onSolvedCallback?: () => void;

  constructor(config: ItemSocketPuzzleConfig = {}) {
    this.id = config.id ?? 'item_socket_puzzle';
    this.name = config.name ?? 'Установка компонентов питания в слоты';
    this.emitEvents = config.emitEvents ?? true;
    this.onItemInsertedCallback = config.onItemInserted;
    this.onSolvedCallback = config.onSolved;

    // Начальные дефолтные предметы и слоты (если не переданы кастомные для конкретного уровня)
    const initialItems: PuzzleItem[] = config.items ?? [
      {
        id: 'power_fuse',
        name: 'Высоковольтный предохранитель',
        x: 120,
        y: 200,
        pickupRadius: 28,
        state: 'on_ground'
      }
    ];

    const initialSockets: PuzzleSocket[] = config.sockets ?? [
      {
        id: 'door_terminal_socket',
        name: 'Гнездо распределителя шлюза',
        x: 420,
        y: 190,
        interactionRadius: 32,
        requiredItemIds: ['power_fuse'],
        isOccupied: false
      }
    ];

    this.init(initialItems, initialSockets);
  }

  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  /**
   * Несёт ли игрок сейчас какой-либо предмет в руках
   */
  public get isCarryingItem(): boolean {
    return this.carriedItemId !== null;
  }

  /**
   * ID предмета, который сейчас в руках у персонажа
   */
  public get currentCarriedItemId(): string | null {
    return this.carriedItemId;
  }

  /**
   * Инициализация элементов головоломки
   */
  public init(items: PuzzleItem[], sockets: PuzzleSocket[]): void {
    this.items.clear();
    this.sockets.clear();
    this.carriedItemId = null;
    this.isPuzzleSolved = false;

    items.forEach((item) => this.items.set(item.id, { ...item }));
    sockets.forEach((socket) => this.sockets.set(socket.id, { ...socket }));

    this.checkVictoryCondition();
  }

  /**
   * Попытка подобрать предмет игроком по координатам персонажа
   */
  public tryPickup(playerX: number, playerY: number, specificItemId?: string): boolean {
    if (this.carriedItemId !== null) {
      return false; // Руки уже заняты другим предметом
    }

    let candidateItem: PuzzleItem | null = null;
    let minDistance = Infinity;

    for (const item of this.items.values()) {
      if (item.state !== 'on_ground') continue;
      if (specificItemId && item.id !== specificItemId) continue;

      const dist = this.getDistance(playerX, playerY, item.x, item.y);
      if (dist <= item.pickupRadius && dist < minDistance) {
        minDistance = dist;
        candidateItem = item;
      }
    }

    if (!candidateItem) {
      return false;
    }

    // Подбираем предмет
    candidateItem.state = 'carried';
    candidateItem.x = playerX;
    candidateItem.y = playerY;
    this.carriedItemId = candidateItem.id;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:socket:item_picked', {
        item: { ...candidateItem },
        playerX,
        playerY
      });
    }

    return true;
  }

  /**
   * Попытка вставить удерживаемый предмет в ближайшее совместимое гнездо
   */
  public tryInsert(playerX: number, playerY: number, specificSocketId?: string): boolean {
    if (!this.carriedItemId) {
      return false; // Игрок ничего не несёт
    }

    const carriedItem = this.items.get(this.carriedItemId);
    if (!carriedItem) return false;

    let targetSocket: PuzzleSocket | null = null;
    let minDistance = Infinity;

    for (const socket of this.sockets.values()) {
      if (socket.isOccupied) continue;
      if (specificSocketId && socket.id !== specificSocketId) continue;

      const dist = this.getDistance(playerX, playerY, socket.x, socket.y);
      if (dist <= socket.interactionRadius && dist < minDistance) {
        if (socket.requiredItemIds.includes(carriedItem.id)) {
          minDistance = dist;
          targetSocket = socket;
        }
      }
    }

    if (!targetSocket) {
      return false; // Подходящее гнездо рядом не найдено
    }

    // Вставляем деталь в гнездо
    targetSocket.isOccupied = true;
    targetSocket.insertedItemId = carriedItem.id;

    carriedItem.state = 'inserted';
    carriedItem.x = targetSocket.x;
    carriedItem.y = targetSocket.y;
    carriedItem.insertedSocketId = targetSocket.id;

    this.carriedItemId = null;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:socket:inserted', {
        item: { ...carriedItem },
        socket: { ...targetSocket }
      });
    }

    this.onItemInsertedCallback?.({ ...carriedItem }, { ...targetSocket });
    this.checkVictoryCondition();

    return true;
  }

  /**
   * Бросить удерживаемый предмет на землю в указанных координатах
   */
  public dropItem(playerX: number, playerY: number): boolean {
    if (!this.carriedItemId) return false;

    const carriedItem = this.items.get(this.carriedItemId);
    if (!carriedItem) return false;

    carriedItem.state = 'on_ground';
    carriedItem.x = playerX;
    carriedItem.y = playerY;
    this.carriedItemId = null;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:socket:item_dropped', {
        item: { ...carriedItem },
        playerX,
        playerY
      });
    }

    return true;
  }

  /**
   * Универсальный метод взаимодействия по кнопке [E] / [Действие] рядом с объектом
   */
  public interact(playerX: number, playerY: number): boolean {
    if (this.isCarryingItem) {
      // Если несём предмет — сначала пробуем вставить в гнездо, если рядом гнездо
      if (this.tryInsert(playerX, playerY)) {
        return true;
      }
      // Если гнезда рядом нет — кладём на землю
      return this.dropItem(playerX, playerY);
    } else {
      // Если руки свободны — пробуем подобрать деталь с пола
      return this.tryPickup(playerX, playerY);
    }
  }

  /**
   * Обновить позицию удерживаемого предмета вслед за роботом
   */
  public updatePlayerPosition(playerX: number, playerY: number): void {
    if (this.carriedItemId) {
      const item = this.items.get(this.carriedItemId);
      if (item && item.state === 'carried') {
        item.x = playerX;
        item.y = playerY;
      }
    }
  }

  /**
   * Получить контекстную подсказку для UI (что можно сделать прямо сейчас в этой точке)
   */
  public getNearbyPrompt(playerX: number, playerY: number): InteractionPrompt {
    if (this.isCarryingItem) {
      // Проверяем, есть ли рядом гнездо
      for (const socket of this.sockets.values()) {
        if (!socket.isOccupied && socket.requiredItemIds.includes(this.carriedItemId!)) {
          const dist = this.getDistance(playerX, playerY, socket.x, socket.y);
          if (dist <= socket.interactionRadius) {
            return {
              type: 'insert',
              targetId: socket.id,
              targetName: socket.name,
              distance: dist,
              message: `Вставить деталь в ${socket.name}`
            };
          }
        }
      }
      return {
        type: 'drop',
        targetId: this.carriedItemId,
        targetName: this.items.get(this.carriedItemId!)?.name ?? null,
        distance: 0,
        message: 'Положить деталь на землю'
      };
    } else {
      // Проверяем, есть ли рядом деталь на полу
      for (const item of this.items.values()) {
        if (item.state === 'on_ground') {
          const dist = this.getDistance(playerX, playerY, item.x, item.y);
          if (dist <= item.pickupRadius) {
            return {
              type: 'pickup',
              targetId: item.id,
              targetName: item.name,
              distance: dist,
              message: `Подобрать: ${item.name}`
            };
          }
        }
      }
    }

    return {
      type: null,
      targetId: null,
      targetName: null,
      distance: Infinity,
      message: ''
    };
  }

  public getItems(): PuzzleItem[] {
    return Array.from(this.items.values()).map((item) => ({ ...item }));
  }

  public getSockets(): PuzzleSocket[] {
    return Array.from(this.sockets.values()).map((s) => ({ ...s }));
  }

  public reset(): void {
    this.carriedItemId = null;
    this.isPuzzleSolved = false;
    for (const item of this.items.values()) {
      item.state = 'on_ground';
      item.insertedSocketId = undefined;
    }
    for (const socket of this.sockets.values()) {
      socket.isOccupied = false;
      socket.insertedItemId = undefined;
    }

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:socket:reset');
    }
  }

  private checkVictoryCondition(): void {
    if (this.sockets.size === 0) return;

    // Все слоты должны быть заняты
    const allOccupied = Array.from(this.sockets.values()).every((s) => s.isOccupied);

    if (allOccupied && !this.isPuzzleSolved) {
      this.isPuzzleSolved = true;
      if (this.emitEvents) {
        EventBus.get().emit('puzzle:socket:solved', {
          sockets: this.getSockets(),
          items: this.getItems()
        });
      }
      this.onSolvedCallback?.();
    }
  }

  private getDistance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
