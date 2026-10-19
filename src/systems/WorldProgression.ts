import { Quest } from './Quest.ts';
import { EventBus } from '../core/EventBus.ts';

export interface RoomCombatState {
  roomId: string;
  name: string;
  aliveEnemies: number;
  isCleared: boolean;
  engaged: boolean;
}

/**
 * Менеджер прогрессии дверей и боевых комнат на карте `world_prototype`.
 * Управляет логикой:
 * 1. Открытие дверей по условиям сюжета:
 *    - Двери 9 и 10 открываются сразу;
 *    - Дверь 7: победа в «Драка» (розовая);
 *    - Двери 5 и 3: победа в «Драка+батарейка» + вставка батарейки в стойку;
 *    - Двери 4 и 6: победа в «Драка» (зеленая);
 *    - Двери 2 и 1: решение головоломки шифра на терминале;
 *    - Двери 11 и 12: победа над боссом (червь);
 *    - Дверь 14: победа в «Драка» возле хаба (room_7);
 *    - Двери 13 и 16: победа в «Драка+рычаги» (room_8) + решение рычагов;
 *    - Двери 17 и 18: победа в «Драка» (салатовая, room_9);
 *    - Дверь 15: победа в «Драка+провода» (room_13) + решение проводов;
 *    - Двери 19 и 20: победа в «Драка» (голубая, room_12);
 *    - Босс орел: победа открывает доступ к финальному боссу.
 * 2. Автоматическое запирание дверей комнаты во время активного боя с врагами (после входа игрока).
 */
export class WorldProgression {
  private static instance: WorldProgression;

  /** Активные боевые комнаты по их id */
  private roomStates = new Map<string, RoomCombatState>();

  /** Каким комнатам принадлежат двери (для арены боя) */
  private doorToRooms = new Map<string, string[]>([
    ['door_9', ['room_1792350468378_173']],
    ['door_7', ['room_1792350468378_173', 'room_1792350689091_266']],
    ['door_5', ['room_1792350689091_266', 'room_1792351055354_265']],
    ['door_8', ['room_1792350689091_266']],
    ['door_3', ['room_1792351055354_265']],
    ['door_4', ['room_1792351055354_265']],
    ['door_6', ['room_1792351171247_462']],
    ['door_2', ['room_1792351055354_265']],
    ['door_1', ['room_1792351256509_106']],
    ['door_12', ['room_7']],
    ['door_13', ['room_7']],
    ['door_14', ['room_8']],
    ['door_16', ['room_8', 'room_9']],
    ['door_17', ['room_9']],
    ['door_18', ['room_9', 'room_13']],
    ['door_15', ['room_13', 'room_12']],
    ['door_19', ['room_12']],
    ['door_20', ['room_11']]
  ]);

  public static get(): WorldProgression {
    if (!WorldProgression.instance) {
      WorldProgression.instance = new WorldProgression();
    }
    return WorldProgression.instance;
  }

  private constructor(private readonly quest = Quest.get()) {}

  public reset(): void {
    this.roomStates.clear();
  }

  /** Регистрация врага в комнате */
  public registerEnemy(roomId: string, roomName: string): void {
    let state = this.roomStates.get(roomId);
    if (!state) {
      const isCleared = this.quest.flag(`cleared:${roomId}`);
      state = { roomId, name: roomName, aliveEnemies: 0, isCleared, engaged: false };
      this.roomStates.set(roomId, state);
    }
    if (!state.isCleared) {
      state.aliveEnemies++;
    }
  }

  /** Обновляет текущие комнаты, в которых стоит герой — активирует арену боя при наличии врагов */
  public updateHeroRooms(roomIds: string[]): void {
    for (const id of roomIds) {
      const state = this.roomStates.get(id);
      if (state && !state.isCleared && state.aliveEnemies > 0) {
        state.engaged = true;
      }
    }
  }

  /** Сброс состояния боя (при возрождении игрока) */
  public resetEngagement(): void {
    for (const state of this.roomStates.values()) {
      state.engaged = false;
    }
  }

  /** Фиксация гибели врага в комнате */
  public onEnemyKilled(roomId: string): void {
    const state = this.roomStates.get(roomId);
    if (!state || state.isCleared) return;
    state.aliveEnemies = Math.max(0, state.aliveEnemies - 1);
    if (state.aliveEnemies === 0) {
      state.isCleared = true;
      state.engaged = false;
      this.quest.setFlag(`cleared:${roomId}`);
      this.onRoomCleared(roomId, state.name);
    }
  }

  /** Обработка завершения зачистки комнаты */
  private onRoomCleared(roomId: string, name: string): void {
    EventBus.get().emit('room:cleared', { roomId, name });
    console.log(`[WorldProgression] Комната "${name}" (${roomId}) зачищена!`);

    // Если это босс орел — ставим флаг финального босса
    if (roomId === 'room_11' || name.toLowerCase().includes('орел')) {
      this.quest.setFlag('final_boss_room_unlocked');
      console.log('[WorldProgression] Босс (орел) повержен! Комната финального босса разблокирована!');
    }
  }

  /** Проверяет, зачищена ли комната */
  public isRoomCleared(roomId: string): boolean {
    return this.quest.flag(`cleared:${roomId}`) || (this.roomStates.get(roomId)?.isCleared ?? false);
  }

  /** Проверяет, идет ли сейчас активный бой в комнате */
  public isRoomFighting(roomId: string): boolean {
    const state = this.roomStates.get(roomId);
    return !!state && !state.isCleared && state.aliveEnemies > 0 && state.engaged;
  }

  /** Проверяет, заблокирована ли дверь из-за активного боя в комнате */
  public isDoorArenaLocked(doorId: string): boolean {
    const rooms = this.doorToRooms.get(doorId);
    if (!rooms) return false;
    for (const r of rooms) {
      if (this.isRoomFighting(r)) return true;
    }
    return false;
  }

  /**
   * Проверяет, может ли дверь быть открыта по правилам прогрессии карты.
   */
  public canOpenDoor(doorId: string): boolean {
    // 1. Если в комнате этой двери прямо сейчас идет бой — закрыта
    if (this.isDoorArenaLocked(doorId)) return false;

    // 2. Правила прогрессии для карты world_prototype
    switch (doorId) {
      // Двери 9 и 10: открываются сразу
      case 'door_9':
      case 'door_10':
        return true;

      // Дверь 7: после победы в комнате Драка (розовая)
      case 'door_7':
        return this.isRoomCleared('room_1792350468378_173');

      // Двери 5 и 3: после победы в «Драка+батарейка» и установки батарейки
      case 'door_5':
      case 'door_3': {
        const fightDone = this.isRoomCleared('room_1792350689091_266');
        const batteryIn = this.quest.flag('socket:world_prototype:batterystand')
          || this.quest.flag('power_on')
          || this.quest.flag('battery_inserted');
        return fightDone && batteryIn;
      }

      // Двери 4 и 6: после победы в комнате Драка (зеленая)
      case 'door_4':
      case 'door_6':
        return this.isRoomCleared('room_1792351055354_265');

      // Двери 2 и 1: после решения шифра
      case 'door_2':
      case 'door_1':
        return this.quest.flag('cipher_solved');

      // Двери 11 и 12: после победы над боссом (червь)
      case 'door_11':
      case 'door_12':
        return this.isRoomCleared('room_1792351256509_106');

      // Дверь 14: после победы в комнате Драка (room_7 возле хаба)
      case 'door_14':
        return this.isRoomCleared('room_7');

      // Двери 13 и 16: после победы в «Драка+рычаги» (room_8) и решения рычагов
      case 'door_13':
      case 'door_16': {
        const fightDone = this.isRoomCleared('room_8');
        const leversDone = this.quest.flag('puzzle_steam_solved') || this.quest.flag('levers_solved');
        return fightDone && leversDone;
      }

      // Двери 17 и 18: после победы в комнате Драка (салатовая, room_9)
      case 'door_17':
      case 'door_18':
        return this.isRoomCleared('room_9');

      // Дверь 15: после победы в «Драка+провода» (room_13) и решения проводов
      case 'door_15': {
        const fightDone = this.isRoomCleared('room_13');
        const wiresDone = this.quest.flag('puzzle_wire_solved') || this.quest.flag('wires_solved');
        return fightDone && wiresDone;
      }

      // Двери 19 и 20: после победы в комнате Драка (голубая, room_12)
      case 'door_19':
      case 'door_20':
        return this.isRoomCleared('room_12');

      default:
        return true;
    }
  }
}
