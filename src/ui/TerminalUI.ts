import { EventBus } from '../core/EventBus.ts';
import { Armor, MAX_TIER, SLOTS, SLOT_NAMES, TIERS, type Slot } from '../systems/ArmorSystem.ts';
import { pal } from '../core/Palette.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

interface Theme {
  accent: string; // рамка и заголовок
  accent2: string; // акцент кнопок
  bg: string;
}

/** Цвета окна терминала по локации (стиль терминала на уровне). */
const THEMES: Record<string, Theme> = {
  loc1: { accent: hex(pal('pcb', 6)), accent2: hex(pal('void', 5)), bg: hex(pal('pcb', 0)) },
  loc2: { accent: hex(pal('cobalt', 5)), accent2: hex(pal('gold', 6)), bg: hex(pal('cobalt', 0)) }
};

/**
 * Окно терминала брони. Для каждой части (голова, туловище, руки, ноги): ступени от бронзовой до синей. Купленные можно надевать, следующую по порядку —
 * купить за металлолом (покупка сразу надевает её). «Без брони» снимает часть. Старая надетая часть отваливается (это делает игра по событию armor:changed).
 * Мир при открытом окне идёт дальше, но герой стоит и неуязвим (это обеспечивает игра).
 */
export class TerminalUI {
  private readonly root = document.createElement('div');
  private opened = false;
  private theme: Theme = THEMES.loc2;
  private hint = '';

  constructor() {
    this.root.id = 'terminal-ui';
    this.root.style.cssText = `position: fixed; top: 50%; right: 3%; transform: translateY(-50%); width: min(470px, 94vw); z-index: 1100; display: none;
      font: 13px/1.3 "Courier New", monospace; color: ${hex(pal('steel', 7))}; user-select: none;`;
    document.body.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.opened) this.close();
    });
    EventBus.get().on('armor:scrap', () => { if (this.opened) this.render(); });
    EventBus.get().on('armor:changed', () => { if (this.opened) this.render(); });
  }

  public get isOpen(): boolean {
    return this.opened;
  }

  /** style — id стиля терминала (loc1/loc2): определяет цвета окна. */
  public open(style: string): void {
    this.theme = THEMES[style] ?? THEMES.loc2;
    this.opened = true;
    this.hint = '';
    this.root.style.display = 'block';
    this.render();
  }

  public close(): void {
    this.opened = false;
    this.root.style.display = 'none';
  }

  private render(): void {
    const a = Armor.get();
    const t = this.theme;
    const btn = (slot: Slot, tier: number) => {
      const owned = a.owned[slot];
      const equipped = a.equipped[slot] === tier;
      const def = tier > 0 ? TIERS[tier - 1] : null;
      const name = def ? def.name : 'Без брони';
      let state: 'eq' | 'own' | 'buy' | 'poor' | 'lock';
      if (equipped) state = 'eq';
      else if (tier <= owned) state = 'own';
      else if (tier === owned + 1) state = a.scrap >= a.price(tier) ? 'buy' : 'poor';
      else state = 'lock';
      const price = tier > owned ? `<br><span style="opacity:.85">⚙ ${a.price(tier)}</span>` : '';
      const color = def ? def.color : hex(pal('steel', 4));
      const bg = state === 'eq' ? hex(pal('steel', 2)) : state === 'buy' ? t.bg : hex(pal('steel', 0));
      const border = state === 'eq' ? color : state === 'buy' ? t.accent2 : state === 'own' ? hex(pal('steel', 4)) : hex(pal('steel', 1));
      const opacity = state === 'lock' || state === 'poor' ? 0.5 : 1;
      const cursor = state === 'own' || state === 'buy' ? 'pointer' : 'default';
      return `<button data-slot="${slot}" data-tier="${tier}" data-state="${state}" style="
        flex: 1; min-width: 0; padding: 5px 2px 4px; font: inherit; font-size: 11px; color: ${color}; background: ${bg}; border: 2px solid ${border};
        opacity: ${opacity}; cursor: ${cursor}; text-align: center; box-shadow: ${state === 'eq' ? `inset 0 0 0 1px ${color}` : 'none'};">
        ${name}${price}</button>`;
    };

    const rows = SLOTS.map((slot) => {
      const cur = a.equipped[slot];
      const desc = cur > 0 ? a.describe(slot, cur) : 'Без брони — базовые показатели';
      const tiers = [0, ...Array.from({ length: MAX_TIER }, (_, i) => i + 1)];
      return `<div style="margin-bottom: 9px;">
        <div style="display:flex; justify-content: space-between; margin-bottom: 3px;">
          <b style="color:${t.accent}">${SLOT_NAMES[slot]}</b>
          <span style="font-size:11px; opacity:.85; text-align:right; max-width: 72%">${desc}</span>
        </div>
        <div style="display:flex; gap: 3px;">${tiers.map((tr) => btn(slot, tr)).join('')}</div>
      </div>`;
    }).join('');

    this.root.innerHTML = `<div style="background: ${hex(pal('steel', 0))}f2; border: 3px solid ${t.accent}; box-shadow: 0 0 0 2px #000, 0 0 24px ${t.accent}66; padding: 12px 14px;">
      <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom: 10px; border-bottom: 2px solid ${t.accent}55; padding-bottom: 6px;">
        <b style="color:${t.accent}; font-size: 15px; letter-spacing: 1px;">ТЕРМИНАЛ БРОНИ</b>
        <span><span style="color:${hex(pal('steel', 5))}">⚙</span> <b>${a.scrap}</b> <span style="opacity:.7">металлолом</span></span>
      </div>
      ${rows}
      <div id="term-hint" style="min-height: 15px; font-size: 11px; color: ${t.accent2}; margin: 2px 0 6px;">${this.hint}</div>
      <div style="display:flex; justify-content: space-between; font-size: 11px; opacity:.75;">
        <span>Старая часть отвалится</span><span>[E] / [Esc] — закрыть</span>
      </div>
    </div>`;

    this.root.querySelectorAll('button').forEach((b) => {
      const el = b as HTMLButtonElement;
      const slot = el.dataset.slot as Slot;
      const tier = Number(el.dataset.tier);
      el.addEventListener('mouseenter', () => {
        const hint = this.root.querySelector('#term-hint');
        if (hint) hint.textContent = tier > 0 ? `${TIERS[tier - 1].name}: ${a.describe(slot, tier)}` : 'Снять броню с этой части';
      });
      el.addEventListener('click', () => {
        const st = el.dataset.state;
        if (st === 'own') a.equip(slot, tier);
        else if (st === 'buy') a.buy(slot, tier);
        else if (st === 'poor') {
          this.hint = 'Не хватает металлолома';
          this.render();
        }
      });
    });
  }
}
