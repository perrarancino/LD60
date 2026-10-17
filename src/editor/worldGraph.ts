import type { WorldLayoutDef } from './types';

export class WorldGraphModal {
  private modal: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private world: WorldLayoutDef | null = null;
  private onSelectRegion: ((regionId: string) => void) | null = null;
  private selectedRegionId: string | null = null;

  // Раскладка узлов графа
  private nodePositions = new Map<string, { x: number; y: number; w: number; h: number }>();

  constructor() {
    this.createModalDOM();
  }

  public setWorld(world: WorldLayoutDef, onSelect: (regionId: string) => void) {
    this.world = world;
    this.onSelectRegion = onSelect;
    this.calculateLayout();
  }

  public open(currentRegionId?: string) {
    if (!this.modal) return;
    this.selectedRegionId = currentRegionId || (this.world?.central_hub_id || null);
    this.modal.classList.add('open');
    this.resizeAndRender();
  }

  public close() {
    if (!this.modal) return;
    this.modal.classList.remove('open');
  }

  private createModalDOM() {
    let existing = document.getElementById('world-graph-modal');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'world-graph-modal';
      existing.className = 'modal-overlay';
      existing.innerHTML = `
        <div class="modal-card" style="width: 820px; max-width: 95vw; height: 580px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <div style="font-weight: 700; font-size: 16px; color: #fff;">🗺️ Карта открытого мира метроидвании (ATX Tower)</div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Модель перемещения: Свободный Хаб (Open Hub-and-Spoke). Кликните по узлу для перехода к уровню.</div>
            </div>
            <button id="world-graph-close-btn" class="btn btn-icon" style="font-size: 14px;">✕</button>
          </div>
          <div style="flex: 1; position: relative; background: #0c0e14; border-radius: 8px; border: 1px solid var(--border); overflow: hidden;">
            <canvas id="world-graph-canvas" style="width: 100%; height: 100%; display: block;"></canvas>
          </div>
          <div id="world-graph-info" style="margin-top: 10px; padding: 10px; background: var(--bg-main); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div id="world-graph-desc" style="color: var(--text-muted);">Выберите локацию на схеме</div>
            <button id="world-graph-load-btn" class="btn btn-primary" style="display: none;">Загрузить этот уровень</button>
          </div>
        </div>
      `;
      document.body.appendChild(existing);
    }

    this.modal = existing;
    this.canvas = existing.querySelector('#world-graph-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');

    existing.querySelector('#world-graph-close-btn')?.addEventListener('click', () => this.close());
    existing.addEventListener('click', (e) => {
      if (e.target === existing) this.close();
    });

    existing.querySelector('#world-graph-load-btn')?.addEventListener('click', () => {
      if (this.selectedRegionId && this.onSelectRegion) {
        this.onSelectRegion(this.selectedRegionId);
        this.close();
      }
    });

    this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));
  }

  private calculateLayout() {
    this.nodePositions.clear();
    const w = 180;
    const h = 54;

    // Схема расположения в стиле системного блока ПК (Центральный Хаб по центру, ветки в 4 стороны)
    const predefined: Record<string, { x: number; y: number }> = {
      'loc_central_hub': { x: 310, y: 190 },
      'trans_motherboard_traces': { x: 100, y: 190 },
      'loc_motherboard': { x: 30, y: 80 },
      'trans_power_harness': { x: 310, y: 80 },
      'loc_power_supply': { x: 530, y: 80 },
      'trans_sata_duct': { x: 530, y: 190 },
      'loc_hard_drive': { x: 530, y: 300 },
      'loc_optical_drive': { x: 310, y: 300 }
    };

    if (this.world?.regions) {
      let fallbackY = 40;
      for (const reg of this.world.regions) {
        const pos = predefined[reg.id] || { x: 40, y: fallbackY };
        this.nodePositions.set(reg.id, { x: pos.x, y: pos.y, w, h });
        if (!predefined[reg.id]) fallbackY += 70;
      }
    }
  }

  private resizeAndRender() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
    }
    this.render();
  }

  private handleCanvasClick(e: MouseEvent) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const [id, pos] of this.nodePositions.entries()) {
      if (mx >= pos.x && mx <= pos.x + pos.w && my >= pos.y && my <= pos.y + pos.h) {
        this.selectedRegionId = id;
        this.updateInfoPanel();
        this.render();
        return;
      }
    }
  }

  private updateInfoPanel() {
    const descElem = document.getElementById('world-graph-desc');
    const loadBtn = document.getElementById('world-graph-load-btn') as HTMLElement;
    if (!this.world || !descElem || !loadBtn) return;

    const reg = this.world.regions.find(r => r.id === this.selectedRegionId);
    if (reg) {
      let extra = '';
      if (reg.boss_id) extra += ` | 💀 <b>Босс:</b> ${reg.boss_id}`;
      if (reg.has_resistor) extra += ` | ⚡ <b style="color: #10b981;">Резистор</b>`;
      descElem.innerHTML = `<b>${reg.display_name}</b> [${reg.category}]<br><span style="color:#94a3b8">${reg.description}</span>${extra}`;
      loadBtn.style.display = 'block';
    } else {
      descElem.innerHTML = 'Выберите локацию на схеме';
      loadBtn.style.display = 'none';
    }
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas || !this.world) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Микросетка материнской платы
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 1. Отрисовка связей (дорожек системной шины)
    ctx.lineWidth = 3;
    for (const reg of this.world.regions) {
      const fromPos = this.nodePositions.get(reg.id);
      if (!fromPos) continue;

      for (const targetId of reg.connected_regions) {
        const toPos = this.nodePositions.get(targetId);
        if (!toPos) continue;

        const x1 = fromPos.x + fromPos.w / 2;
        const y1 = fromPos.y + fromPos.h / 2;
        const x2 = toPos.x + toPos.w / 2;
        const y2 = toPos.y + toPos.h / 2;

        ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Точки контактов
        ctx.fillStyle = '#6366f1';
        ctx.beginPath();
        ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Отрисовка узлов (чипов локаций)
    for (const reg of this.world.regions) {
      const pos = this.nodePositions.get(reg.id);
      if (!pos) continue;

      const isSelected = reg.id === this.selectedRegionId;
      const isHub = reg.category === 'hub';

      ctx.fillStyle = isSelected ? '#1e293b' : isHub ? '#1e1b4b' : '#111827';
      ctx.beginPath();
      ctx.roundRect(pos.x, pos.y, pos.w, pos.h, 6);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#38bdf8' : isHub ? '#818cf8' : '#374151';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Заголовок
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(reg.display_name.slice(0, 22), pos.x + 8, pos.y + 18);

      // Категория / Бейджи
      ctx.font = '9px monospace';
      ctx.fillStyle = '#94a3b8';
      let badges = reg.category;
      if (reg.has_resistor) badges += ' ⚡';
      if (reg.boss_id) badges += ' 💀';
      ctx.fillText(badges, pos.x + 8, pos.y + 36);

      if (isSelected) {
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(pos.x + pos.w - 12, pos.y + 14, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
