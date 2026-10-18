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
  disc: 'Дисковый (Вентилятор)'
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
      if (level <= 1) return 'Кидает 1 шестерёнку (bullet1)';
      if (level === 2) return 'Кидает 2 шестерёнки подряд';
      return 'Кидает 3 шестерёнки подряд';
    }
    if (type === 'wire') {
      if (level <= 1) return 'Бьёт током на дистанции';
      if (level === 2) return 'Бьёт током дальше и рикошетит от стен';
      return 'Бьёт током далеко и чаще рикошетит от стен';
    }
    if (type === 'disc') {
      if (level <= 1) return 'Втягивает врагов в вихрь и слегка режет';
      if (level === 2) return 'Сильнее втягивает, режет и отталкивает';
      return 'Сильнейший вихрь, мощная резка и взрывное отталкивание с уроном';
    }
    return '';
  }
}
