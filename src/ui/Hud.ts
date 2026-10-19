import { EventBus } from '../core/EventBus.ts';
import { Armor } from '../systems/ArmorSystem.ts';
import { pal } from '../core/Palette.ts';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/**
 * Показатели героя в левом нижнем углу (обычные HTML-элементы поверх холста): полоса здоровья, полоса энергии (шкала снарядов и луча) и металлолом.
 * Длина полос растёт с бронёй: больше здоровья туловища и энергии головы — длиннее полоса. При попадании экран коротко вспыхивает красным,
 * при нехватке энергии шкала мигает.
 */
export class Hud {
  private readonly root = document.createElement('div');
  private readonly hpFill = document.createElement('div');
  private readonly hpBar = document.createElement('div');
  private readonly enFill = document.createElement('div');
  private readonly enBar = document.createElement('div');
  private readonly scrap = document.createElement('span');
  private readonly hurt = document.createElement('div');
  private lastHp = -1;
  private lastEn = -1;
  private lastHpMax = -1;
  private lastEnMax = -1;
  private lastScrap = -1;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #hud { position: fixed; left: 14px; bottom: 14px; z-index: 900; pointer-events: none; display: flex; flex-direction: column; gap: 6px;
        font: 13px/1 "Courier New", monospace; color: ${hex(pal('steel', 7))}; text-shadow: 1px 1px 0 #000; }
      #hud .bar { height: 12px; border: 2px solid ${hex(pal('steel', 3))}; background: ${hex(pal('steel', 0))}; position: relative;
        box-shadow: 0 0 0 1px #000; image-rendering: pixelated; }
      #hud .fill { height: 100%; transition: width 0.08s linear; }
      #hud .ticks { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 13px, rgba(0,0,0,0.45) 13px 14px); }
      #hud .hp .fill { background: linear-gradient(${hex(pal('ember', 5))}, ${hex(pal('ember', 4))} 60%, ${hex(pal('ember', 3))}); }
      #hud .en .fill { background: linear-gradient(${hex(pal('gold', 7))}, ${hex(pal('gold', 6))} 60%, ${hex(pal('gold', 4))}); }
      #hud .deny { border-color: ${hex(pal('ember', 4))} !important; animation: hud-shake 0.12s 2; }
      @keyframes hud-shake { 0%,100% { transform: translateX(0); } 50% { transform: translateX(3px); } }
      #hud .scrap { display: flex; align-items: center; gap: 6px; }
      #hud .scrap i { width: 11px; height: 11px; background: ${hex(pal('steel', 4))}; border: 2px solid ${hex(pal('steel', 6))};
        box-shadow: inset -2px -2px 0 ${hex(pal('steel', 2))}; display: inline-block; }
      #hurt-flash { position: fixed; inset: 0; z-index: 890; pointer-events: none; opacity: 0; transition: opacity 0.28s ease-out;
        box-shadow: inset 0 0 90px 24px ${hex(pal('ember', 4))}; }
      #hurt-flash.on { opacity: 0.55; transition: none; }
    `;
    document.head.appendChild(style);
    this.root.id = 'hud';
    this.hpBar.className = 'bar hp';
    this.hpBar.append(this.hpFill, this.ticks());
    this.hpFill.className = 'fill';
    this.enBar.className = 'bar en';
    this.enBar.append(this.enFill, this.ticks());
    this.enFill.className = 'fill';
    const scrapRow = document.createElement('div');
    scrapRow.className = 'scrap';
    scrapRow.append(document.createElement('i'), this.scrap);
    this.root.append(this.hpBar, this.enBar, scrapRow);
    document.body.appendChild(this.root);
    this.hurt.id = 'hurt-flash';
    document.body.appendChild(this.hurt);
    EventBus.get().on('armor:scrap', () => this.update());
  }

  private ticks(): HTMLElement {
    const t = document.createElement('div');
    t.className = 'ticks';
    return t;
  }

  /** Красная вспышка по краям экрана (получен урон). */
  public flashHurt(): void {
    this.hurt.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => this.hurt.classList.remove('on')));
  }

  public update(): void {
    const a = Armor.get();
    const hp = Math.ceil(a.hp);
    const en = Math.floor(a.energy);
    if (a.maxHp !== this.lastHpMax) {
      this.lastHpMax = a.maxHp;
      this.hpBar.style.width = `${a.maxHp * 1.4}px`;
    }
    if (a.maxEnergy !== this.lastEnMax) {
      this.lastEnMax = a.maxEnergy;
      this.enBar.style.width = `${a.maxEnergy * 1.4}px`;
    }
    if (hp !== this.lastHp) {
      this.lastHp = hp;
      this.hpFill.style.width = `${(a.hp / a.maxHp) * 100}%`;
    }
    if (en !== this.lastEn) {
      this.lastEn = en;
      this.enFill.style.width = `${(a.energy / a.maxEnergy) * 100}%`;
    }
    if (a.scrap !== this.lastScrap) {
      this.lastScrap = a.scrap;
      this.scrap.textContent = String(a.scrap);
    }
    this.enBar.classList.toggle('deny', a.denyTimer > 0);
  }
}
