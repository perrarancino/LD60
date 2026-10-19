import {
  BinaryPuzzle,
  type BinaryPuzzleConfig,
  type BinaryPuzzleState,
  type PuzzleSubmitResult
} from './BinaryPuzzle.ts';

import {
  SteamEnginePuzzle,
  type SteamEngineConfig,
  type SteamEnginePuzzleState,
  type SteamGaugeState,
  type SteamLeverState,
  type SteamGaugeConfig
} from './SteamEnginePuzzle.ts';

import {
  ItemSocketPuzzle,
  BATTERY_ITEM_ID,
  BATTERY_STAND_SOCKET_ID,
  BATTERY_SPRITE_ID,
  BATTERY_IMAGE_PATH,
  BATTERY_STAND_SPRITE_ID,
  BATTERY_STAND_IMAGE_PATH,
  type ItemSocketPuzzleConfig,
  type PuzzleItem,
  type PuzzleSocket,
  type ItemState,
  type InteractionPrompt
} from './ItemSocketPuzzle.ts';

import {
  WireRepairPuzzle,
  type WireRepairPuzzleConfig,
  type RoomWire,
  type RoomWireState,
  type WirePoint,
  type WireInteractionPrompt
} from './WireRepairPuzzle.ts';

import {
  MemoryMelodyPuzzle,
  type MemoryMelodyConfig,
  type MemoryColorDef,
  type MemoryMelodyState,
  type MemoryPressResult
} from './MemoryMelodyPuzzle.ts';

import {
  CipherTerminalPuzzle,
  type CipherClue,
  type CipherTerminalConfig,
  type CipherPuzzleState,
  type CipherSubmitResult,
  type CipherTerminalLocation
} from './CipherTerminalPuzzle.ts';

// Реэкспорт всех конкретных головоломок и их типов для удобства импорта
export {
  BinaryPuzzle,
  type BinaryPuzzleConfig,
  type BinaryPuzzleState,
  type PuzzleSubmitResult,
  SteamEnginePuzzle,
  type SteamEngineConfig,
  type SteamEnginePuzzleState,
  type SteamGaugeState,
  type SteamLeverState,
  type SteamGaugeConfig,
  ItemSocketPuzzle,
  BATTERY_ITEM_ID,
  BATTERY_STAND_SOCKET_ID,
  BATTERY_SPRITE_ID,
  BATTERY_IMAGE_PATH,
  BATTERY_STAND_SPRITE_ID,
  BATTERY_STAND_IMAGE_PATH,
  type ItemSocketPuzzleConfig,
  type PuzzleItem,
  type PuzzleSocket,
  type ItemState,
  type InteractionPrompt,
  WireRepairPuzzle,
  type WireRepairPuzzleConfig,
  type RoomWire,
  type RoomWireState,
  type WirePoint,
  type WireInteractionPrompt,
  MemoryMelodyPuzzle,
  type MemoryMelodyConfig,
  type MemoryColorDef,
  type MemoryMelodyState,
  type MemoryPressResult,
  CipherTerminalPuzzle,
  type CipherClue,
  type CipherTerminalConfig,
  type CipherPuzzleState,
  type CipherSubmitResult,
  type CipherTerminalLocation
};

/**
 * Базовый контракт для всех головоломок игры
 */
export interface IPuzzle {
  readonly id: string;
  readonly name: string;
  readonly isSolved: boolean;
  reset(): void;
}

/**
 * Централизованная подсистема (реестр и менеджер) головоломок игры.
 *
 * Предоставляет доступ ко всем головоломкам в проекте:
 * - binaryPuzzle: перевод десятичных в двоичные (0..31, 5 бит, 5 ламп);
 * - steamEnginePuzzle: настройка парового двигателя (3 рычага и 3 манометра/спидометра);
 * - itemSocketPuzzle: подбор батареи (items/battery.png) и установка в стойку аккумулятора (decor/batterystand.png);
 * - wireRepairPuzzle: соединение оборванных проводов персонажем по всей комнате;
 * - memoryMelodyPuzzle: запоминание мелодии (5 цветов, 3 раунда: 4, 6, 8 гудков);
 * - cipherTerminalPuzzle: настенный шифр по локации и терминал ввода в секретной комнате.
 */
export class PuzzleSystem {
  private static instance: PuzzleSystem;
  private puzzles: Map<string, IPuzzle> = new Map();

  /** Экземпляр бинарной головоломки */
  public readonly binaryPuzzle: BinaryPuzzle;

  /** Экземпляр головоломки настройки парового двигателя */
  public readonly steamEnginePuzzle: SteamEnginePuzzle;

  /** Экземпляр головоломки переноса батареи и установки в стойку питания */
  public readonly itemSocketPuzzle: ItemSocketPuzzle;

  /** Экземпляр головоломки соединения оборванных проводов в комнате */
  public readonly wireRepairPuzzle: WireRepairPuzzle;

  /** Экземпляр головоломки на запоминание мелодии (5 цветов, 3 раунда: 4, 6, 8 гудков) */
  public readonly memoryMelodyPuzzle: MemoryMelodyPuzzle;

  /** Экземпляр исследовательской головоломки со сбором настенного шифра и терминалом ввода */
  public readonly cipherTerminalPuzzle: CipherTerminalPuzzle;

  private constructor() {
    this.binaryPuzzle = new BinaryPuzzle({
      minNumber: 0,
      maxNumber: 31,
      bitsCount: 5,
      requiredStreak: 5,
      avoidConsecutiveRepeats: true,
      emitEvents: true
    });

    this.steamEnginePuzzle = new SteamEnginePuzzle({
      minLeverPos: -5,
      maxLeverPos: 5,
      greenTolerance: 4,
      emitEvents: true
    });

    this.itemSocketPuzzle = new ItemSocketPuzzle({
      emitEvents: true
    });

    this.wireRepairPuzzle = new WireRepairPuzzle({
      emitEvents: true
    });

    this.memoryMelodyPuzzle = new MemoryMelodyPuzzle({
      emitEvents: true
    });

    this.cipherTerminalPuzzle = new CipherTerminalPuzzle({
      emitEvents: true
    });

    this.registerPuzzle(this.binaryPuzzle);
    this.registerPuzzle(this.steamEnginePuzzle);
    this.registerPuzzle(this.itemSocketPuzzle);
    this.registerPuzzle(this.wireRepairPuzzle);
    this.registerPuzzle(this.memoryMelodyPuzzle);
    this.registerPuzzle(this.cipherTerminalPuzzle);
  }

  public static get(): PuzzleSystem {
    if (!PuzzleSystem.instance) {
      PuzzleSystem.instance = new PuzzleSystem();
    }
    return PuzzleSystem.instance;
  }

  /**
   * Зарегистрировать любую головоломку в реестре
   */
  public registerPuzzle(puzzle: IPuzzle): void {
    this.puzzles.set(puzzle.id, puzzle);
  }

  /**
   * Получить головоломку по её ID
   */
  public getPuzzle<T extends IPuzzle = IPuzzle>(id: string): T | undefined {
    return this.puzzles.get(id) as T | undefined;
  }

  /**
   * Сбросить прогресс всех зарегистрированных головоломок
   */
  public resetAll(): void {
    this.puzzles.forEach((p) => p.reset());
  }
}
