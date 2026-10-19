import { EventBus } from '../core/EventBus.ts';
import armorData from '../../data/player/armor.json';

/** Части тела, на которые надевается броня. */
export type Slot = 'head' | 'torso' | 'arms' | 'legs';
export const SLOTS: Slot[] = ['head', 'torso', 'arms', 'legs'];
export const SLOT_NAMES: Record<Slot, string> = { head: 'Голова', torso: 'Туловище', arms: 'Руки', legs: 'Ноги' };

export interface TierDef {
  id: string;
  name: string;
  color: string;
}
export const TIERS: TierDef[] = armorData.tiers;
export const MAX_TIER = TIERS.length;
/** Две модели героя: части первой — прежний герой, второй — герой второй локации (спрайт и риг). */
export const MODELS: { sprite_id: string; rig_id: string }[] = armorData.models;

/** Из какого выпавшего ресурса что падает: категория моба по имени (spider, critter, worm, mother, boss). */
export type DropKind = 'default' | 'spider' | 'critter' | 'worm' | 'mother' | 'boss';

/** Чем окончилась попытка нанести урон герою. */
export type HurtResult = 'ignored' | 'blocked' | 'hit' | 'dead';

const at = (arr: number[], tier: number, fallback: number) => (tier > 0 ? arr[Math.min(tier, arr.length) - 1] : fallback);

/**
 * Броня и живые показатели героя. Единственный ресурс — металлолом (scrap). Броня четырёх частей покупается ступенями (1 бронзовая ... 4 синяя) на терминалах;
 * купленные ступени можно переодевать. От брони зависят: ноги — двойной прыжок и скорость; руки — урон ударов, молния каждого третьего удара и луч молнии;
 * туловище — здоровье и шанс не получить урон; голова — скорость атаки и запас энергии (шкала, которую тратят снаряды и луч).
 * Все числа — в data/player/armor.json.
 */
export class Armor {
  private static instance: Armor;
  public static get(): Armor {
    if (!Armor.instance) Armor.instance = new Armor();
    return Armor.instance;
  }

  private static readonly KEY = 'ld60.armor';

  private constructor() {
    this.load();
  }

  /** Металлолом и броня переживают перезагрузку страницы (переключение уровней, отладка): хранятся в localStorage. */
  private load(): void {
    try {
      const d = JSON.parse(localStorage.getItem(Armor.KEY) ?? 'null');
      if (!d) return;
      this.scrap = Number(d.scrap) || 0;
      for (const slot of SLOTS) {
        const o = d.owned?.[slot];
        if (Array.isArray(o)) for (let i = 0; i < MAX_TIER; i++) this.owned[slot][i] = !!o[i];
        const e = Math.max(0, Math.min(MAX_TIER, Number(d.equipped?.[slot]) || 0));
        this.equipped[slot] = e === 0 || this.has(slot, e) ? e : 0;
      }
      this.hp = this.maxHp;
      this.energy = this.maxEnergy;
    } catch { /* хранилище недоступно или повреждено — начинаем с нуля */ }
  }

  private save(): void {
    try {
      localStorage.setItem(Armor.KEY, JSON.stringify({ scrap: this.scrap, owned: this.owned, equipped: this.equipped }));
    } catch { /* не сохранилось — не страшно */ }
  }

  public scrap = 0;
  /** Что куплено: по части — для каждой модели (индекс 0 — модель 1, 1 — модель 2). */
  public readonly owned: Record<Slot, boolean[]> = {
    head: new Array<boolean>(MAX_TIER).fill(false), torso: new Array<boolean>(MAX_TIER).fill(false),
    arms: new Array<boolean>(MAX_TIER).fill(false), legs: new Array<boolean>(MAX_TIER).fill(false)
  };
  /** Надетая модель по части: 0 — голое шасси, 1 — часть первой модели, 2 — второй. */
  public readonly equipped: Record<Slot, number> = { head: 0, torso: 0, arms: 0, legs: 0 };
  public hp = armorData.base.max_hp;
  public energy = armorData.base.max_energy;
  /** Герой неуязвим (например, пока открыт терминал). */
  public invulnerable = false;
  /** Оставшаяся неуязвимость после попадания, с. */
  public hurtTimer = 0;
  /** Время с последней нехватки энергии, с — шкала на экране коротко мигает. */
  public denyTimer = 0;

  // ---- Покупка и ношение

  public price(tier: number): number {
    return armorData.price[tier - 1] ?? 9999;
  }

  public has(slot: Slot, tier: number): boolean {
    return tier >= 1 && tier <= MAX_TIER && this.owned[slot][tier - 1];
  }

  /** Часть этой модели можно купить сейчас: ещё не куплена и хватает металлолома. */
  public canBuy(slot: Slot, tier: number): boolean {
    return tier >= 1 && tier <= MAX_TIER && !this.has(slot, tier) && this.scrap >= this.price(tier);
  }

  public buy(slot: Slot, tier: number): boolean {
    if (!this.canBuy(slot, tier)) return false;
    this.scrap -= this.price(tier);
    this.owned[slot][tier - 1] = true;
    this.equip(slot, tier);
    this.save();
    EventBus.get().emit('armor:scrap', this.scrap);
    return true;
  }

  /** Надеть купленную часть модели tier (0 — голое шасси). Прежняя надетая часть отваливается (событие armor:changed). */
  public equip(slot: Slot, tier: number): boolean {
    if (tier < 0 || tier > MAX_TIER || (tier > 0 && !this.has(slot, tier)) || tier === this.equipped[slot]) return false;
    const before = this.maxHp;
    const from = this.equipped[slot];
    this.equipped[slot] = tier;
    const delta = this.maxHp - before;
    this.hp = Math.max(1, Math.min(this.maxHp, this.hp + Math.max(0, delta)));
    this.energy = Math.min(this.energy, this.maxEnergy);
    EventBus.get().emit('armor:changed', { slot, from, to: tier });
    this.save();
    return true;
  }

  /** Герой приходит на уровень в частях модели tier: они выдаются и надеваются на все части, где надето что-то слабее (надетое лучше не трогается). */
  public grantTier(tier: number): void {
    const t = Math.min(MAX_TIER, Math.max(0, tier));
    if (t <= 0) return;
    for (const slot of SLOTS) {
      this.owned[slot][t - 1] = true;
      if (this.equipped[slot] < t) this.equipped[slot] = t;
    }
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.save();
  }

  public addScrap(n: number): void {
    this.scrap += n;
    this.save();
    EventBus.get().emit('armor:scrap', this.scrap);
  }

  /** Сколько металлолома выпадает с моба этого вида (случайное целое в диапазоне). */
  public dropAmount(kind: DropKind): number {
    const [lo, hi] = (armorData.scrap_drop as Record<string, number[]>)[kind] ?? armorData.scrap_drop.default;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // ---- Здоровье

  public get maxHp(): number {
    return at(armorData.torso.max_hp, this.equipped.torso, armorData.base.max_hp);
  }

  public get blockChance(): number {
    return at(armorData.torso.block_chance, this.equipped.torso, 0);
  }

  /** Урон герою: неуязвимость, шанс не засчитать урон, затем здоровье. */
  public hurt(amount: number): HurtResult {
    if (this.invulnerable || this.hurtTimer > 0 || this.hp <= 0) return 'ignored';
    if (Math.random() < this.blockChance) {
      this.hurtTimer = 0.25;
      return 'blocked';
    }
    this.hp = Math.max(0, this.hp - amount);
    this.hurtTimer = armorData.hurt_invuln;
    return this.hp <= 0 ? 'dead' : 'hit';
  }

  public revive(): void {
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.hurtTimer = 1.2;
  }

  /** Погиб: часть металлолома пропадает. */
  public loseScrapOnDeath(): void {
    this.scrap = Math.floor(this.scrap * (1 - armorData.respawn_scrap_loss));
    this.save();
    EventBus.get().emit('armor:scrap', this.scrap);
  }

  // ---- Энергия (шкала снарядов и луча)

  public get maxEnergy(): number {
    return armorData.base.max_energy + at(armorData.head.energy_bonus, this.equipped.head, 0);
  }

  public get energyRegen(): number {
    return armorData.base.energy_regen + at(armorData.head.regen_bonus, this.equipped.head, 0);
  }

  public get gearCost(): number {
    return armorData.base.gear_cost;
  }

  public canSpend(n: number): boolean {
    return this.energy >= n;
  }

  /** Потратить энергию; при нехватке — false и шкала коротко мигает. */
  public spend(n: number): boolean {
    if (this.energy < n) {
      this.denyTimer = 0.35;
      return false;
    }
    this.energy -= n;
    return true;
  }

  public update(dt: number): void {
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.denyTimer = Math.max(0, this.denyTimer - dt);
    this.energy = Math.min(this.maxEnergy, this.energy + this.energyRegen * dt);
  }

  // ---- Эффекты брони

  /** Скорость атаки: множитель перезарядки ударов и бросков (меньше — быстрее). */
  public get attackCooldownMult(): number {
    return at(armorData.head.attack_speed, this.equipped.head, 1);
  }

  public get airJumps(): number {
    return at(armorData.legs.air_jumps, this.equipped.legs, armorData.base.air_jumps);
  }

  public get speedMult(): number {
    return at(armorData.legs.speed, this.equipped.legs, 1);
  }

  public get punchMult(): number {
    return at(armorData.arms.punch_mult, this.equipped.arms, 1);
  }

  /** Руки с бронёй: каждый N-й удар сопровождается вспышкой молнии, ПКМ — луч молнии. */
  public get hasLightning(): boolean {
    return this.equipped.arms > 0;
  }

  public get flashEvery(): number {
    return armorData.arms.flash_every;
  }

  public get flashMult(): number {
    return at(armorData.arms.flash_mult, this.equipped.arms, 1);
  }

  public get flashTargets(): number {
    return at(armorData.arms.flash_targets, this.equipped.arms, 0);
  }

  public get flashRadius(): number {
    return armorData.arms.flash_radius;
  }

  public get beamDps(): number {
    return at(armorData.arms.beam_dps, this.equipped.arms, 0);
  }

  public get beamCost(): number {
    return at(armorData.arms.beam_cost, this.equipped.arms, 0);
  }

  public get beamBounces(): number {
    return at(armorData.arms.beam_bounces, this.equipped.arms, 0);
  }

  public get beamLength(): number {
    return at(armorData.arms.beam_length, this.equipped.arms, 0);
  }

  public get debrisLife(): number {
    return armorData.debris_life;
  }

  /** Короткое описание действия ступени части — для терминала. */
  public describe(slot: Slot, tier: number): string {
    const a = armorData;
    const i = tier - 1;
    switch (slot) {
      case 'head':
        return `Атака быстрее на ${Math.round((1 - a.head.attack_speed[i]) * 100)}%, шкала энергии +${a.head.energy_bonus[i]}, восстановление +${a.head.regen_bonus[i]}/с`;
      case 'torso':
        return `Здоровье ${a.torso.max_hp[i]}, ${Math.round(a.torso.block_chance[i] * 100)}% шанс не получить урон`;
      case 'arms':
        return `Удар ×${a.arms.punch_mult[i]}, молния каждого ${a.arms.flash_every}-го удара (цепь на ${a.arms.flash_targets[i]}), ПКМ — луч молнии с ${a.arms.beam_bounces[i]} отскоками`;
      case 'legs':
        return `${a.legs.air_jumps[i] === 1 ? 'Двойной' : 'Тройной'} прыжок, скорость ×${a.legs.speed[i]}`;
    }
  }
}
