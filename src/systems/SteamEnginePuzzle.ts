import { EventBus } from '../core/EventBus.ts';
import type { IPuzzle } from './PuzzleSystem.ts';

/**
 * Конфигурация отдельного манометра / спидометра парового двигателя
 */
export interface SteamGaugeConfig {
  name: string;
  minScale?: number;
  maxScale?: number;
  targetValue: number;
  tolerance?: number;
  baseValue: number;
}

/**
 * Состояние одного манометра / спидометра
 */
export interface SteamGaugeState {
  index: number;
  name: string;
  /** Текущее числовое значение на шкале [0..100] */
  currentValue: number;
  /** Угол поворота стрелки в градусах от -120° (минимум) до +120° (максимум) */
  angleDeg: number;
  /** Целевое значение в центре зелёной зоны */
  targetValue: number;
  /** Нижняя граница зелёной зоны допуска */
  greenZoneMin: number;
  /** Верхняя граница зелёной зоны допуска */
  greenZoneMax: number;
  /** Угол начала зелёного сектора в градусах */
  greenZoneStartAngleDeg: number;
  /** Угол конца зелёного сектора в градусах */
  greenZoneEndAngleDeg: number;
  /** Находится ли стрелка прямо сейчас в зелёной зоне допуска */
  isInGreenZone: boolean;
  minScale: number;
  maxScale: number;
}

/**
 * Состояние одного рычага управления
 */
export interface SteamLeverState {
  index: number;
  name: string;
  /** Текущее положение рычага (целое число от minPosition до maxPosition) */
  position: number;
  minPosition: number;
  maxPosition: number;
  /** Нормализованное положение от 0.0 (крайний низ) до 1.0 (крайний верх) */
  normalized: number;
}

/**
 * Полный снимок состояния головоломки парового двигателя
 */
export interface SteamEnginePuzzleState {
  levers: SteamLeverState[];
  gauges: SteamGaugeState[];
  /** Решена ли головоломка (все 3 прибора одновременно встали в зелёные зоны) */
  isSolved: boolean;
  /** Количество приборов, находящихся сейчас в норме (0..3) */
  greenCount: number;
  /** Матрица взаимного влияния: matrix[gaugeIndex][leverIndex] */
  influenceMatrix: number[][];
  /** Количество перемещений рычагов */
  moveCount: number;
}

/**
 * Опции инициализации головоломки
 */
export interface SteamEngineConfig {
  /** Нижний предел хода рычага (по умолчанию: -5) */
  minLeverPos?: number;
  /** Верхний предел хода рычага (по умолчанию: 5) */
  maxLeverPos?: number;
  /** Полууширина зелёной зоны допуска +- (по умолчанию: 4) */
  greenTolerance?: number;
  /** Пользовательские названия рычагов */
  leverNames?: string[];
  /** Пользовательские названия приборов */
  gaugeNames?: string[];
  /** Отправлять ли события в глобальный EventBus (по умолчанию: true) */
  emitEvents?: boolean;
  /** Коллбек при любом движении рычага или смене показаний стрелок */
  onStateChange?: (state: SteamEnginePuzzleState) => void;
  /** Коллбек при успешной стабилизации всех 3 контуров (победа) */
  onSolved?: (state: SteamEnginePuzzleState) => void;
}

/**
 * Логика головоломки «Паровой двигатель / Регулировка 3 контуров».
 *
 * Сюжетная точка: Паровой двигатель / регулятор турбины.
 *
 * Механика:
 * 1. Игрок управляет тремя рычагами (впускной клапан, дроссель, перепускной регулятор)
 *    с возможностью слегка уводить их вверх и вниз (от -5 до +5, нейтраль в 0).
 * 2. Каждый рычаг отклоняет стрелки ВСЕХ ТРЁХ манометров/спидометров:
 *    - Рычаг 1 сильнее всего двигает давление котла, но слегка сбивает обороты и температуру;
 *    - Рычаг 2 сильнее всего двигает обороты турбины, но отклоняет давление и температуру;
 *    - Рычаг 3 сильнее всего регулирует температуру пара, но влияет на давление и обороты.
 * 3. На каждом циферблате есть зелёная зона допуска.
 * 4. Задача: перевести 3 рычага в такие позиции, чтобы стрелки всех 3 спидометров
 *    одновременно встали в свои зелёные зоны.
 * 5. Генератор гарантирует наличие корректного решения.
 */
export class SteamEnginePuzzle implements IPuzzle {
  public readonly id = 'steam_engine_puzzle';
  public readonly name = 'Steam engine calibration (3 levers and 3 gauges)';

  public static readonly LEVER_COUNT = 3;
  public static readonly GAUGE_COUNT = 3;

  private readonly minLeverPos: number;
  private readonly maxLeverPos: number;
  private readonly greenTolerance: number;
  private readonly emitEvents: boolean;

  private readonly leverNames: string[];
  private readonly gaugeNames: string[];

  private leverPositions: number[] = [0, 0, 0];

  /** Матрица влияния: influenceMatrix[gaugeIndex][leverIndex] */
  private influenceMatrix: number[][] = [
    [+7, -3, +2],
    [-2, +6, -3],
    [+1, -2, +8]
  ];

  /** Базовые смещения спидометров при нейтральных рычагах [0, 0, 0] */
  private baseValues: number[] = [30, 70, 25];

  /** Целевые значения для попадания в зеленую зону */
  private targetValues: number[] = [50, 50, 50];

  /** Сгенерированное гарантированное решение [L0, L1, L2] */
  private targetSolution: number[] = [0, 0, 0];

  private isPuzzleSolved: boolean = false;
  private moveCount: number = 0;

  private readonly onStateChangeCallback?: (state: SteamEnginePuzzleState) => void;
  private readonly onSolvedCallback?: (state: SteamEnginePuzzleState) => void;

  constructor(config: SteamEngineConfig = {}) {
    this.minLeverPos = config.minLeverPos ?? -5;
    this.maxLeverPos = config.maxLeverPos ?? 5;
    this.greenTolerance = config.greenTolerance ?? 4;
    this.emitEvents = config.emitEvents ?? true;

    this.leverNames = config.leverNames ?? [
      'Steam intake valve',
      'Throttle',
      'Bypass regulator'
    ];

    this.gaugeNames = config.gaugeNames ?? [
      'Boiler pressure',
      'Turbine RPM',
      'Steam temperature'
    ];

    this.onStateChangeCallback = config.onStateChange;
    this.onSolvedCallback = config.onSolved;

    this.generateSolvablePuzzle();
  }

  public get isSolved(): boolean {
    return this.isPuzzleSolved;
  }

  public get moves(): number {
    return this.moveCount;
  }

  /**
   * Сдвинуть рычаг вверх на указанное число шагов (по умолчанию: 1)
   */
  public moveUp(leverIndex: number, steps: number = 1): boolean {
    return this.moveLever(leverIndex, steps);
  }

  /**
   * Сдвинуть рычаг вниз на указанное число шагов (по умолчанию: 1)
   */
  public moveDown(leverIndex: number, steps: number = 1): boolean {
    return this.moveLever(leverIndex, -steps);
  }

  /**
   * Сместить рычаг на дельту
   */
  public moveLever(leverIndex: number, delta: number): boolean {
    if (leverIndex < 0 || leverIndex >= SteamEnginePuzzle.LEVER_COUNT) return false;
    const current = this.leverPositions[leverIndex];
    return this.setLeverPosition(leverIndex, current + delta);
  }

  /**
   * Установить точное положение рычага
   */
  public setLeverPosition(leverIndex: number, newPosition: number): boolean {
    if (leverIndex < 0 || leverIndex >= SteamEnginePuzzle.LEVER_COUNT) return false;

    const clamped = Math.max(this.minLeverPos, Math.min(this.maxLeverPos, Math.round(newPosition)));
    if (this.leverPositions[leverIndex] === clamped) {
      return false;
    }

    this.leverPositions[leverIndex] = clamped;
    this.moveCount++;

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:steam:lever_moved', {
        leverIndex,
        leverName: this.leverNames[leverIndex],
        newPosition: clamped,
        moveCount: this.moveCount
      });
    }

    this.updateEvaluation();
    return true;
  }

  /**
   * Сбросить положение рычагов в нейтраль (0, 0, 0)
   */
  public reset(): void {
    this.leverPositions = [0, 0, 0];
    this.moveCount = 0;
    this.updateEvaluation();

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:steam:reset', this.getState());
    }
  }

  /**
   * Сгенерировать новую случайную конфигурацию с гарантированным решением
   */
  public generateSolvablePuzzle(): void {
    // 1. Выбираем случайное целевое решение в пределах хода рычагов, кроме [0, 0, 0]
    let s0 = 0, s1 = 0, s2 = 0;
    while (s0 === 0 && s1 === 0 && s2 === 0) {
      s0 = this.getRandomInt(-4, 4);
      s1 = this.getRandomInt(-4, 4);
      s2 = this.getRandomInt(-4, 4);
    }
    this.targetSolution = [s0, s1, s2];

    // 2. Генерируем матрицу влияния с доминирующей главной диагональю
    this.influenceMatrix = [
      [this.getRandomInt(6, 8), this.getRandomInt(-4, -1), this.getRandomInt(1, 3)],
      [this.getRandomInt(-3, 3), this.getRandomInt(6, 8), this.getRandomInt(-4, -1)],
      [this.getRandomInt(1, 3), this.getRandomInt(-3, 3), this.getRandomInt(6, 8)]
    ];

    // 3. Целевые значения спидометров
    this.targetValues = [
      this.getRandomInt(45, 55),
      this.getRandomInt(45, 55),
      this.getRandomInt(45, 55)
    ];

    // 4. Рассчитываем базовые смещения baseValues:
    // при установке рычагов в targetSolution значения будут в точности targetValues!
    this.baseValues = [];
    for (let i = 0; i < SteamEnginePuzzle.GAUGE_COUNT; i++) {
      let influenceSum = 0;
      for (let j = 0; j < SteamEnginePuzzle.LEVER_COUNT; j++) {
        influenceSum += this.influenceMatrix[i][j] * this.targetSolution[j];
      }
      this.baseValues[i] = this.targetValues[i] - influenceSum;
    }

    this.leverPositions = [0, 0, 0];
    this.moveCount = 0;
    this.isPuzzleSolved = false;

    this.updateEvaluation();
  }

  /**
   * Получить снимок полного состояния для визуального рендерера / ассетов
   */
  public getState(): SteamEnginePuzzleState {
    const levers: SteamLeverState[] = this.leverPositions.map((pos, idx) => {
      const span = this.maxLeverPos - this.minLeverPos;
      const normalized = span > 0 ? (pos - this.minLeverPos) / span : 0.5;
      return {
        index: idx,
        name: this.leverNames[idx],
        position: pos,
        minPosition: this.minLeverPos,
        maxPosition: this.maxLeverPos,
        normalized
      };
    });

    let greenCount = 0;
    const gauges: SteamGaugeState[] = [];

    for (let i = 0; i < SteamEnginePuzzle.GAUGE_COUNT; i++) {
      let val = this.baseValues[i];
      for (let j = 0; j < SteamEnginePuzzle.LEVER_COUNT; j++) {
        val += this.influenceMatrix[i][j] * this.leverPositions[j];
      }

      const clampedVal = Math.max(0, Math.min(100, val));
      const target = this.targetValues[i];
      const minZone = Math.max(0, target - this.greenTolerance);
      const maxZone = Math.min(100, target + this.greenTolerance);
      const inZone = clampedVal >= minZone && clampedVal <= maxZone;

      if (inZone) greenCount++;

      // Преобразование шкалы 0..100 в угол стрелки от -120° до +120° (размах 240°)
      const angleDeg = -120 + (clampedVal / 100) * 240;
      const greenZoneStartAngleDeg = -120 + (minZone / 100) * 240;
      const greenZoneEndAngleDeg = -120 + (maxZone / 100) * 240;

      gauges.push({
        index: i,
        name: this.gaugeNames[i],
        currentValue: Math.round(clampedVal * 10) / 10,
        angleDeg: Math.round(angleDeg * 10) / 10,
        targetValue: target,
        greenZoneMin: minZone,
        greenZoneMax: maxZone,
        greenZoneStartAngleDeg: Math.round(greenZoneStartAngleDeg * 10) / 10,
        greenZoneEndAngleDeg: Math.round(greenZoneEndAngleDeg * 10) / 10,
        isInGreenZone: inZone,
        minScale: 0,
        maxScale: 100
      });
    }

    const solved = greenCount === SteamEnginePuzzle.GAUGE_COUNT;

    return {
      levers,
      gauges,
      isSolved: solved,
      greenCount,
      influenceMatrix: this.influenceMatrix.map((row) => [...row]),
      moveCount: this.moveCount
    };
  }

  /**
   * Подсказка с точным победным решением (для отладки или подсказок робота)
   */
  public getSolution(): number[] {
    return [...this.targetSolution];
  }

  private updateEvaluation(): void {
    const state = this.getState();
    const wasSolved = this.isPuzzleSolved;
    this.isPuzzleSolved = state.isSolved;

    this.onStateChangeCallback?.(state);

    if (this.emitEvents) {
      EventBus.get().emit('puzzle:steam:state_changed', state);
    }

    if (this.isPuzzleSolved && !wasSolved) {
      if (this.emitEvents) {
        EventBus.get().emit('puzzle:steam:solved', state);
      }
      this.onSolvedCallback?.(state);
    }
  }

  private getRandomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
