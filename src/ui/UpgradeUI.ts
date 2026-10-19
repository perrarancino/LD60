import { Armor, SLOTS, SLOT_NAMES } from '../systems/ArmorSystem.ts';
import type { Slot } from '../systems/ArmorSystem.ts';
import { pal } from '../core/Palette.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Значок части тела пиксельными прямоугольниками (viewBox 12x12). */
const ICONS: Record<Slot, string> = {
  head: '<rect x="3" y="1" width="6" height="6"/><rect x="2" y="3" width="1" height="3"/><rect x="9" y="3" width="1" height="3"/><rect x="4" y="8" width="4" height="2"/><rect x="5" y="0" width="2" height="1"/>',
  torso: '<rect x="2" y="1" width="8" height="7"/><rect x="4" y="8" width="4" height="3"/><rect x="0" y="2" width="2" height="5"/><rect x="10" y="2" width="2" height="5"/>',
  arms: '<rect x="1" y="3" width="4" height="2"/><rect x="5" y="2" width="3" height="4"/><rect x="8" y="1" width="3" height="6"/><rect x="2" y="7" width="3" height="2"/>',
  legs: '<rect x="2" y="0" width="3" height="7"/><rect x="7" y="0" width="3" height="7"/><rect x="1" y="7" width="4" height="3"/><rect x="7" y="7" width="5" height="3"/>'
};

/**
 * Улучшение части тела: четыре карточки (голова, туловище, руки, ноги) — что делает часть и что даст синяя. Выбираешь одну — она сразу становится синей,
 * окно закрывается. Ничего не покупается. Мир при открытом окне стоит.
 */
export class UpgradeUI {
  private readonly root = document.createElement('div');
  private opened = false;
  private onClose: (() => void) | null = null;

  constructor() {
    this.root.id = 'upgrade-ui';
    this.root.style.cssText = `position: fixed; inset: 0; z-index: 2500; display: none; align-items: center; justify-content: center; background: rgba(2,6,10,0.78);
      font: 14px/1.35 "Courier New", monospace; color: ${hex(pal('steel', 7))}; user-select: none;`;
    document.body.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (!this.opened) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < SLOTS.length) this.pick(SLOTS[idx]);
    });
  }

  public get isOpen(): boolean {
    return this.opened;
  }

  /** Есть ли что улучшать (хоть одна часть ещё медная). */
  public static available(): boolean {
    return SLOTS.some((s) => Armor.get().canUpgrade(s));
  }

  public open(onClose: () => void): void {
    this.opened = true;
    this.onClose = onClose;
    this.root.style.display = 'flex';
    this.render();
  }

  private pick(slot: Slot): void {
    if (!this.opened || !Armor.get().upgrade(slot)) return;
    this.opened = false;
    this.root.style.display = 'none';
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private render(): void {
    const a = Armor.get();
    const copper = hex(pal('gold', 5));
    const blue = hex(pal('cobalt', 5));
    const cards = SLOTS.map((slot, i) => {
      const can = a.canUpgrade(slot);
      return `<button data-slot="${slot}" ${can ? '' : 'disabled'} style="flex:1; min-width:150px; padding:14px 10px 12px; font:inherit; color:inherit; background:${hex(pal('steel', 0))}f2;
        border:3px solid ${can ? copper : hex(pal('steel', 2))}; cursor:${can ? 'pointer' : 'default'}; opacity:${can ? 1 : 0.5}; text-align:center;">
        <svg viewBox="0 0 12 12" width="56" height="56" style="shape-rendering:crispEdges; fill:${can ? copper : blue}">${ICONS[slot]}</svg>
        <div style="font-size:17px; margin:6px 0 8px; color:${can ? copper : blue}"><b>${i + 1}</b> ${SLOT_NAMES[slot]}</div>
        <div style="font-size:12px; opacity:.85; min-height:48px">${Armor.purpose(slot)}</div>
        <div style="margin-top:8px; font-size:12px; color:${can ? blue : hex(pal('steel', 5))}; min-height:64px">${can ? `Станет синей:<br>${a.describe(slot, 2)}` : 'Уже синяя'}</div>
      </button>`;
    }).join('');
    this.root.innerHTML = `<div style="width:min(780px,94vw); border:3px solid ${copper}; background:${hex(pal('steel', 0))}f7; padding:16px 18px 18px;">
      <div style="text-align:center; margin-bottom:14px; font-size:18px; color:${copper}"><b>Выбери часть для улучшения</b></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">${cards}</div>
    </div>`;
    this.root.querySelectorAll('button[data-slot]').forEach((b) => b.addEventListener('click', () => this.pick((b as HTMLButtonElement).dataset.slot as Slot)));
  }
}
