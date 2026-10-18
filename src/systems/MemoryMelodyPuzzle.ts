import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Описание одного цвета/ноты мелодии
 */
export interface MemoryColorDef {
  id: number;
  name: string;
  hex: string;
  /** Рекомендуемая частота звука гудка в Гц */
  frequencyHz: number;
}

/**
 * Конфигурация головоломки на запоминание мелодии
 */
export interface MemoryMelodyConfig {
  id?: string;
  name?: string;
  /** Список цветов/нот (по умолчанию 5 штук) */
  colors?: MemoryColorDef[];
  /** Длины цепочек гудков по раундам (по умолчанию: [4, 6, 8]) */
  roundLengths?: number[];
  /** Отправлять ли события в глобальный EventBus (по умолчанию: true) */
  emitEvents?: boolean;
  /** Коллбек при верном нажатии отдельной ноты */
  onNotePressed?: (colorId: number, isCorrect: boolean) => void;
  /** Коллбек при успешном завершении раунда */
  onRoundSuccess?: (round: number, totalRounds: number) => void;
  /** Коллбек при ошибке ввода */
  onFail?: (expectedColor: number, pressedColor: number) => void;
  /** Коллбек при полной победе (пройдены все 3 раунда) */
  onSolved?: () => void;
}

/**
 * Результат нажатия на цветную кнопку/ноту
 */
export interface MemoryPressResult {
  /** Было ли нажатие верным */
  isCorrect: boolean;
  /** Какая нота ожидалась */
  expectedColor: number;
  /** Какая нота была нажата */
  pressedColor: number;
  /** Завершен ли текущий раунд */
  roundCompleted: boolean;
  /** Завершена ли вся головоломка (победа) */
  puzzleCompleted: boolean;
  /** Текущий прогресс ввода в раунде (например, 3 из 4) */
  currentStep: number;
  /** Общее количество нот в текущем раунде */
  roundLength: number;
}

/**
 * Снимок состояния головоломки
 */
export interface MemoryMelodyState {
  currentRound: number;
  totalRounds: number;
  roundLengths: number[];
  /** Полная последовательность цветов в текущем раунде (длина 4, 6 или 8) */
  currentSequence: number[];
  /** Последовательность, уже введенная игроком в текущей попытке */
  playerInput: number[];
  /** Решена ли вся головоломка целиком */
  isSolved: boolean;
  /** Список доступных цветов */
  colors: MemoryColorDef[];
}

/**
 * Логика головоломки на запоминание мелодии (Simon Says).
 *
 * Механика:
 * 1. В игре есть 5 цветов/нот: Красный, Синий, Жёлтый, Зелёный, Фиолетовый.
 * 2. Всего 3 раунда с возрастающей длиной мелодии:
 *    - 1-й раунд: 4 гудка;
 *    - 2-й раунд: 6 гудков;
 *    - 3-й раунд: 8 гудков.
 * 3. Система генерирует случайную последовательность цветов/гудков и проигрывает её.
 * 4. Игрок должен воспроизвести цепочку, нажимая те же 5 цветов в правильном порядке.
 * 5. При ошибке: фиксируется промах, сбрасывается ввод текущей попытки и можно
 *    повторить демонстрацию цепочки текущего раунда.
 * 6. После успешного повторения 8 гудков в 3-м раунде — полная победа (isSolved = true).
 */
export class MemoryMelodyPuzzle implements IPuzzle {
  public readonly id: string;
  public readonly name: string;

  public static readonly DEFAULT_COLORS: MemoryColorDef[] = [
    { id: 0, name: 'Красный', hex: '#ff4d4f', frequencyHz: 261.63 }, // Нота C4
    { id: 1, name: 'Синий', hex: '#1890ff', frequencyHz: 329.63 },   // Нота E4
    { id: 2, name: 'Жёлтый', hex: '#ffc53d', frequencyHz: 392.0 },   // Нота G4
    { id: 3, name: 'Зелёный', hex: '#52c41a', frequencyHz: 440.0 },  // Нота A4
    { id: 4, name: 'Фиолетовый', hex: '#9254de', frequencyHz: 523.25 } // Нота C5
  ];

  public static readonly DEFAULT_ROUND_LENGTHS = [4, 6, 8];

  private readonly colors: MemoryColorDef[];
  private readonly roundLengths: number[];
  private readonly emitEvents: boolean;

  private currentRoundIndex: number = 0; // 0, 1, 2
  private currentSequence: number[] = [];
  private playerInput: number[] = [];
  private isPuzzleSolved: boolean = false;

  private readonly onNotePressedCallback?: (colorId: number, isCorrect: boolean) => void;
  private readonly onRoundSuccessCallback?: (round: number, totalRounds: number) => void;
  private readonly onFailCallback?: (expectedColor: number, pressedColor: number) => void;
  private readonly onSolvedCallback?: () => void;

  constructor(config: MemoryMelodyConfig = {}) {
    this.id = config.id ?? 'memory_melody_puzzle';
    this.name = config.name ?? 'Светозвуковая калибровка (5 цветов, 3 раунда: 4, 6, 8 гудков)';
    this.colors = config.colors ?? MemoryMelodyPuzzle.DEFAULT_COLORS;
    this.roundLengths = config.roundLengths ?? MemoryMelodyPuzzle.DEFAULT_ROUND_LENGTHS;
    this.emitEvents = config.emitEvents ?? true;

    this.onNotePressedCallback = config.onNotePressed;
    this.onRoundSuccessCallback = config.onRoundSuccess;
    this.onFailCallback = config.onFail;
    this.onSolvedCallback = config.onSolved;

    this.startNewGame();
  }

  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  public get currentRound(): number {
    return this.currentRoundIndex + 1; // 1-indexed (1, 2, 3)
  }

  public get totalRounds(): number {
    return this.roundLengths.length;
  }

  public get availableColors(): MemoryColorDef[] {
    return [...this.colors];
  }

  /**
   * Начать новую игру с 1-го раунда
   */
  public startNewGame(): void {
    this.currentRoundIndex = 0;
    this.isPuzzleSolved = false;
    this.prepareRound();

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:memory:reset', this.getState());
    }
  }

  /**
   * Подготовка случайной последовательности для текущего раунда
   */
  public prepareRound(targetRoundIndex: number = this.currentRoundIndex): number[] {
    this.currentRoundIndex = Math.max(0, Math.min(this.totalRounds - 1, targetRoundIndex));
    this.playerInput = [];

    const length = this.roundLengths[this.currentRoundIndex];
    this.currentSequence = [];

    // Генерируем случайную мелодию из 5 доступных цветов
    // Исключаем монотонное повторение одного цвета более 2 раз подряд
    let lastColor = -1;
    let repeatCount = 0;

    for (let i = 0; i < length; i++) {
      let candidate: number;
      let attempts = 0;
      do {
        candidate = Math.floor(Math.random() * this.colors.length);
        attempts++;
      } while (candidate === lastColor && repeatCount >= 2 && attempts < 10);

      if (candidate === lastColor) {
        repeatCount++;
      } else {
        lastColor = candidate;
        repeatCount = 1;
      }

      this.currentSequence.push(candidate);
    }

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:memory:demonstrate', {
        round: this.currentRound,
        sequence: [...this.currentSequence],
        state: this.getState()
      });
    }

    return [...this.currentSequence];
  }

  /**
   * Получить текущую последовательность гудков (для визуализатора/звука)
   */
  public getCurrentSequence(): number[] {
    return [...this.currentSequence];
  }

  /**
   * Нажатие игроком на цветную кнопку/ноту
   */
  public pressColor(colorId: number): MemoryPressResult {
    if (this.isPuzzleSolved) {
      return {
        isCorrect: true,
        expectedColor: colorId,
        pressedColor: colorId,
        roundCompleted: true,
        puzzleCompleted: true,
        currentStep: this.currentSequence.length,
        roundLength: this.currentSequence.length
      };
    }

    const stepIndex = this.playerInput.length;
    const expectedColor = this.currentSequence[stepIndex];
    const isCorrect = colorId === expectedColor;

    this.onNotePressedCallback?.(colorId, isCorrect);

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:memory:note_pressed', {
        colorId,
        isCorrect,
        expectedColor,
        step: stepIndex + 1,
        roundLength: this.currentSequence.length
      });
    }

    if (!isCorrect) {
      // Ошибка: сбрасываем текущий ввод в раунде
      this.playerInput = [];

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:memory:fail', {
          round: this.currentRound,
          expectedColor,
          pressedColor: colorId,
          sequence: [...this.currentSequence]
        });
      }

      this.onFailCallback?.(expectedColor, colorId);

      return {
        isCorrect: false,
        expectedColor,
        pressedColor: colorId,
        roundCompleted: false,
        puzzleCompleted: false,
        currentStep: 0,
        roundLength: this.currentSequence.length
      };
    }

    // Правильное нажатие
    this.playerInput.push(colorId);

    // Проверяем, завершен ли текущий раунд
    if (this.playerInput.length === this.currentSequence.length) {
      const finishedRound = this.currentRound;
      const isFinalRound = this.currentRoundIndex >= this.totalRounds - 1;

      if (isFinalRound) {
        // Завершен 3-й раунд (8 гудков) — победа!
        this.isPuzzleSolved = true;

        if (this.emitEvents) {
          EventBus.get().emit('puzzle:memory:solved', this.getState());
        }

        this.onSolvedCallback?.();

        return {
          isCorrect: true,
          expectedColor,
          pressedColor: colorId,
          roundCompleted: true,
          puzzleCompleted: true,
          currentStep: this.currentSequence.length,
          roundLength: this.currentSequence.length
        };
      } else {
        // Переходим к следующему раунду
        this.onRoundSuccessCallback?.(finishedRound, this.totalRounds);

        if (this.emitEvents) {
          EventBus.get().emit('puzzle:memory:round_success', {
            completedRound: finishedRound,
            nextRound: finishedRound + 1,
            totalRounds: this.totalRounds
          });
        }

        this.currentRoundIndex++;
        this.prepareRound();

        return {
          isCorrect: true,
          expectedColor,
          pressedColor: colorId,
          roundCompleted: true,
          puzzleCompleted: false,
          currentStep: this.playerInput.length,
          roundLength: this.roundLengths[this.currentRoundIndex - 1]
        };
      }
    }

    return {
      isCorrect: true,
      expectedColor,
      pressedColor: colorId,
      roundCompleted: false,
      puzzleCompleted: false,
      currentStep: this.playerInput.length,
      roundLength: this.currentSequence.length
    };
  }

  /**
   * Сбросить текущую попытку ввода игрока (чтобы повторить показ цепочки)
   */
  public retryCurrentRound(): void {
    this.playerInput = [];
    if (this.emitEvents) {
      EventBus.get().emit('puzzle:memory:demonstrate', {
        round: this.currentRound,
        sequence: [...this.currentSequence],
        state: this.getState()
      });
    }
  }

  /**
   * Полный сброс головоломки
   */
  public reset(): void {
    this.startNewGame();
  }

  /**
   * Получить снимок состояния
   */
  public getState(): MemoryMelodyState {
    return {
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      roundLengths: [...this.roundLengths],
      currentSequence: [...this.currentSequence],
      playerInput: [...this.playerInput],
      isSolved: this.isPuzzleSolved,
      colors: this.availableColors
    };
  }
}
