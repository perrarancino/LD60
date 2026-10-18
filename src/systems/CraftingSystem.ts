import { EventBus } from '../core/EventBus.ts';

export type MaterialType = 'scrap' | 'wires' | 'discParts';
export type BodyPartSlot = 'head' | 'torso' | 'arms' | 'legs';
export type ModuleType = 'standard' | 'wire' | 'disc';

export interface PartConfig {
  slot: BodyPartSlot;
  type: ModuleType;
  level: number; // 0 = не собрано, 1, 2, 3
}

export const MATERIAL_NAMES: Record<MaterialType, string> = {
  scrap: 'Мусор',
  wires: 'Провода',
  discParts: 'Части диска'
};

export const MATERIAL_ICONS: Record<MaterialType, string> = {
  scrap: 'mat_scrap',
  wires: 'mat_wire',
  discParts: 'mat_disc'
};

export const SLOT_NAMES: Record<BodyPartSlot, string> = {
  head: 'Голова',
  torso: 'Туловище',
  arms: 'Руки',
  legs: 'Ноги'
};

export const MODULE_NAMES: Record<ModuleType, string> = {
  standard: 'Стандартный (Мусор)',
  wire: 'Проводной (Провода)',
  disc: 'Дисковый (Части диска)'
};

export const LEVEL_COSTS: Record<number, number> = {
  1: 3,
  2: 7,
  3: 12
};

export class CraftingSystem {
  private static instance: CraftingSystem;

  public materials: Record<MaterialType, number> = {
    scrap: 0,
    wires: 0,
    discParts: 0
  };

  /** Собрана ли копия в хабе: 4 детали (голова, туловище, руки, ноги) */
  public copyParts: Record<BodyPartSlot, PartConfig> = {
    head: { slot: 'head', type: 'standard', level: 0 },
    torso: { slot: 'torso', type: 'standard', level: 0 },
    arms: { slot: 'arms', type: 'standard', level: 0 },
    legs: { slot: 'legs', type: 'standard', level: 0 }
  };

  /** Текущие активные детали робота игрока */
  public activeParts: Record<BodyPartSlot, PartConfig> = {
    head: { slot: 'head', type: 'standard', level: 1 },
    torso: { slot: 'torso', type: 'standard', level: 1 },
    arms: { slot: 'arms', type: 'standard', level: 1 }, // стандартная рука ур1 бросает шестеренку bullet1
    legs: { slot: 'legs', type: 'standard', level: 1 }
  };

  public static get(): CraftingSystem {
    if (!CraftingSystem.instance) {
      CraftingSystem.instance = new CraftingSystem();
    }
    return CraftingSystem.instance;
  }

  public addMaterial(type: MaterialType, amount = 1): void {
    this.materials[type] += amount;
    EventBus.get().emit('crafting:materials_updated', { ...this.materials });
  }

  public getMaterialForModule(mod: ModuleType): MaterialType {
    switch (mod) {
      case 'standard': return 'scrap';
      case 'wire': return 'wires';
      case 'disc': return 'discParts';
    }
  }

  public getCostForLevel(level: number): number {
    return LEVEL_COSTS[level] ?? 999;
  }

  /**
   * Собрать или улучшить деталь в копии хаба
   */
  public craftOrUpgradePart(slot: BodyPartSlot, targetType: ModuleType): boolean {
    const part = this.copyParts[slot];
    const matType = this.getMaterialForModule(targetType);

    // Если меняется тип или деталь еще не собрана
    const targetLevel = (part.level === 0 || part.type !== targetType) ? 1 : part.level + 1;
    if (targetLevel > 3) return false;

    const cost = this.getCostForLevel(targetLevel);
    if (this.materials[matType] < cost) return false;

    this.materials[matType] -= cost;
    this.copyParts[slot] = {
      slot,
      type: targetType,
      level: targetLevel
    };

    EventBus.get().emit('crafting:part_crafted', { slot, part: this.copyParts[slot] });
    EventBus.get().emit('crafting:materials_updated', { ...this.materials });
    return true;
  }

  /**
   * Можно ли переродиться: нужно собрать все 4 детали (голова, туловище, руки, ноги)
   */
  public canRebuild(): boolean {
    return (
      this.copyParts.head.level >= 1 &&
      this.copyParts.torso.level >= 1 &&
      this.copyParts.arms.level >= 1 &&
      this.copyParts.legs.level >= 1
    );
  }

  public getAssembledPartsCount(): number {
    let count = 0;
    if (this.copyParts.head.level >= 1) count++;
    if (this.copyParts.torso.level >= 1) count++;
    if (this.copyParts.arms.level >= 1) count++;
    if (this.copyParts.legs.level >= 1) count++;
    return count;
  }

  /**
   * Перерождение: сознание переносится в собранную копию
   */
  public performRebuild(): boolean {
    if (!this.canRebuild()) return false;

    // Переносим собранные части в активные
    this.activeParts = {
      head: { ...this.copyParts.head },
      torso: { ...this.copyParts.torso },
      arms: { ...this.copyParts.arms },
      legs: { ...this.copyParts.legs }
    };

    // Сбрасываем верстак копии для следующего 5-минутного цикла
    this.copyParts = {
      head: { slot: 'head', type: 'standard', level: 0 },
      torso: { slot: 'torso', type: 'standard', level: 0 },
      arms: { slot: 'arms', type: 'standard', level: 0 },
      legs: { slot: 'legs', type: 'standard', level: 0 }
    };

    EventBus.get().emit('crafting:rebuild_completed', { activeParts: this.activeParts });
    return true;
  }

  /**
   * Текстовое описание спец-способности руки на ПКМ
   */
  public getArmAbilityDescription(type: ModuleType, level: number): string {
    if (type === 'standard') {
      if (level <= 1) return 'кидает шестеренку';
      if (level === 2) return 'может кидать 2 шестеренки подряд';
      return 'может кидать 3 шестеренки подряд';
    }
    if (type === 'wire') {
      if (level <= 1) return 'бьет током на расстоянии';
      if (level === 2) return 'бьет током на большем расстоянии, отскакивает от стен';
      return 'бьет током на еще большем расстоянии, еще чаще отскакивает от стен';
    }
    if (type === 'disc') {
      if (level <= 1) return 'притягивает противников и слегка режет';
      if (level === 2) return 'притягивает противников, сильнее режет и после отталкивает противников';
      return 'притягивает противников, сильнее режет и после отталкивает противников при этом нанося урон';
    }
    return '';
  }

  /**
   * Способности шасси (ног)
   */
  public getLegsAbilityDescription(type: ModuleType, level: number): string {
    if (type === 'standard') {
      if (level <= 1) return 'просто бег';
      if (level === 2) return 'слегка быстрее';
      return 'быстрее';
    }
    if (type === 'wire') {
      if (level <= 1) return 'высокий прыжок';
      if (level === 2) return 'двойной прыжок';
      return 'тройной прыжок';
    }
    if (type === 'disc') {
      if (level <= 1) return 'быстрый бег, невосприимчивость к напольным ловушкам';
      if (level === 2) return 'очень быстрый бег, невосприимчивость к напольным ловушкам';
      return 'очень быстрый бег, невосприимчивость к напольным ловушкам, урон противникам при столкновении на скорости';
    }
    return '';
  }

  /**
   * Способности туловища (корпуса)
   */
  public getTorsoAbilityDescription(type: ModuleType, level: number): string {
    if (type === 'standard') {
      if (level <= 1) return 'обычное хп';
      if (level === 2) return 'слегка увеличенное';
      return 'увеличенное';
    }
    if (type === 'wire') {
      if (level <= 1) return 'слегка меньше хп, маленький шанс на промах по игроку';
      if (level === 2) return 'слегка меньше хп, шанс на промах по игроку';
      return 'обычное хп, высокий шанс на промах по игроку';
    }
    if (type === 'disc') {
      if (level <= 1) return 'слегка меньше хп, маленький шанс на рикошет в противника';
      if (level === 2) return 'слегка меньше хп, шанс на рикошет в противника';
      return 'обычное хп, высокий шанс на рикошет в противника';
    }
    return '';
  }

  /**
   * Способности головы (сенсоров / процессора)
   */
  public getHeadAbilityDescription(type: ModuleType, level: number): string {
    if (type === 'standard') {
      if (level <= 1) return 'обычный таймер старения (5 мин)';
      if (level === 2) return 'слегка увеличенный таймер старения (6 мин)';
      return 'увеличенный таймер старения (7.5 мин)';
    }
    if (type === 'wire') {
      if (level <= 1) return 'уменьшеный таймер старения (4 мин), увеличивает скорость атаки';
      if (level === 2) return 'уменьшеный таймер старения (4.5 мин), сильнее увеличивает скорость атаки';
      return 'стандартный таймер старения (5 мин), очень быстрая скорость атаки';
    }
    if (type === 'disc') {
      if (level <= 1) return 'уменьшеный таймер старения (4 мин), шанс к криту';
      if (level === 2) return 'уменьшеный таймер старения (4.5 мин), большой шанс к криту';
      return 'стандартный таймер старения (5 мин), очень большой шанс к криту';
    }
    return '';
  }

  /**
   * Получить описание для любого слота
   */
  public getPartDescription(slot: BodyPartSlot, type: ModuleType, level: number): string {
    const lvl = Math.max(1, level);
    switch (slot) {
      case 'arms': return this.getArmAbilityDescription(type, lvl);
      case 'legs': return this.getLegsAbilityDescription(type, lvl);
      case 'torso': return this.getTorsoAbilityDescription(type, lvl);
      case 'head': return this.getHeadAbilityDescription(type, lvl);
    }
  }

  /** Длительность таймера энергоядра в секундах по текущей голове */
  public getAgingTimerSeconds(): number {
    const head = this.activeParts.head;
    if (head.type === 'standard') {
      if (head.level <= 1) return 300; // 5 мин
      if (head.level === 2) return 360; // 6 мин
      return 450; // 7.5 мин
    }
    if (head.type === 'wire' || head.type === 'disc') {
      if (head.level <= 1) return 240; // 4 мин
      if (head.level === 2) return 270; // 4.5 мин
      return 300; // 5 мин
    }
    return 300;
  }

  /** Множитель перезарядки атак (меньше = быстрее атака) по текущей голове */
  public getAttackSpeedMultiplier(): number {
    const head = this.activeParts.head;
    if (head.type === 'wire') {
      if (head.level <= 1) return 0.8;
      if (head.level === 2) return 0.65;
      return 0.5;
    }
    return 1.0;
  }

  /** Дополнительный шанс к критическому удару (0..1) по текущей голове */
  public getCritChanceBonus(): number {
    const head = this.activeParts.head;
    if (head.type === 'disc') {
      if (head.level <= 1) return 0.15;
      if (head.level === 2) return 0.30;
      return 0.50;
    }
    return 0.0;
  }

  /** Множитель скорости бега по текущим ногам */
  public getSpeedMultiplier(): number {
    const legs = this.activeParts.legs;
    if (legs.type === 'standard') {
      if (legs.level <= 1) return 1.0;
      if (legs.level === 2) return 1.2;
      return 1.4;
    }
    if (legs.type === 'disc') {
      if (legs.level <= 1) return 1.3;
      if (legs.level === 2) return 1.55;
      return 1.55;
    }
    return 1.0;
  }

  /** Множитель силы прыжка по текущим ногам */
  public getJumpForceMultiplier(): number {
    const legs = this.activeParts.legs;
    if (legs.type === 'wire') {
      if (legs.level === 1) return 1.25; // высокий прыжок
      return 1.05;
    }
    return 1.0;
  }

  /** Дополнительные прыжки в воздухе (двойной / тройной прыжок) */
  public getAirJumpsCount(): number {
    const legs = this.activeParts.legs;
    if (legs.type === 'wire') {
      if (legs.level === 2) return 1; // двойной прыжок
      if (legs.level >= 3) return 2; // тройной прыжок
    }
    return 0;
  }

  /** Невосприимчивость к напольным ловушкам (дисковые ноги) */
  public hasHazardImmunity(): boolean {
    const legs = this.activeParts.legs;
    return legs.type === 'disc' && legs.level >= 1;
  }

  /** Урон противникам при столкновении на скорости (дисковые ноги ур3) */
  public hasSpeedCollisionDamage(): boolean {
    const legs = this.activeParts.legs;
    return legs.type === 'disc' && legs.level >= 3;
  }

  /** Максимальное здоровье по текущему туловищу */
  public getMaxHp(): number {
    const torso = this.activeParts.torso;
    if (torso.type === 'standard') {
      if (torso.level <= 1) return 100;
      if (torso.level === 2) return 125;
      return 160;
    }
    if (torso.type === 'wire' || torso.type === 'disc') {
      if (torso.level <= 2) return 85;
      return 100;
    }
    return 100;
  }

  /** Шанс на промах по игроку (уклонение) по текущему проводному туловищу */
  public getDodgeChance(): number {
    const torso = this.activeParts.torso;
    if (torso.type === 'wire') {
      if (torso.level <= 1) return 0.15;
      if (torso.level === 2) return 0.30;
      return 0.45;
    }
    return 0.0;
  }

  /** Шанс на рикошет в противника (отражение урона) по текущему дисковому туловищу */
  public getRicochetChance(): number {
    const torso = this.activeParts.torso;
    if (torso.type === 'disc') {
      if (torso.level <= 1) return 0.15;
      if (torso.level === 2) return 0.30;
      return 0.45;
    }
    return 0.0;
  }
}
