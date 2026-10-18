import { EventBus } from '../core/EventBus.ts';

/**
 * Базовый интерфейс для всех типов головоломок в игре
 */
export interface IPuzzle {
  readonly id: string;
  readonly name: string;
  readonly isSolved: boolean;
  reset(): void;
}

/**
 * Конфигурация бинарной головоломки
 */
export interface BinaryPuzzleConfig {
  /** Минимальное десятичное число (по умолчанию: 0) */
  minNumber?: number;
  /** Максимальное десятичное число (по умолчанию: 31, что соответствует 5 битам) */
  maxNumber?: number;
  /** Количество бит (по умолчанию: 5) */
  bitsCount?: number;
  /** Количество правильных ответов подряд для победы (по умолчанию: 5) */
  requiredStreak?: number;
  /** Исключать повторение одного и того же числа подряд (по умолчанию: true) */
  avoidConsecutiveRepeats?: boolean;
  /** Отправлять ли события в глобальный EventBus (по умолчанию: true) */
  emitEvents?: boolean;
  /** Коллбек при правильном ответе в раунде */
  onSuccess?: (state: BinaryPuzzleState) => void;
  /** Коллбек при ошибке (сбросе серии) */
  onFail?: (errorInfo: { expected: number; submitted: number; state: BinaryPuzzleState }) => void;
  /** Коллбек при полной победе в головоломке */
  onSolved?: (state: BinaryPuzzleState) => void;
  /** Коллбек при любом изменении состояния (ввод бита, новый раунд и т.д.) */
  onStateChange?: (state: BinaryPuzzleState) => void;
}

/**
 * Снимок текущего состояния бинарной головоломки
 */
export interface BinaryPuzzleState {
  /** Текущее загаданное десятичное число на экране (0..31) */
  targetNumber: number;
  /** Двоичное представление текущего числа (строка фиксированной длины, напр. '00101' или '11111') */
  targetBinaryString: string;
  /** Текущая серия правильных ответов подряд (0..requiredStreak) */
  currentStreak: number;
  /** Требуемое количество побед подряд (по умолчанию: 5) */
  requiredStreak: number;
  /**
   * Состояние зеленых лампочек-индикаторов.
   * Массив длины requiredStreak (по умолчанию 5).
   * true = лампочка горит зелёным, false = не горит.
   */
  lights: boolean[];
  /** Количество горящих зеленых лампочек (равно currentStreak) */
  greenLightsCount: number;
  /** Решена ли головоломка полностью (5 из 5 угадано) */
  isSolved: boolean;
  /**
   * Текущее состояние тумблеров/переключателей бит (слева направо: MSB -> LSB).
   * Для 5 бит: [16, 8, 4, 2, 1].
   */
  inputBits: boolean[];
  /** Текущее десятичное значение, соответствующее включенным тумблерам inputBits */
  currentInputValue: number;
  /** Текущая введенная бинарная строка (напр. '01010') */
  currentInputBinaryString: string;
  /** Общее число попыток за текущую сессию */
  totalAttempts: number;
  /** Количество допущенных ошибок (сбросов) */
  failedAttempts: number;
  /** Результат последней проверки: 'correct', 'wrong' или null (если раунд только начался) */
  lastResult: 'correct' | 'wrong' | null;
}

/**
 * Результат проверки ответа
 */
export interface PuzzleSubmitResult {
  /** Верен ли ответ */
  isCorrect: boolean;
  /** Загаданное десятичное число */
  targetNumber: number;
  /** Введенное пользователем число */
  submittedValue: number;
  /** Загаданная двоичная строка (5 бит) */
  expectedBinaryString: string;
  /** Введенная двоичная строка */
  submittedBinaryString: string;
  /** Новая серия правильных ответов */
  newStreak: number;
  /** Решена ли вся головоломка целиком */
  isSolved: boolean;
  /** Сообщение для логов или подсказок */
  message: string;
}

/**
 * Логика головоломки «Перевод десятичных чисел в двоичные».
 *
 * Правила:
 * 1. На экране отображается случайное десятичное число от 0 до 31 (5 бит).
 * 2. Игрок вводит двоичный эквивалент (тумблерами 16, 8, 4, 2, 1 или строкой/значением).
 * 3. При верном ответе загорается очередная зеленая лампочка (всего 5 штук).
 * 4. Необходимо угадать 5 чисел подряд.
 * 5. При первой же ошибке серия сбрасывается в 0, все лампочки гаснут, загадывается новое число.
 * 6. Числа генерируются случайно, без зацикливания и без прямого повтора предыдущего числа подряд.
 */
export class BinaryPuzzle implements IPuzzle {
  public readonly id = 'binary_conversion_puzzle';
  public readonly name = 'Калибровка двоичного регистра (Десятичные -> Двоичные)';

  private readonly minNumber: number;
  private readonly maxNumber: number;
  private readonly bitsCount: number;
  private readonly requiredStreak: number;
  private readonly avoidConsecutiveRepeats: boolean;
  private readonly emitEvents: boolean;

  private readonly onSuccessCallback?: (state: BinaryPuzzleState) => void;
  private readonly onFailCallback?: (errorInfo: { expected: number; submitted: number; state: BinaryPuzzleState }) => void;
  private readonly onSolvedCallback?: (state: BinaryPuzzleState) => void;
  private readonly onStateChangeCallback?: (state: BinaryPuzzleState) => void;

  // Внутреннее состояние
  private targetNumber: number = 0;
  private currentStreak: number = 0;
  private inputBits: boolean[] = [];
  private isPuzzleSolved: boolean = false;
  private totalAttempts: number = 0;
  private failedAttempts: number = 0;
  private lastResult: 'correct' | 'wrong' | null = null;

  // История последних загаданных чисел для предотвращения зацикленности и монотонности
  private recentNumbers: number[] = [];
  private readonly maxRecentHistory: number = 3;

  constructor(config: BinaryPuzzleConfig = {}) {
    this.minNumber = Math.max(0, config.minNumber ?? 0);
    this.maxNumber = Math.max(this.minNumber, config.maxNumber ?? 31);
    this.bitsCount = Math.max(1, config.bitsCount ?? 5);
    this.requiredStreak = Math.max(1, config.requiredStreak ?? 5);
    this.avoidConsecutiveRepeats = config.avoidConsecutiveRepeats ?? true;
    this.emitEvents = config.emitEvents ?? true;

    this.onSuccessCallback = config.onSuccess;
    this.onFailCallback = config.onFail;
    this.onSolvedCallback = config.onSolved;
    this.onStateChangeCallback = config.onStateChange;

    this.reset();
  }

  /**
   * Решена ли головоломка
   */
  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  /**
   * Текущее десятичное число (0..31)
   */
  public get currentTargetNumber(): number {
    return this.targetNumber;
  }

  /**
   * Текущая серия правильных ответов (0..5)
   */
  public get streak(): number {
    return this.currentStreak;
  }

  /**
   * Состояние зеленых индикаторов (длина 5, true = горит)
   */
  public get lights(): boolean[] {
    const arr: boolean[] = new Array(this.requiredStreak).fill(false);
    for (let i = 0; i < this.currentStreak; i++) {
      arr[i] = true;
    }
    return arr;
  }

  /**
   * Количество горящих зеленых лампочек (0..5)
   */
  public get greenLightsCount(): number {
    return this.currentStreak;
  }

  /**
   * Вес каждого бита слева направо (для 5 бит: [16, 8, 4, 2, 1])
   */
  public get bitWeights(): number[] {
    const weights: number[] = [];
    for (let i = this.bitsCount - 1; i >= 0; i--) {
      weights.push(1 << i);
    }
    return weights;
  }

  /**
   * Переключить состояние бита по его индексу (0 - старший бит слева, т.е. 16; bitsCount-1 - младший бит 1)
   */
  public toggleBit(index: number): void {
    if (this.isPuzzleSolved) return;
    if (index < 0 || index >= this.bitsCount) return;

    this.inputBits[index] = !this.inputBits[index];
    this.notifyStateChanged();
  }

  /**
   * Установить значение конкретного бита
   */
  public setBit(index: number, value: boolean): void {
    if (this.isPuzzleSolved) return;
    if (index < 0 || index >= this.bitsCount) return;

    if (this.inputBits[index] !== value) {
      this.inputBits[index] = value;
      this.notifyStateChanged();
    }
  }

  /**
   * Переключить бит по его числовому весу (например 16, 8, 4, 2 или 1)
   */
  public toggleBitByWeight(weight: number): void {
    const weights = this.bitWeights;
    const index = weights.indexOf(weight);
    if (index !== -1) {
      this.toggleBit(index);
    }
  }

  /**
   * Установить сразу все биты (массив boolean длины bitsCount)
   */
  public setBits(bits: boolean[]): void {
    if (this.isPuzzleSolved) return;

    for (let i = 0; i < this.bitsCount; i++) {
      this.inputBits[i] = Boolean(bits[i]);
    }
    this.notifyStateChanged();
  }

  /**
   * Установить состояние тумблеров по десятичному числу
   */
  public setInputValue(decimalValue: number): void {
    if (this.isPuzzleSolved) return;

    const clamped = Math.max(0, decimalValue);
    for (let i = 0; i < this.bitsCount; i++) {
      const bitWeight = 1 << (this.bitsCount - 1 - i);
      this.inputBits[i] = (clamped & bitWeight) !== 0;
    }
    this.notifyStateChanged();
  }

  /**
   * Установить состояние тумблеров по строке '10101'
   */
  public setInputBinaryString(binaryStr: string): void {
    if (this.isPuzzleSolved) return;

    const clean = binaryStr.trim().replace(/[^01]/g, '');
    const padded = clean.padStart(this.bitsCount, '0').slice(-this.bitsCount);

    for (let i = 0; i < this.bitsCount; i++) {
      this.inputBits[i] = padded[i] === '1';
    }
    this.notifyStateChanged();
  }

  /**
   * Сбросить текущий пользовательский ввод в нули (все тумблеры выключены)
   */
  public clearInput(): void {
    this.inputBits = new Array(this.bitsCount).fill(false);
    this.notifyStateChanged();
  }

  /**
   * Проверить текущее состояние тумблеров (основной метод подтверждения ответа)
   */
  public submit(): PuzzleSubmitResult {
    const currentValue = this.calculateInputValue();
    return this.processSubmission(currentValue);
  }

  /**
   * Проверить ответ, переданный в виде двоичной строки (например: '10101' или '101')
   */
  public submitBinaryString(binaryStr: string): PuzzleSubmitResult {
    const clean = binaryStr.trim().replace(/[^01]/g, '');
    const parsed = clean.length > 0 ? parseInt(clean, 2) : 0;
    this.setInputBinaryString(clean);
    return this.processSubmission(parsed);
  }

  /**
   * Проверить ответ, переданный напрямую десятичным числом
   */
  public submitDecimal(decimalValue: number): PuzzleSubmitResult {
    this.setInputValue(decimalValue);
    return this.processSubmission(decimalValue);
  }

  /**
   * Полный сброс головоломки в начальное состояние
   */
  public reset(): void {
    this.currentStreak = 0;
    this.isPuzzleSolved = false;
    this.lastResult = null;
    this.recentNumbers = [];
    this.clearInput();
    this.generateNextTarget();

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:binary:reset', this.getState());
    }
    this.notifyStateChanged();
  }

  /**
   * Получить снимок полного состояния для UI и рендереров
   */
  public getState(): BinaryPuzzleState {
    const targetBinary = this.numberToBinaryString(this.targetNumber);
    const inputBinary = this.bitsToBinaryString(this.inputBits);
    const inputValue = this.calculateInputValue();

    return {
      targetNumber: this.targetNumber,
      targetBinaryString: targetBinary,
      currentStreak: this.currentStreak,
      requiredStreak: this.requiredStreak,
      lights: this.lights,
      greenLightsCount: this.greenLightsCount,
      isSolved: this.isPuzzleSolved,
      inputBits: [...this.inputBits],
      currentInputValue: inputValue,
      currentInputBinaryString: inputBinary,
      totalAttempts: this.totalAttempts,
      failedAttempts: this.failedAttempts,
      lastResult: this.lastResult
    };
  }

  /**
   * Обработка проверки введенного числа
   */
  private processSubmission(submittedValue: number): PuzzleSubmitResult {
    if (this.isPuzzleSolved) {
      return {
        isCorrect: true,
        targetNumber: this.targetNumber,
        submittedValue,
        expectedBinaryString: this.numberToBinaryString(this.targetNumber),
        submittedBinaryString: this.numberToBinaryString(submittedValue),
        newStreak: this.currentStreak,
        isSolved: true,
        message: 'Головоломка уже решена!'
      };
    }

    this.totalAttempts++;
    const isCorrect = submittedValue === this.targetNumber;

    if (isCorrect) {
      // Верный ответ: зажигаем очередную зеленую лампочку
      this.currentStreak++;
      this.lastResult = 'correct';

      const isNowSolved = this.currentStreak >= this.requiredStreak;
      if (isNowSolved) {
        this.isPuzzleSolved = true;
      }

      const state = this.getState();

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:binary:success', {
          round: this.currentStreak,
          streak: this.currentStreak,
          maxStreak: this.requiredStreak,
          lights: this.lights,
          state
        });
      }

      this.onSuccessCallback?.(state);

      if (isNowSolved) {
        if (this.emitEvents) {
          EventBus.get().emit('puzzle:binary:solved', state);
        }
        this.onSolvedCallback?.(state);
      } else {
        // Подготавливаем следующий раунд: загадываем новое число, сбрасываем тумблеры
        this.clearInput();
        this.generateNextTarget();
      }

      this.notifyStateChanged();

      return {
        isCorrect: true,
        targetNumber: state.targetNumber,
        submittedValue,
        expectedBinaryString: this.numberToBinaryString(state.targetNumber),
        submittedBinaryString: this.numberToBinaryString(submittedValue),
        newStreak: this.currentStreak,
        isSolved: this.isPuzzleSolved,
        message: isNowSolved
          ? 'Поздравляем! Все 5 чисел угаданы, все 5 лампочек зажглись!'
          : `Верно! Лампочка #${this.currentStreak} зажглась. Осталось: ${this.requiredStreak - this.currentStreak}.`
      };
    } else {
      // Ошибка: один раз ошибся — прогресс сбрасывается в 0, лампочки гаснут
      this.failedAttempts++;
      this.currentStreak = 0;
      this.lastResult = 'wrong';

      const state = this.getState();

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:binary:fail', {
          expected: this.targetNumber,
          submitted: submittedValue,
          streak: 0,
          lights: this.lights,
          state
        });
      }

      this.onFailCallback?.({
        expected: this.targetNumber,
        submitted: submittedValue,
        state
      });

      // При ошибке генерируем новое случайное число без зацикливания и сбрасываем тумблеры
      this.clearInput();
      this.generateNextTarget();
      this.notifyStateChanged();

      return {
        isCorrect: false,
        targetNumber: state.targetNumber,
        submittedValue,
        expectedBinaryString: this.numberToBinaryString(state.targetNumber),
        submittedBinaryString: this.numberToBinaryString(submittedValue),
        newStreak: 0,
        isSolved: false,
        message: `Ошибка! Ожидалось число ${state.targetNumber} (в двоичной: ${state.targetBinaryString}), но введено ${submittedValue}. Лампочки сброшены!`
      };
    }
  }

  /**
   * Генерация следующего случайного числа.
   *
   * Требование:
   * "При проигрыше кстати числа не повторяются, ну то есть как бы они могут повториться,
   * но зацикленности не должно, если повторение и будет то это лишь случайность, а не закономерность"
   *
   * Реализация:
   * 1. Равномерный случайный выбор Math.random() из диапазона [minNumber, maxNumber].
   * 2. Исключаем прямое повторение того же числа подряд, если в диапазоне более одного значения.
   * 3. Учитываем недавнюю историю (буфер последних чисел), чтобы снизить вероятность мгновенного
   *    дребезга между двумя числами (A -> B -> A -> B), обеспечивая равномерное случайное распределение.
   * 4. Отсутствует фиксированный циклический массив чисел — каждый вызов по-настоящему случаен.
   */
  private generateNextTarget(): void {
    const rangeSize = this.maxNumber - this.minNumber + 1;

    let candidate: number;
    let attempts = 0;
    const maxAttempts = 20;

    do {
      candidate = Math.floor(Math.random() * rangeSize) + this.minNumber;
      attempts++;

      // Если в диапазоне мало чисел, повторы неизбежны
      if (rangeSize <= 1) break;

      // Защита от прямого повторения подряд с предыдущим числом
      if (this.avoidConsecutiveRepeats && candidate === this.targetNumber) {
        continue;
      }

      // Если попыток еще немного, стараемся избегать недавних чисел из буфера
      if (rangeSize > this.maxRecentHistory && this.recentNumbers.includes(candidate) && attempts < maxAttempts) {
        continue;
      }

      break;
    } while (attempts < maxAttempts);

    this.targetNumber = candidate;

    // Обновляем буфер недавней истории
    this.recentNumbers.push(candidate);
    if (this.recentNumbers.length > this.maxRecentHistory) {
      this.recentNumbers.shift();
    }

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:binary:round_start', {
        targetNumber: this.targetNumber,
        targetBinaryString: this.numberToBinaryString(this.targetNumber),
        streak: this.currentStreak,
        requiredStreak: this.requiredStreak,
        lights: this.lights
      });
    }
  }

  /**
   * Вычислить десятичное значение по текущему положению тумблеров inputBits
   */
  private calculateInputValue(): number {
    let sum = 0;
    for (let i = 0; i < this.bitsCount; i++) {
      if (this.inputBits[i]) {
        sum += 1 << (this.bitsCount - 1 - i);
      }
    }
    return sum;
  }

  /**
   * Преобразовать число в двоичную строку фиксированной длины (с ведущими нулями)
   */
  private numberToBinaryString(num: number): string {
    return num.toString(2).padStart(this.bitsCount, '0');
  }

  /**
   * Преобразовать массив boolean бит в строку '01011'
   */
  private bitsToBinaryString(bits: boolean[]): string {
    return bits.map((b) => (b ? '1' : '0')).join('');
  }

  /**
   * Уведомить подписчиков об изменении состояния
   */
  private notifyStateChanged(): void {
    const state = this.getState();
    this.onStateChangeCallback?.(state);
    if (this.emitEvents) {
      EventBus.get().emit('puzzle:binary:state_changed', state);
    }
  }
}

/**
 * Менеджер и фасад для всех головоломок в игре
 */
export class PuzzleSystem {
  private static instance: PuzzleSystem;
  private puzzles: Map<string, IPuzzle> = new Map();

  /** Единственный дефолтный экземпляр первой бинарной головоломки */
  public readonly binaryPuzzle: BinaryPuzzle;

  private constructor() {
    this.binaryPuzzle = new BinaryPuzzle({
      minNumber: 0,
      maxNumber: 31,
      bitsCount: 5,
      requiredStreak: 5,
      avoidConsecutiveRepeats: true,
      emitEvents: true
    });

    this.registerPuzzle(this.binaryPuzzle);
  }

  public static get(): PuzzleSystem {
    if (!PuzzleSystem.instance) {
      PuzzleSystem.instance = new PuzzleSystem();
    }
    return PuzzleSystem.instance;
  }

  /**
   * Зарегистрировать головоломку в системе
   */
  public registerPuzzle(puzzle: IPuzzle): void {
    this.puzzles.set(puzzle.id, puzzle);
  }

  /**
   * Получить головоломку по ее идентификатору
   */
  public getPuzzle<T extends IPuzzle = IPuzzle>(id: string): T | undefined {
    return this.puzzles.get(id) as T | undefined;
  }

  /**
   * Сбросить все зарегистрированные головоломки
   */
  public resetAll(): void {
    this.puzzles.forEach((p) => p.reset());
  }
}
