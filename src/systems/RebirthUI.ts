import { EventBus } from '../core/EventBus.ts';
import {
  CraftingSystem,
  MATERIAL_NAMES,
  SLOT_NAMES,
  MODULE_NAMES,
  type BodyPartSlot,
  type ModuleType
} from './CraftingSystem.ts';
import type { AgingState } from './AgingSystem.ts';

export class RebirthUI {
  private container: HTMLElement;
  private topBar: HTMLElement;
  private modal: HTMLElement;
  private alertBanner: HTMLElement;

  private isModalOpen = false;
  private lastTimeRemaining = 300;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'rebirth-ui-root';
    this.container.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      font-family: 'Courier New', Courier, monospace;
      color: #e2e8f0;
      z-index: 1000;
      user-select: none;
    `;
    document.body.appendChild(this.container);

    // Верхняя панель (HUD)
    this.topBar = document.createElement('div');
    this.topBar.id = 'rebirth-top-bar';
    this.topBar.style.cssText = `
      position: absolute;
      top: 10px;
      left: 12px;
      right: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(15, 23, 42, 0.78);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 13px;
      pointer-events: auto;
      backdrop-filter: blur(4px);
    `;
    this.container.appendChild(this.topBar);

    // Модальное окно верстака сборки копии
    this.modal = document.createElement('div');
    this.modal.id = 'rebirth-modal';
    this.modal.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 640px;
      max-width: 95vw;
      background: rgba(13, 17, 23, 0.95);
      border: 2px solid #38bdf8;
      box-shadow: 0 0 25px rgba(56, 189, 248, 0.35);
      border-radius: 8px;
      padding: 18px 22px;
      display: none;
      pointer-events: auto;
      flex-direction: column;
      gap: 14px;
    `;
    this.container.appendChild(this.modal);

    // Баннер уведомлений о перерождении
    this.alertBanner = document.createElement('div');
    this.alertBanner.id = 'rebirth-alert';
    this.alertBanner.style.cssText = `
      position: absolute;
      top: 75px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(16, 185, 129, 0.9);
      color: #ffffff;
      padding: 10px 24px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 15px;
      display: none;
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.6);
      border: 1px solid #6ee7b7;
      text-align: center;
    `;
    this.container.appendChild(this.alertBanner);

    this.setupListeners();
    this.renderTopBar();
  }

  private setupListeners(): void {
    EventBus.get().on('aging:tick', (state: unknown) => {
      const s = state as AgingState;
      this.lastTimeRemaining = s.timeRemaining;
      this.renderTopBar(s);
    });

    EventBus.get().on('crafting:materials_updated', () => {
      this.renderTopBar();
      if (this.isModalOpen) this.renderModal();
    });

    EventBus.get().on('crafting:part_crafted', () => {
      this.renderTopBar();
      if (this.isModalOpen) this.renderModal();
    });

    EventBus.get().on('crafting:rebuild_completed', () => {
      this.showRebirthAlert('⚡ СОЗНАНИЕ ПЕРЕНЕСЕНО В НОВУЮ КОПИЮ! ЭНЕРГОЯДРО ВОССТАНОВЛЕНО ⚡');
      this.renderTopBar();
      if (this.isModalOpen) this.renderModal();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyC' || e.code === 'KeyH') {
        this.toggleModal();
      } else if (e.code === 'Escape' && this.isModalOpen) {
        this.closeModal();
      }
    });
  }

  public toggleModal(): void {
    if (this.isModalOpen) this.closeModal();
    else this.openModal();
  }

  public openModal(): void {
    this.isModalOpen = true;
    this.modal.style.display = 'flex';
    this.renderModal();
  }

  public closeModal(): void {
    this.isModalOpen = false;
    this.modal.style.display = 'none';
  }

  public showRebirthAlert(msg: string): void {
    this.alertBanner.innerText = msg;
    this.alertBanner.style.display = 'block';
    setTimeout(() => {
      this.alertBanner.style.display = 'none';
    }, 4500);
  }

  private formatTime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
  }

  private renderTopBar(aging?: AgingState): void {
    const crafting = CraftingSystem.get();
    const mats = crafting.materials;
    const partsCount = crafting.getAssembledPartsCount();
    const timeRemaining = aging ? aging.timeRemaining : this.lastTimeRemaining;
    const isWarning = aging?.isWarning || timeRemaining <= 60;
    const isCritical = aging?.isCritical || timeRemaining <= 30;

    const timerColor = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#38bdf8';
    const timerStatus = isCritical ? 'КРИТИЧЕСКИЙ РАСПАД' : isWarning ? 'ДЕГРАДАЦИЯ' : 'СТАБИЛЬНО';

    const readyText = crafting.canRebuild()
      ? `<span style="color: #4ade80; font-weight: bold;">[ГОТОВА К ПЕРЕРОЖДЕНИЮ]</span>`
      : `<span style="color: #94a3b8;">КОПИЯ В ХАБЕ: ${partsCount}/4 ДЕТАЛЕЙ</span>`;

    this.topBar.innerHTML = `
      <div style="display: flex; gap: 18px; align-items: center;">
        <div>
          <span style="color: #94a3b8;">ЭНЕРГОЯДРО:</span>
          <span style="color: ${timerColor}; font-weight: bold; font-size: 15px;">${this.formatTime(timeRemaining)}</span>
          <span style="font-size: 10px; color: ${timerColor}; margin-left: 4px;">(${timerStatus})</span>
        </div>
        <div style="display: flex; gap: 12px; font-size: 12px;">
          <span>⚙️ Мусор: <b style="color: #cbd5e1;">${mats.scrap}</b></span>
          <span>⚡ Провода: <b style="color: #38bdf8;">${mats.wires}</b></span>
          <span>💿 Части диска: <b style="color: #c084fc;">${mats.discParts}</b></span>
        </div>
      </div>
      <div style="display: flex; gap: 14px; align-items: center;">
        ${readyText}
        <button id="btn-open-hub" style="
          background: #1e293b;
          border: 1px solid #38bdf8;
          color: #38bdf8;
          padding: 4px 10px;
          border-radius: 4px;
          cursor: pointer;
          font-family: inherit;
          font-size: 11px;
        ">ВЕРСТАК ХАБА [C]</button>
      </div>
    `;

    const btn = this.topBar.querySelector('#btn-open-hub');
    if (btn) btn.addEventListener('click', () => this.toggleModal());
  }

  private renderModal(): void {
    const crafting = CraftingSystem.get();
    const mats = crafting.materials;
    const copy = crafting.copyParts;
    const canRebuild = crafting.canRebuild();
    const slots: BodyPartSlot[] = ['head', 'torso', 'arms', 'legs'];

    let slotsHtml = '';
    for (const slot of slots) {
      const part = copy[slot];
      const slotName = SLOT_NAMES[slot];
      const modTypes: ModuleType[] = ['standard', 'wire', 'disc'];

      let moduleOptionsHtml = '';
      for (const mod of modTypes) {
        const matType = crafting.getMaterialForModule(mod);
        const nextLevel = (part.level === 0 || part.type !== mod) ? 1 : part.level + 1;
        const isMax = part.type === mod && part.level >= 3;
        const cost = crafting.getCostForLevel(nextLevel);
        const hasEnough = mats[matType] >= cost;
        const isCurrent = part.level > 0 && part.type === mod;

        const actionText = isMax
          ? 'МАКС'
          : isCurrent
            ? `УЛУЧШИТЬ ДО УР.${nextLevel} (${cost} ${MATERIAL_NAMES[matType]})`
            : `СОБРАТЬ УР.1 (${cost} ${MATERIAL_NAMES[matType]})`;

        const disabled = isMax || !hasEnough;

        moduleOptionsHtml += `
          <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.6); padding: 5px 8px; border-radius: 3px; margin-top: 4px;">
            <div style="font-size: 11px;">
              <span style="${isCurrent ? 'color: #38bdf8; font-weight: bold;' : 'color: #cbd5e1;'}">
                ${MODULE_NAMES[mod]} ${isCurrent ? `[УР.${part.level}]` : ''}
              </span>
            </div>
            <button
              class="btn-craft-part"
              data-slot="${slot}"
              data-mod="${mod}"
              ${disabled ? 'disabled' : ''}
              style="
                background: ${disabled ? '#334155' : '#0284c7'};
                border: 1px solid ${disabled ? '#475569' : '#38bdf8'};
                color: ${disabled ? '#94a3b8' : '#ffffff'};
                font-family: inherit;
                font-size: 10px;
                padding: 3px 8px;
                border-radius: 3px;
                cursor: ${disabled ? 'not-allowed' : 'pointer'};
              "
            >${actionText}</button>
          </div>
        `;
      }

      // Описание способности текущей собранной детали
      const currentType = part.level > 0 ? part.type : 'standard';
      const currentLvl = Math.max(1, part.level);
      const icon = slot === 'arms' ? '⚔️' : slot === 'head' ? '👁️' : slot === 'torso' ? '🛡️' : '🏃';
      const effectDesc = `<div style="font-size: 11px; color: #38bdf8; margin-top: 4px; line-height: 1.3;">
        ${icon} <b>${MODULE_NAMES[currentType]}</b>: ${crafting.getPartDescription(slot, currentType, currentLvl)}
      </div>`;

      const statusBadge = part.level > 0
        ? `<span style="color: #4ade80; font-weight: bold;">ГОТОВО (УР.${part.level})</span>`
        : `<span style="color: #ef4444;">НЕ СОБРАНО</span>`;

      slotsHtml += `
        <div style="background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 5px; padding: 10px 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(148, 163, 184, 0.15); padding-bottom: 4px;">
            <b style="color: #f8fafc; font-size: 13px;">${slotName}</b>
            <span style="font-size: 11px;">${statusBadge}</span>
          </div>
          ${effectDesc}
          <div style="margin-top: 6px;">
            ${moduleOptionsHtml}
          </div>
        </div>
      `;
    }

    const rebuildBtnText = canRebuild
      ? '⚡ ПЕРЕРОДИТЬСЯ СЕЙЧАС (ПЕРЕНОС СОЗНАНИЯ) ⚡'
      : 'СБОРКА НЕ ЗАВЕРШЕНА (НУЖНО 4 ДЕТАЛИ)';

    this.modal.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #38bdf8; padding-bottom: 8px;">
        <div>
          <b style="color: #38bdf8; font-size: 15px;">ВЕРСТАК СБОРКИ КОПИИ РОБОТА (ХАБ)</b>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
            Соберите 4 детали (голова, туловище, руки, ноги) из материалов для возрождения.
          </div>
        </div>
        <button id="btn-close-modal" style="
          background: transparent;
          border: 1px solid #64748b;
          color: #e2e8f0;
          font-family: inherit;
          font-size: 13px;
          cursor: pointer;
          border-radius: 4px;
          padding: 2px 8px;
        ">ESC</button>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        ${slotsHtml}
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.5); padding: 8px 12px; border-radius: 4px;">
        <div style="font-size: 12px;">
          <span>Материалы в наличии:</span>
          <span style="margin-left: 8px;">⚙️ ${mats.scrap}</span>
          <span style="margin-left: 8px;">⚡ ${mats.wires}</span>
          <span style="margin-left: 8px;">💿 ${mats.discParts}</span>
        </div>
        <button id="btn-perform-rebuild" ${!canRebuild ? 'disabled' : ''} style="
          background: ${canRebuild ? '#10b981' : '#334155'};
          border: 1px solid ${canRebuild ? '#34d399' : '#475569'};
          color: ${canRebuild ? '#ffffff' : '#94a3b8'};
          padding: 8px 16px;
          border-radius: 4px;
          font-family: inherit;
          font-size: 12px;
          font-weight: bold;
          cursor: ${canRebuild ? 'pointer' : 'not-allowed'};
          box-shadow: ${canRebuild ? '0 0 15px rgba(16, 185, 129, 0.4)' : 'none'};
        ">${rebuildBtnText}</button>
      </div>
    `;

    const closeBtn = this.modal.querySelector('#btn-close-modal');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());

    const rebuildBtn = this.modal.querySelector('#btn-perform-rebuild');
    if (rebuildBtn && canRebuild) {
      rebuildBtn.addEventListener('click', () => {
        if (crafting.performRebuild()) {
          this.closeModal();
        }
      });
    }

    const craftButtons = this.modal.querySelectorAll('.btn-craft-part');
    craftButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const slot = target.getAttribute('data-slot') as BodyPartSlot;
        const mod = target.getAttribute('data-mod') as ModuleType;
        if (slot && mod) {
          crafting.craftOrUpgradePart(slot, mod);
        }
      });
    });
  }
}
