import { Armor, MAX_LEVEL, SLOTS, SLOT_NAMES } from '../systems/ArmorSystem.ts';
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
 * Окно прокачки перед боссом: четыре части тела (голова, туловище, руки, ноги), у каждой — уровни кубиками, что даст следующий и сколько стоит шестерёнок.
 * Можно прокачать несколько частей, пока хватает шестерёнок; «Дальше» (Enter / пробел) закрывает окно. Мир при открытом окне стоит.
 */
export class UpgradeUI {
  private readonly root = document.createElement('div');
  private opened = false;
  private onClose: (() => void) | null = null;
  private hint = '';

  constructor() {
    this.root.id = 'upgrade-ui';
    this.root.style.cssText = `position: fixed; inset: 0; z-index: 2500; display: none; align-items: center; justify-content: center; background: rgba(2,6,10,0.72);
      font: 13px/1.3 "Courier New", monospace; color: ${hex(pal('steel', 7))}; user-select: none;`;
    document.body.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (!this.opened) return;
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this.close();
      }
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < SLOTS.length) this.buy(SLOTS[idx]);
    });
  }

  public get isOpen(): boolean {
    return this.opened;
  }

  public open(onClose: () => void): void {
    this.opened = true;
    this.onClose = onClose;
    this.hint = '';
    this.root.style.display = 'flex';
    this.render();
  }

  private close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.style.display = 'none';
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private buy(slot: Slot): void {
    const a = Armor.get();
    if (a.upgradeCost(slot) === null) return;
    if (!a.upgrade(slot)) this.hint = 'Не хватает шестерёнок';
    else this.hint = '';
    this.render();
  }

  private render(): void {
    const a = Armor.get();
    const gold = hex(pal('gold', 6));
    const cards = SLOTS.map((slot, i) => {
      const lvl = a.lvl[slot];
      const cost = a.upgradeCost(slot);
      const can = a.canUpgrade(slot);
      const pips = Array.from({ length: MAX_LEVEL }, (_, k) => `<i style="display:inline-block;width:12px;height:12px;margin:0 2px;border:2px solid ${k < lvl ? gold : hex(pal('steel', 2))};background:${k < lvl ? hex(pal('gold', 5)) : 'transparent'}"></i>`).join('');
      const border = cost === null ? hex(pal('steel', 2)) : can ? gold : hex(pal('steel', 3));
      return `<button data-slot="${slot}" style="flex:1; min-width:150px; padding:14px 10px 12px; font:inherit; color:inherit; background:${hex(pal('steel', 0))}f2; border:3px solid ${border};
        cursor:${cost !== null ? 'pointer' : 'default'}; opacity:${cost === null || can ? 1 : 0.6}; text-align:center; box-shadow:${can ? `0 0 18px ${gold}55` : 'none'};">
        <svg viewBox="0 0 12 12" width="60" height="60" style="image-rendering:pixelated; fill:${cost === null ? hex(pal('gold', 5)) : hex(pal('steel', 6))}; shape-rendering:crispEdges">${ICONS[slot]}</svg>
        <div style="font-size:16px; margin:6px 0 2px; color:${gold}"><b>${i + 1}</b> ${SLOT_NAMES[slot]}</div>
        <div style="margin:6px 0">${pips}</div>
        <div style="min-height:52px; font-size:12px; opacity:.9">${a.describeUpgrade(slot)}</div>
        <div style="margin-top:8px; font-size:15px; color:${can || cost === null ? gold : hex(pal('ember', 5))}">${cost === null ? 'МАКС' : `⚙ ${cost}`}</div>
      </button>`;
    }).join('');
    this.root.innerHTML = `<div style="width:min(760px,94vw); border:3px solid ${gold}; background:${hex(pal('steel', 0))}f7; box-shadow:0 0 0 2px #000, 0 0 40px ${gold}44; padding:16px 18px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid ${gold}55;">
        <b style="color:${gold}; font-size:17px; letter-spacing:2px">ПЕРЕД БОССОМ: ПРОКАЧКА</b>
        <span style="font-size:17px">⚙ <b>${a.scrap}</b></span>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">${cards}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
        <span style="min-height:16px; color:${hex(pal('ember', 5))}">${this.hint}</span>
        <button id="upgrade-go" style="font:inherit; font-size:15px; color:#05070b; background:${gold}; border:none; padding:8px 22px; cursor:pointer; letter-spacing:1px"><b>ДАЛЬШЕ</b> [Enter]</button>
      </div>
    </div>`;
    this.root.querySelectorAll('button[data-slot]').forEach((b) => b.addEventListener('click', () => this.buy((b as HTMLButtonElement).dataset.slot as Slot)));
    this.root.querySelector('#upgrade-go')?.addEventListener('click', () => this.close());
  }
}
