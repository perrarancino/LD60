import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Состояние конкретного провода на уровне
 */
export type RoomWireState = 'broken' | 'dragging' | 'connected';

/**
 * Точка контакта провода на карте
 */
export interface WirePoint {
  x: number;
  y: number;
  /** Зафиксирован ли контакт на стене/полу */
  isFixed: boolean;
}

/**
 * Описание одного провода в комнате
 */
export interface RoomWire {
  id: string;
  name: string;
  /** Цвет провода для рендера (например '#ff4444') */
  color: string;
  /** Первый конец обрыва */
  endpointA: WirePoint;
  /** Второй конец обрыва */
  endpointB: WirePoint;
  /** Текущие координаты подвижного конца (когда игрок несёт его) */
  currentDragPos?: { x: number; y: number };
  /** Текущее состояние провода */
  state: RoomWireState;
  /** Какой именно конец сейчас в руках персонажа ('A' или 'B') */
  carriedEnd: 'A' | 'B' | null;
  /** Радиус взаимодействия для взятия конца */
  grabRadius: number;
  /** Радиус защелкивания со вторым контактом */
  connectRadius: number;
  /** Максимальная длина натяжения кабеля (Infinity = без ограничений) */
  maxStretchDistance: number;
}

export interface WireRepairPuzzleConfig {
  id?: string;
  name?: string;
  wires?: RoomWire[];
  emitEvents?: boolean;
  onWireConnected?: (wire: RoomWire) => void;
  onSolved?: () => void;
}

export interface WireInteractionPrompt {
  action: 'grab' | 'connect' | 'release' | null;
  wireId: string | null;
  wireName: string | null;
  message: string;
}

/**
 * Логика пространственной головоломки: «Соединение оборванных проводов по комнате».
 *
 * Механика:
 * 1. На локации находятся оборванные провода (порванные кабели питания или шины данных).
 * 2. У каждого провода есть две точки: Endpoint A и Endpoint B.
 * 3. Главный персонаж подходит к свободному концу провода, хватает его и бежит через комнату.
 * 4. Кабель тянется за персонажем (координаты currentDragPos следуют за игроком).
 * 5. Персонаж подбегает ко второму контакту этого же кабеля и соединяет их!
 * 6. Когда все оборванные провода в комнате замкнуты:
 *    - фиксируется победа (isSolved = true);
 *    - подаётся ток, загорается освещение или открывается шлюз.
 */
export class WireRepairPuzzle implements IPuzzle {
  public readonly id: string;
  public readonly name: string;

  private wires: Map<string, RoomWire> = new Map();
  private activeDraggingWireId: string | null = null;
  private isPuzzleSolved: boolean = false;
  private readonly emitEvents: boolean;

  private readonly onWireConnectedCallback?: (wire: RoomWire) => void;
  private readonly onSolvedCallback?: () => void;

  constructor(config: WireRepairPuzzleConfig = {}) {
    this.id = config.id ?? 'room_wire_repair_puzzle';
    this.name = config.name ?? 'Restore the cable lines in the bay';
    this.emitEvents = config.emitEvents ?? true;
    this.onWireConnectedCallback = config.onWireConnected;
    this.onSolvedCallback = config.onSolved;

    // Начальные дефолтные провода комнаты (2 оборванных кабеля)
    const defaultWires: RoomWire[] = config.wires ?? [
      {
        id: 'power_cable_main',
        name: 'Main power bus (Red)',
        color: '#ff4444',
        endpointA: { x: 80, y: 180, isFixed: true },
        endpointB: { x: 340, y: 180, isFixed: true },
        state: 'broken',
        carriedEnd: null,
        grabRadius: 28,
        connectRadius: 32,
        maxStretchDistance: 450
      },
      {
        id: 'data_cable_sub',
        name: 'Sync line (Blue)',
        color: '#3399ff',
        endpointA: { x: 140, y: 260, isFixed: true },
        endpointB: { x: 420, y: 120, isFixed: true },
        state: 'broken',
        carriedEnd: null,
        grabRadius: 28,
        connectRadius: 32,
        maxStretchDistance: 500
      }
    ];

    this.init(defaultWires);
  }

  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  public get isDraggingWire(): boolean {
    return this.activeDraggingWireId !== null;
  }

  public get currentCarriedWire(): RoomWire | null {
    if (!this.activeDraggingWireId) return null;
    return this.wires.get(this.activeDraggingWireId) ?? null;
  }

  public get connectedCount(): number {
    let count = 0;
    for (const w of this.wires.values()) {
      if (w.state === 'connected') count++;
    }
    return count;
  }

  public get totalWires(): number {
    return this.wires.size;
  }

  public init(wires: RoomWire[]): void {
    this.wires.clear();
    this.activeDraggingWireId = null;
    this.isPuzzleSolved = false;

    wires.forEach((w) => {
      this.wires.set(w.id, {
        ...w,
        endpointA: { ...w.endpointA },
        endpointB: { ...w.endpointB }
      });
    });

    this.checkVictoryCondition();
  }

  /**
   * Попытка схватить свободный конец провода рядом с персонажем
   */
  public tryGrabWire(playerX: number, playerY: number, specificWireId?: string): boolean {
    if (this.isDraggingWire) return false;

    for (const wire of this.wires.values()) {
      if (wire.state !== 'broken') continue;
      if (specificWireId && wire.id !== specificWireId) continue;

      // Проверяем дистанцию до конца A
      const distA = this.getDistance(playerX, playerY, wire.endpointA.x, wire.endpointA.y);
      if (distA <= wire.grabRadius) {
        this.startDragging(wire, 'A', playerX, playerY);
        return true;
      }

      // Проверяем дистанцию до конца B
      const distB = this.getDistance(playerX, playerY, wire.endpointB.x, wire.endpointB.y);
      if (distB <= wire.grabRadius) {
        this.startDragging(wire, 'B', playerX, playerY);
        return true;
      }
    }

    return false;
  }

  /**
   * Обновление координат натягиваемого кабеля вслед за бегущим персонажем
   */
  public update(playerX: number, playerY: number): void {
    if (!this.activeDraggingWireId) return;

    const wire = this.wires.get(this.activeDraggingWireId);
    if (!wire || wire.state !== 'dragging') return;

    // Проверяем ограничение натяжения кабеля
    const fixedOrigin = wire.carriedEnd === 'A' ? wire.endpointB : wire.endpointA;
    const currentDist = this.getDistance(playerX, playerY, fixedOrigin.x, fixedOrigin.y);

    if (currentDist > wire.maxStretchDistance) {
      // Кабель натянулся до предела и выскальзывает из манипулятора
      this.releaseWire(playerX, playerY);
      return;
    }

    wire.currentDragPos = { x: playerX, y: playerY };
  }

  /**
   * Попытка замкнуть переносимый провод с его ответным контактом
   */
  public tryConnect(playerX: number, playerY: number): boolean {
    if (!this.activeDraggingWireId) return false;

    const wire = this.wires.get(this.activeDraggingWireId);
    if (!wire || wire.state !== 'dragging') return false;

    // Ответный конец, к которому нужно добежать
    const targetEnd = wire.carriedEnd === 'A' ? wire.endpointB : wire.endpointA;
    const dist = this.getDistance(playerX, playerY, targetEnd.x, targetEnd.y);

    if (dist <= wire.connectRadius) {
      // Соединение успешно замкнуто!
      wire.state = 'connected';
      wire.carriedEnd = null;
      wire.currentDragPos = undefined;
      this.activeDraggingWireId = null;

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:wire_repair:connected', {
          wire: { ...wire },
          connectedCount: this.connectedCount,
          totalWires: this.totalWires
        });
      }

      this.onWireConnectedCallback?.({ ...wire });
      this.checkVictoryCondition();
      return true;
    }

    return false;
  }

  /**
   * Отпустить конец провода (он падает на пол в текущей позиции или отпружинивает)
   */
  public releaseWire(playerX: number, playerY: number): void {
    if (!this.activeDraggingWireId) return;

    const wire = this.wires.get(this.activeDraggingWireId);
    if (!wire) return;

    wire.state = 'broken';
    const carriedEnd = wire.carriedEnd;
    wire.carriedEnd = null;
    wire.currentDragPos = undefined;
    this.activeDraggingWireId = null;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:wire_repair:released', {
        wire: { ...wire },
        releasedEnd: carriedEnd,
        playerX,
        playerY
      });
    }
  }

  /**
   * Универсальное действие по кнопке [E] / [Действие] рядом с кабелем
   */
  public interact(playerX: number, playerY: number): boolean {
    if (this.isDraggingWire) {
      // Если держим провод в руках — пробуем соединить со второй точкой
      if (this.tryConnect(playerX, playerY)) {
        return true;
      }
      // Если рядом нет точки соединения — бросаем провод
      this.releaseWire(playerX, playerY);
      return true;
    } else {
      // Если руки свободны — хватаем ближайший свободный конец
      return this.tryGrabWire(playerX, playerY);
    }
  }

  /**
   * Подсказка для интерфейса игрока
   */
  public getNearbyPrompt(playerX: number, playerY: number): WireInteractionPrompt {
    if (this.isDraggingWire) {
      const wire = this.wires.get(this.activeDraggingWireId!)!;
      const targetEnd = wire.carriedEnd === 'A' ? wire.endpointB : wire.endpointA;
      const dist = this.getDistance(playerX, playerY, targetEnd.x, targetEnd.y);

      if (dist <= wire.connectRadius) {
        return {
          action: 'connect',
          wireId: wire.id,
          wireName: wire.name,
          message: `Connect: ${wire.name} [E]`
        };
      } else {
        return {
          action: 'release',
          wireId: wire.id,
          wireName: wire.name,
          message: 'Drop the wire [E]'
        };
      }
    } else {
      for (const wire of this.wires.values()) {
        if (wire.state !== 'broken') continue;
        const distA = this.getDistance(playerX, playerY, wire.endpointA.x, wire.endpointA.y);
        const distB = this.getDistance(playerX, playerY, wire.endpointB.x, wire.endpointB.y);

        if (distA <= wire.grabRadius || distB <= wire.grabRadius) {
          return {
            action: 'grab',
            wireId: wire.id,
            wireName: wire.name,
            message: `Take the cable end: ${wire.name} [E]`
          };
        }
      }
    }

    return {
      action: null,
      wireId: null,
      wireName: null,
      message: ''
    };
  }

  public getWires(): RoomWire[] {
    return Array.from(this.wires.values()).map((w) => ({
      ...w,
      endpointA: { ...w.endpointA },
      endpointB: { ...w.endpointB }
    }));
  }

  public reset(): void {
    this.activeDraggingWireId = null;
    this.isPuzzleSolved = false;
    for (const wire of this.wires.values()) {
      wire.state = 'broken';
      wire.carriedEnd = null;
      wire.currentDragPos = undefined;
    }

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:wire_repair:reset');
    }
  }

  private startDragging(wire: RoomWire, end: 'A' | 'B', playerX: number, playerY: number): void {
    wire.state = 'dragging';
    wire.carriedEnd = end;
    wire.currentDragPos = { x: playerX, y: playerY };
    this.activeDraggingWireId = wire.id;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:wire_repair:grabbed', {
        wire: { ...wire },
        grabbedEnd: end,
        playerX,
        playerY
      });
    }
  }

  private checkVictoryCondition(): void {
    if (this.wires.size === 0) return;

    const allConnected = Array.from(this.wires.values()).every((w) => w.state === 'connected');

    if (allConnected && !this.isPuzzleSolved) {
      this.isPuzzleSolved = true;
      if (this.emitEvents) {
        EventBus.get().emit('puzzle:wire_repair:solved', {
          wires: this.getWires()
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
