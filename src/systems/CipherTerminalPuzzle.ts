import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';
import type { LevelDef, RoomDef } from '../data/types.ts';

/**
 * Преобразование порядкового номера (1, 2, 3...) в римскую цифру (I, II, III, IV, V...)
 */
export function toRoman(num: number): string {
  const map: Array<[number, string]> = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let res = '';
  let n = Math.max(1, Math.round(num));
  for (const [v, r] of map) {
    while (n >= v) {
      res += r;
      n -= v;
    }
  }
  return res || 'I';
}

/**
 * Описание нарисованной на стене/плате цифры шифра на уровне
 */
export interface CipherClue {
  id: string;
  /** Порядковый номер цифры в шифре (0-indexed: 0 = 1-я цифра, 1 = 2-я цифра и т.д.) */
  orderIndex: number;
  /** Римская цифра позиции (I, II, III, IV...) */
  roman: string;
  /** Значение цифры (0..9) */
  digit: number;
  /** Мировые координаты на карте */
  x: number;
  y: number;
  /** Название комнаты, в которой находится подсказка */
  roomName?: string;
  /** Текстовая подсказка/описание для журнала робота (например: "[I] в комнате Хаб: 7") */
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
   * Получить список всех подсказок шифра на карте
   */
  public getClues(): CipherClue[] {
    return Array.from(this.clues.values());
  }

  /**
   * Получить подсказку по её ID
   */
  public getClue(id: string): CipherClue | undefined {
    return this.clues.get(id);
  }

  /**
   * Сгенерировать и расставить цифры шифра (0..9) по комнатам 1-й локации.
   *
   * Правила распределения:
   * 1. Для карты world_prototype (map prototype) и любой другой карты со множеством комнат,
   *    цифры спавнятся ТОЛЬКО в комнатах, привязанных к 1-й локации (location === 1).
   * 2. Поддерживаются уровни LOC1A, LOC1B, LOC1C, LOC1D, LOC1E и test_level — в них цифры
   *    спавнятся в их комнатах (от 0 до 9 с римскими номерами I, II, III, IV...).
   * 3. Комнаты боссов и ввода пароля исключаются из настенных подсказок.
   * 4. Позиции подбираются на стенах/воздухе с твердой опорой снизу, распределяясь по комнатам.
   */
  public spawnCluesForLevel(
    levelDef: LevelDef,
    level: {
      isSolid: (cx: number, cy: number) => boolean;
      tileSize: number;
      widthTiles: number;
      heightTiles: number;
    },
    roomMap?: { defs: readonly RoomDef[] }
  ): CipherClue[] {
    const ts = level.tileSize;
    const allRooms: readonly RoomDef[] = roomMap?.defs ?? levelDef.rooms ?? [];

    // 1. Поиск комнат 1-й локации
    let targetRooms: readonly RoomDef[] = allRooms.filter((r) => r.location === 1);

    // Если явный признак location не проставлен (например, старые карты):
    if (targetRooms.length === 0) {
      if (levelDef.id === 'world_prototype') {
        // На world_prototype секция 1-й локации находится в правой части карты (x >= 120)
        targetRooms = allRooms.filter((r) => r.x >= 120);
      } else if (levelDef.id.startsWith('LOC1') || levelDef.id === 'test_level' || levelDef.start_armor === 1) {
        // Уровни LOC1A-E и test_level целиком относятся к 1-й локации
        targetRooms = [...allRooms];
      } else if (allRooms.length <= 4) {
        // Если комнат мало, используем все доступные
        targetRooms = [...allRooms];
      }
    }

    // 2. Исключаем комнаты боссов и терминала пароля
    const filteredRooms = targetRooms.filter((r) => {
      const name = (r.name || '').toLowerCase();
      return !name.includes('босс') && !name.includes('пароль');
    });

    const activeRooms: readonly RoomDef[] = filteredRooms.length > 0 ? filteredRooms : (targetRooms.length > 0 ? targetRooms : allRooms);

    // Если вообще нет комнат (пустой уровень): создаем виртуальную область уровня
    const roomsToUse: readonly RoomDef[] = activeRooms.length > 0
      ? activeRooms
      : [{
          id: 'room_virtual_loc1',
          name: 'Локация 1',
          x: 1,
          y: 1,
          width: Math.max(2, level.widthTiles - 2),
          height: Math.max(2, level.heightTiles - 2),
          location: 1
        }];

    // 3. Генерация цифр 0..9 для шифра
    const length = this.codeLength;
    const digits: number[] = [];
    for (let i = 0; i < length; i++) {
      digits.push(Math.floor(Math.random() * 10)); // 0..9
    }
    this.secretCode = digits.join('');
    this.clues.clear();

    const filled = (ch: string | undefined) => ch === '#' || ch === '1';
    const chosenPositions: Array<{ x: number; y: number }> = [];

    // 4. Расстановка цифр по комнатам 1-й локации
    for (let i = 0; i < length; i++) {
      const room = roomsToUse.length >= length
        ? roomsToUse[i]
        : roomsToUse[i % roomsToUse.length];

      const rX0 = Math.max(0, room.x);
      const rX1 = Math.min(level.widthTiles - 1, room.x + room.width - 1);
      const rY0 = Math.max(0, room.y);
      const rY1 = Math.min(level.heightTiles - 1, room.y + room.height - 1);

      // Ищем подходящие воздушные клетки в комнате
      const spots: Array<{ cx: number; cy: number; score: number }> = [];

      for (let cy = rY0; cy <= rY1; cy++) {
        for (let cx = rX0; cx <= rX1; cx++) {
          if (room.mask && !filled(room.mask[cy - room.y]?.[cx - room.x])) continue;
          if (level.isSolid(cx, cy)) continue;
          if (cy > 0 && level.isSolid(cx, cy - 1)) continue;

          // Проверяем наличие пола под ногами или стены рядом
          const hasFloor1 = cy + 1 < level.heightTiles && level.isSolid(cx, cy + 1);
          const hasFloor2 = cy + 2 < level.heightTiles && level.isSolid(cx, cy + 2);
          const hasWallL = cx > 0 && level.isSolid(cx - 1, cy);
          const hasWallR = cx + 1 < level.widthTiles && level.isSolid(cx + 1, cy);

          let score = 0;
          if (hasFloor1 || hasFloor2) score += 10;
          if (hasWallL || hasWallR) score += 5;

          // Расстояние до уже выбранных точек
          const px = cx * ts + ts / 2;
          const py = cy * ts + ts / 2;
          const minDist = chosenPositions.reduce((min, p) => {
            const d = Math.hypot(p.x - px, p.y - py);
            return Math.min(min, d);
          }, Infinity);

          if (minDist < ts * 3) score -= 15; // избегаем скопления в одной точке
          else score += Math.min(10, minDist / ts);

          spots.push({ cx, cy, score });
        }
      }

      // Сортируем кандидатов по качеству
      spots.sort((a, b) => b.score - a.score);

      let chosenX = Math.round((room.x + room.width / 2) * ts);
      let chosenY = Math.round((room.y + room.height / 2) * ts);

      if (spots.length > 0) {
        // Выбираем из лучших кандидатов для естественного разнообразия
        const poolSize = Math.max(1, Math.min(spots.length, 5));
        const pick = spots[Math.floor(Math.random() * poolSize)];
        chosenX = pick.cx * ts + ts / 2;
        chosenY = pick.cy * ts + ts / 2;
      }

      chosenPositions.push({ x: chosenX, y: chosenY });

      const clueId = `clue_${i + 1}`;
      const roman = toRoman(i + 1);
      const roomTitle = room.name || `Отсек ${i + 1}`;

      this.clues.set(clueId, {
        id: clueId,
        orderIndex: i,
        roman,
        digit: digits[i],
        x: chosenX,
        y: chosenY,
        roomName: roomTitle,
        label: `[Локация 1] ${roomTitle}: цифра [${roman}] = ${digits[i]}`,
        isDiscovered: false,
        discoveryRadius: 42
      });
    }

    // 5. Определение позиции терминала ввода пароля
    const passwordObj = levelDef.objects?.find((o) => o.type === 'password');
    if (passwordObj) {
      this.terminalLocation = {
        x: passwordObj.x,
        y: passwordObj.y,
        interactionRadius: 44
      };
    } else {
      const passwordRoom = allRooms.find((r) => (r.name || '').toLowerCase().includes('пароль'));
      if (passwordRoom) {
        this.terminalLocation = {
          x: Math.round((passwordRoom.x + passwordRoom.width / 2) * ts),
          y: Math.round((passwordRoom.y + passwordRoom.height - 1) * ts),
          interactionRadius: 48
        };
      }
    }

    this.resetInput();
    this.isPuzzleSolved = false;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:cipher:reset', this.getState());
    }

    return this.getClues();
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
    const defaultCoords: Array<{ x: number; y: number; label: string; roomName?: string; discoveryRadius?: number }> = [
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
      const roman = toRoman(i + 1);
      this.clues.set(clueId, {
        id: clueId,
        orderIndex: i,
        roman,
        digit: digits[i],
        x: loc.x ?? (100 + i * 80),
        y: loc.y ?? 150,
        roomName: loc.roomName,
        label: loc.label ?? `Шифр: позиция [${roman}] = ${digits[i]}`,
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
