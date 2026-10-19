import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Идентификаторы спрайтов и путей для батареи и стойки питания
 */
export const BATTERY_ITEM_ID = 'item_battery';
export const BATTERY_STAND_SOCKET_ID = 'deco_batterystand';
export const BATTERY_SPRITE_ID = 'item_battery';
export const BATTERY_IMAGE_PATH = 'items/battery.png';
export const BATTERY_STAND_SPRITE_ID = 'deco_batterystand';
export const BATTERY_STAND_IMAGE_PATH = 'decor/batterystand.png';

/**
 * Состояние интерактивного предмета на карте
 */
export type ItemState = 'on_ground' | 'carried' | 'inserted';

/**
 * Описание предмета/детали, которую можно подобрать и нести в руках
 */
export interface PuzzleItem {
  id: string;
  name: string;
  /** Идентификатор спрайта из data/sprites/sprites.json (например, item_battery) */
  spriteId?: string;
  /** Относительный путь к изображению в assets/sprites (например, items/battery.png) */
  image?: string;
  /** Координаты на карте */
  x: number;
  y: number;
  /** Радиус, в пределах которого игрок может подобрать деталь (в пикселях) */
  pickupRadius: number;
  /** Текущее состояние предмета */
  state: ItemState;
  /** ID гнезда, если деталь уже вставлена */
  insertedSocketId?: string;
  /** Смещение относительно координат игрока при переноске в руках */
  carryOffset?: { x: number; y: number };
}

/**
 * Описание гнезда/стойки на карте уровня
 */
export interface PuzzleSocket {
  id: string;
  name: string;
  /** Идентификатор спрайта стойки из data/sprites/sprites.json (например, deco_batterystand) */
  spriteId?: string;
  /** Относительный путь к изображению в assets/sprites (например, decor/batterystand.png) */
  image?: string;
  /** Координаты стойки/гнезда на карте */
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
  /** Смещение точки фиксации детали на стойке (например, батарея садится в верхнюю часть стойки) */
  insertOffset?: { x: number; y: number };
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
 * Логика головоломки: «Подбор батареи (items/battery.png) и установка в стойку (decor/batterystand.png)».
 *
 * Механика:
 * 1. На карте размещается батарея питания (sprite: item_battery) и стойка (sprite: deco_batterystand).
 * 2. Робот подходит к батарее и подбирает её в руки (state = 'carried').
 * 3. Батарея перемещается вместе с роботом со смещением в руках (carryOffset).
 * 4. Робот подходит к стойке аккумулятора и активирует установку (E).
 * 5. Батарея встаёт в посадочное место стойки (state = 'inserted', позиционируется по insertOffset), стойка активируется.
 * 6. Когда батарея установлена на стойку — фиксируется победа (isSolved = true),
 *    эмитится событие 'puzzle:socket:solved' и срабатывает коллбек onSolved.
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
    this.name = config.name ?? 'Установка аккумулятора питания в стойку';
    this.emitEvents = config.emitEvents ?? true;
    this.onItemInsertedCallback = config.onItemInserted;
    this.onSolvedCallback = config.onSolved;

    // По умолчанию настраиваем скрипт на связку battery.png -> batterystand.png
    const initialItems: PuzzleItem[] = config.items ?? [
      ItemSocketPuzzle.createBattery(0, 0)
    ];

    const initialSockets: PuzzleSocket[] = config.sockets ?? [
      ItemSocketPuzzle.createBatteryStand(0, 0)
    ];

    this.init(initialItems, initialSockets);
  }

  /**
   * Фабричный метод создания объекта батареи (items/battery.png)
   */
  public static createBattery(x: number, y: number, id: string = BATTERY_ITEM_ID): PuzzleItem {
    return {
      id,
      name: 'Батарея питания',
      spriteId: BATTERY_SPRITE_ID,
      image: BATTERY_IMAGE_PATH,
      x,
      y,
      pickupRadius: 28,
      state: 'on_ground',
      carryOffset: { x: 8, y: -22 }
    };
  }

  /**
   * Фабричный метод создания объекта стойки аккумулятора (decor/batterystand.png)
   */
  public static createBatteryStand(x: number, y: number, id: string = BATTERY_STAND_SOCKET_ID): PuzzleSocket {
    return {
      id,
      name: 'Стойка аккумулятора',
      spriteId: BATTERY_STAND_SPRITE_ID,
      image: BATTERY_STAND_IMAGE_PATH,
      x,
      y,
      interactionRadius: 36,
      requiredItemIds: [BATTERY_ITEM_ID, 'battery'],
      isOccupied: false,
      insertOffset: { x: 0, y: -24 }
    };
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
   * Несёт ли игрок в данный момент батарею питания
   */
  public get isCarryingBattery(): boolean {
    return this.carriedItemId === BATTERY_ITEM_ID || this.carriedItemId === 'battery';
  }

  /**
   * ID предмета, который сейчас в руках у персонажа
   */
  public get currentCarriedItemId(): string | null {
    return this.carriedItemId;
  }

  /**
   * Получить объект батареи из списка предметов
   */
  public getBattery(): PuzzleItem | undefined {
    return this.items.get(BATTERY_ITEM_ID) ?? Array.from(this.items.values()).find((it) => it.spriteId === BATTERY_SPRITE_ID);
  }

  /**
   * Получить объект стойки из списка сокетов
   */
  public getBatteryStand(): PuzzleSocket | undefined {
    return this.sockets.get(BATTERY_STAND_SOCKET_ID) ?? Array.from(this.sockets.values()).find((sk) => sk.spriteId === BATTERY_STAND_SPRITE_ID);
  }

  /**
   * Установлена ли батарея на стойку аккумулятора
   */
  public isBatteryInstalled(): boolean {
    const stand = this.getBatteryStand();
    return stand ? stand.isOccupied : false;
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

    // Подбираем предмет в руки
    candidateItem.state = 'carried';
    const offsetX = candidateItem.carryOffset?.x ?? 8;
    const offsetY = candidateItem.carryOffset?.y ?? -22;
    candidateItem.x = playerX + offsetX;
    candidateItem.y = playerY + offsetY;
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
   * Попытка вставить удерживаемый предмет в ближайшее совместимое гнездо/стойку
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
        if (socket.requiredItemIds.includes(carriedItem.id) ||
            (socket.spriteId === BATTERY_STAND_SPRITE_ID && carriedItem.spriteId === BATTERY_SPRITE_ID)) {
          minDistance = dist;
          targetSocket = socket;
        }
      }
    }

    if (!targetSocket) {
      return false; // Подходящее гнездо рядом не найдено
    }

    // Вставляем деталь в посадочное место стойки
    targetSocket.isOccupied = true;
    targetSocket.insertedItemId = carriedItem.id;

    const offset = targetSocket.insertOffset ?? { x: 0, y: -24 };
    carriedItem.state = 'inserted';
    carriedItem.x = targetSocket.x + offset.x;
    carriedItem.y = targetSocket.y + offset.y;
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
      // Если несём предмет — сначала пробуем вставить в стойку, если рядом
      if (this.tryInsert(playerX, playerY)) {
        return true;
      }
      // Если стойки рядом нет — кладём на землю
      return this.dropItem(playerX, playerY);
    } else {
      // Если руки свободны — пробуем подобрать деталь с пола
      return this.tryPickup(playerX, playerY);
    }
  }

  /**
   * Обновить позицию удерживаемого предмета вслед за роботом с учётом направления взгляда
   * @param playerX координата X робота
   * @param playerY координата Y робота (уровень ног)
   * @param facingDir направление взгляда робота (1 — вправо, -1 — влево)
   */
  public updatePlayerPosition(playerX: number, playerY: number, facingDir: number = 1): void {
    if (this.carriedItemId) {
      const item = this.items.get(this.carriedItemId);
      if (item && item.state === 'carried') {
        const offsetX = (item.carryOffset?.x ?? 8) * (facingDir >= 0 ? 1 : -1);
        const offsetY = item.carryOffset?.y ?? -22;
        item.x = playerX + offsetX;
        item.y = playerY + offsetY;
      }
    }
  }

  /**
   * Получить контекстную подсказку для UI (что можно сделать прямо сейчас в этой точке)
   */
  public getNearbyPrompt(playerX: number, playerY: number): InteractionPrompt {
    if (this.isCarryingItem) {
      const carriedItem = this.items.get(this.carriedItemId!);
      // Проверяем, есть ли рядом совместимая стойка
      for (const socket of this.sockets.values()) {
        const isCompatible = carriedItem &&
          (socket.requiredItemIds.includes(carriedItem.id) ||
           (socket.spriteId === BATTERY_STAND_SPRITE_ID && carriedItem.spriteId === BATTERY_SPRITE_ID));

        if (!socket.isOccupied && isCompatible) {
          const dist = this.getDistance(playerX, playerY, socket.x, socket.y);
          if (dist <= socket.interactionRadius) {
            return {
              type: 'insert',
              targetId: socket.id,
              targetName: socket.name,
              distance: dist,
              message: `Установить ${carriedItem?.name ?? 'деталь'} в ${socket.name} (E)`
            };
          }
        }
      }
      return {
        type: 'drop',
        targetId: this.carriedItemId,
        targetName: carriedItem?.name ?? null,
        distance: 0,
        message: `Положить ${carriedItem?.name ?? 'деталь'} на землю (E)`
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
              message: `Подобрать: ${item.name} (E)`
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
