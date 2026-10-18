import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Описание нарисованной на стене/плате цифры шифра на уровне
 */
export interface CipherClue {
  id: string;
  /** Порядковый номер цифры в шифре (0-indexed: 0 = 1-я цифра, 1 = 2-я цифра и т.д.) */
  orderIndex: number;
  /** Значение цифры (0..9) */
  digit: number;
  /** Мировые координаты на карте */
  x: number;
  y: number;
  /** Текстовая подсказка/описание для журнала робота (например: "Римская цифра I на трансформаторе: 7") */
  label: string;
  /** Обнаружил ли робот эту цифру */
  isDiscovered: boolean;
  /** Радиус обнаружения роботом (в пикселях) */
  discoveryRadius: number;
}

/**
 * Параметры терминала ввода шифра в отдельной комнате
 */
export interface CipherTerminalLocation {
  x: number;
  y: number;
  interactionRadius: number;
}

/**
 * Конфигурация головоломки с шифром
 */
export interface CipherTerminalConfig {
  id?: string;
  name?: string;
  /** Длина шифра (по умолчанию: 4 цифры) */
  codeLength?: number;
  /** Начальный фиксированный код (если не передан — генерируется случайно) */
  secretCode?: string;
  /** Расположение подсказок на карте уровня */
  clues?: CipherClue[];
  /** Координаты терминала в отдельной комнате */
  terminalLocation?: CipherTerminalLocation;
  /** Отправлять ли события в глобальный EventBus (по умолчанию: true) */
  emitEvents?: boolean;
  /** Коллбек при обнаружении настенной цифры */
  onClueDiscovered?: (clue: CipherClue) => void;
  /** Коллбек при неверном коде */
  onFail?: (enteredCode: string, expectedLength: number) => void;
  /** Коллбек при открытии аппарата (победа) */
  onSolved?: () => void;
}

/**
 * Результат проверки введенного шифра
 */
export interface CipherSubmitResult {
  isCorrect: boolean;
  enteredCode: string;
  expectedLength: number;
  isSolved: boolean;
  message: string;
}

/**
 * Снимок состояния головоломки
 */
export interface CipherPuzzleState {
  codeLength: number;
  enteredCode: string;
  /** Массив значений на кодовых барабанах/дисках */
  drumValues: number[];
  isSolved: boolean;
  totalClues: number;
  discoveredCluesCount: number;
  clues: CipherClue[];
  terminalLocation: CipherTerminalLocation;
  isPlayerNearTerminal: boolean;
}

/**
 * Логика головоломки: «Настенный шифр по локации и терминал ввода».
 *
 * Механика:
 * 1. По разным углам и комнатам карты нанесены цифры шифра с указанием порядка
 *    (например, Римские цифры I, II, III, IV или порядковые маркеры).
 * 2. Робот исследует уровень: когда он подходит к нарисованной цифре, она
 *    заносится в журнал/память робота (isDiscovered = true).
 * 3. В отдельной маленькой комнате стоит терминал/аппарат ввода.
 * 4. Робот подходит к терминалу и вводит собранный шифр:
 *    - через цифровую клавиатуру (inputDigit, backspace, submit);
 *    - или вращая кодовые диски (setDrumDigit).
 * 5. Если шифр верный: терминал открывается, шлюз распахивается (isSolved = true).
 * 6. Если шифр неверный: звучит сигнал ошибки и ввод очищается.
 */
export class CipherTerminalPuzzle implements IPuzzle {
  public readonly id: string;
  public readonly name: string;

  private readonly codeLength: number;
  private readonly emitEvents: boolean;
  private secretCode: string = '';
  private enteredDigits: string = '';
  private drumValues: number[] = [];

  private clues: Map<string, CipherClue> = new Map();
  private terminalLocation: CipherTerminalLocation;
  private isPuzzleSolved: boolean = false;

  private readonly onClueDiscoveredCallback?: (clue: CipherClue) => void;
  private readonly onFailCallback?: (enteredCode: string, expectedLength: number) => void;
  private readonly onSolvedCallback?: () => void;

  constructor(config: CipherTerminalConfig = {}) {
    this.id = config.id ?? 'cipher_terminal_puzzle';
    this.name = config.name ?? 'Секретный шифр отсека (Сбор цифр по карте и терминал)';
    this.codeLength = Math.max(2, config.codeLength ?? 4);
    this.emitEvents = config.emitEvents ?? true;

    this.onClueDiscoveredCallback = config.onClueDiscovered;
    this.onFailCallback = config.onFail;
    this.onSolvedCallback = config.onSolved;

    this.terminalLocation = config.terminalLocation ?? {
      x: 480,
      y: 220,
      interactionRadius: 36
    };

    if (config.secretCode && config.secretCode.length === this.codeLength) {
      this.secretCode = config.secretCode;
    } else {
      this.generateRandomCode(this.codeLength, config.clues);
    }

    if (config.clues) {
      this.clues.clear();
      config.clues.forEach((c) => this.clues.set(c.id, { ...c }));
    }

    this.resetInput();
  }

  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  public get currentEnteredCode(): string {
    return this.enteredDigits;
  }

  public get length(): number {
    return this.codeLength;
  }

  public get discoveredCount(): number {
    let count = 0;
    for (const clue of this.clues.values()) {
      if (clue.isDiscovered) count++;
    }
    return count;
  }

  public get totalCluesCount(): number {
    return this.clues.size;
  }

  /**
   * Сгенерировать новый случайный шифр и разложить цифры по точкам интереса
   */
  public generateRandomCode(length: number = this.codeLength, customLocations?: Partial<CipherClue>[]): void {
    const digits: number[] = [];
    for (let i = 0; i < length; i++) {
      digits.push(Math.floor(Math.random() * 10)); // 0..9
    }
    this.secretCode = digits.join('');

    // Дефолтные координаты для нарисованных цифр в разных уголках уровня
    const defaultCoords: Array<{ x: number; y: number; label: string; discoveryRadius?: number }> = [
      { x: 90, y: 160, label: 'Секция A: За трансформатором [I]' },
      { x: 260, y: 80, label: 'Секция B: На медном радиаторе [II]' },
      { x: 380, y: 310, label: 'Секция C: Под вентилятором [III]' },
      { x: 190, y: 240, label: 'Секция D: Возле шлейфа питания [IV]' },
      { x: 320, y: 180, label: 'Секция E: За панелью реле [V]' }
    ];

    this.clues.clear();
    for (let i = 0; i < length; i++) {
      const loc = customLocations?.[i] ?? defaultCoords[i % defaultCoords.length];
      const clueId = `clue_${i + 1}`;
      this.clues.set(clueId, {
        id: clueId,
        orderIndex: i,
        digit: digits[i],
        x: loc.x ?? (100 + i * 80),
        y: loc.y ?? 150,
        label: loc.label ?? `Шифр: позиция #${i + 1} = ${digits[i]}`,
        isDiscovered: false,
        discoveryRadius: loc.discoveryRadius ?? 32
      });
    }

    this.resetInput();
    this.isPuzzleSolved = false;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:cipher:reset', this.getState());
    }
  }

  /**
   * Проверить, подошел ли персонаж к одной из нарисованных цифр на карте
   * Вызывается в игровом цикле или при движении персонажа.
   */
  public checkClueDiscovery(playerX: number, playerY: number): CipherClue | null {
    for (const clue of this.clues.values()) {
      if (clue.isDiscovered) continue;

      const dist = this.getDistance(playerX, playerY, clue.x, clue.y);
      if (dist <= clue.discoveryRadius) {
        clue.isDiscovered = true;

        if (this.emitEvents) {
          EventBus.get().emit('puzzle:cipher:clue_discovered', {
            clue: { ...clue },
            discoveredCount: this.discoveredCount,
            totalClues: this.totalCluesCount,
            playerX,
            playerY
          });
        }

        this.onClueDiscoveredCallback?.({ ...clue });
        return { ...clue };
      }
    }

    return null;
  }

  /**
   * Находится ли игрок рядом с терминалом в маленькой комнате
   */
  public isNearTerminal(playerX: number, playerY: number): boolean {
    const dist = this.getDistance(playerX, playerY, this.terminalLocation.x, this.terminalLocation.y);
    return dist <= this.terminalLocation.interactionRadius;
  }

  /**
   * Ввод очередной цифры на клавиатуре терминала (0..9)
   */
  public inputDigit(digit: number | string): void {
    if (this.isPuzzleSolved) return;

    const char = String(digit).trim().slice(-1);
    if (!/^[0-9]$/.test(char)) return;

    if (this.enteredDigits.length < this.codeLength) {
      const idx = this.enteredDigits.length;
      this.enteredDigits += char;
      this.drumValues[idx] = parseInt(char, 10);

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:cipher:digit_entered', {
          digit: parseInt(char, 10),
          currentCode: this.enteredDigits,
          expectedLength: this.codeLength
        });
      }

      // Если ввели последнюю цифру — автоматически проверяем код
      if (this.enteredDigits.length === this.codeLength) {
        this.submit();
      }
    }
  }

  /**
   * Поворот конкретного барабана/диска (для визуализации поворотных замков)
   */
  public setDrumDigit(slotIndex: number, digit: number): void {
    if (this.isPuzzleSolved) return;
    if (slotIndex < 0 || slotIndex >= this.codeLength) return;

    const clamped = Math.max(0, Math.min(9, Math.round(digit)));
    this.drumValues[slotIndex] = clamped;

    // Синхронизируем строку
    const chars = this.drumValues.map((d) => String(d));
    this.enteredDigits = chars.join('');

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:cipher:digit_entered', {
        slotIndex,
        digit: clamped,
        currentCode: this.enteredDigits,
        expectedLength: this.codeLength
      });
    }
  }

  /**
   * Стереть последнюю введенную цифру (Backspace)
   */
  public backspace(): void {
    if (this.isPuzzleSolved) return;
    if (this.enteredDigits.length > 0) {
      const removedIndex = this.enteredDigits.length - 1;
      this.enteredDigits = this.enteredDigits.slice(0, -1);
      this.drumValues[removedIndex] = 0;
    }
  }

  /**
   * Очистить поле ввода
   */
  public clearInput(): void {
    this.resetInput();
  }

  /**
   * Проверить введенный шифр на аппарате
   */
  public submit(explicitCode?: string): CipherSubmitResult {
    const codeToCheck = explicitCode ?? this.enteredDigits;

    if (codeToCheck.length !== this.codeLength) {
      return {
        isCorrect: false,
        enteredCode: codeToCheck,
        expectedLength: this.codeLength,
        isSolved: false,
        message: `Шифр не полон! Введено ${codeToCheck.length} из ${this.codeLength} цифр.`
      };
    }

    const isMatch = codeToCheck === this.secretCode;

    if (isMatch) {
      this.isPuzzleSolved = true;

      if (this.emitEvents) {
        EventBus.get().emit('puzzle:cipher:solved', {
          code: codeToCheck,
          state: this.getState()
        });
      }

      this.onSolvedCallback?.();

      return {
        isCorrect: true,
        enteredCode: codeToCheck,
        expectedLength: this.codeLength,
        isSolved: true,
        message: 'ДОСТУП РАЗРЕШЕН! Шлюз разблокирован.'
      };
    } else {
      if (this.emitEvents) {
        EventBus.get().emit('puzzle:cipher:fail', {
          enteredCode: codeToCheck,
          expectedLength: this.codeLength
        });
      }

      this.onFailCallback?.(codeToCheck, this.codeLength);
      this.resetInput();

      return {
        isCorrect: false,
        enteredCode: codeToCheck,
        expectedLength: this.codeLength,
        isSolved: false,
        message: 'ОШИБКА ДОСТУПА: Неверный шифр! Ввод сброшен.'
      };
    }
  }

  public reset(): void {
    this.isPuzzleSolved = false;
    this.resetInput();
    for (const clue of this.clues.values()) {
      clue.isDiscovered = false;
    }

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:cipher:reset', this.getState());
    }
  }

  /**
   * Получить полный снимок состояния для HUD и экрана терминала
   */
  public getState(playerX?: number, playerY?: number): CipherPuzzleState {
    const isNear =
      playerX !== undefined && playerY !== undefined
        ? this.isNearTerminal(playerX, playerY)
        : false;

    return {
      codeLength: this.codeLength,
      enteredCode: this.enteredDigits,
      drumValues: [...this.drumValues],
      isSolved: this.isPuzzleSolved,
      totalClues: this.totalCluesCount,
      discoveredCluesCount: this.discoveredCount,
      clues: Array.from(this.clues.values()).map((c) => ({ ...c })),
      terminalLocation: { ...this.terminalLocation },
      isPlayerNearTerminal: isNear
    };
  }

  /**
   * Получить целевой правильный шифр (для отладки)
   */
  public getTargetCode(): string {
    return this.secretCode;
  }

  private resetInput(): void {
    this.enteredDigits = '';
    this.drumValues = new Array(this.codeLength).fill(0);
  }

  private getDistance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
