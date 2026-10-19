import { AssetManager } from './assetManager';
import { EditorCanvas } from './editorCanvas';
import type { BackgroundDef, CableDef, DecorDef, EditorConfigResponse, EnemySpawnDef, LevelDef, LevelTransitionDef, MobSpawnZoneDef, RoomDef, TileDef, ToolType } from './types';
import { WorldGraphModal } from './worldGraph';

class EditorApp {
  private assets = new AssetManager();
  private canvas!: EditorCanvas;
  private config: EditorConfigResponse | null = null;
  private currentFilename: string = '';
  private currentBackgroundId: string = '';
  private worldGraphModal = new WorldGraphModal();
  private decorCategoryFilter: string = 'all';
  private decorSearchQuery: string = '';

  public async init() {
    const canvasElem = document.getElementById('editor-canvas') as HTMLCanvasElement;
    this.canvas = new EditorCanvas(canvasElem, this.assets, {
      onHoverTile: (x, y) => this.updateCoords(x, y),
      onSelectEnemy: (enemy, idx) => this.updateSelectedEnemy(enemy, idx),
      onSelectTransition: (trans, idx) => this.updateSelectedTransition(trans, idx),
      onSelectCable: (cable, idx) => this.updateSelectedCable(cable, idx),
      onSelectDecor: (decor, idx) => this.updateSelectedDecor(decor, idx),
      onSelectRoom: (room, idx) => this.updateSelectedRoom(room, idx),
      onSelectMobZone: (zone, idx) => this.updateSelectedMobZone(zone, idx),
      onToolChange: (tool) => {
        document.querySelectorAll('.tool-btn').forEach(btn => {
          const t = (btn as HTMLElement).dataset.tool;
          btn.classList.toggle('active', t === tool);
        });
        if (tool === 'decor') {
          this.activateTab('tab-decor-btn', 'tab-decor');
        }
      },
      onPlaytestToggle: (active) => this.updatePlaytestUI(active),
      onLevelChanged: () => {
        this.syncSettingsForm();
        this.syncRoomsAndZonesUI();
      },
      onStatusMessage: (msg) => this.setStatus(msg)
    });

    this.setupUIEvents();

    try {
      this.setStatus('Загрузка конфигурации из LD60...');
      const res = await fetch('/api/ld60/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      this.config = await res.json();

      document.getElementById('status-project')!.textContent = `Связь с LD60: ${this.config?.ld60Path || 'OK'}`;

      if (this.config?.sprites?.sprites) {
        this.assets.setSprites(this.config.sprites.sprites);
      }

      if (this.config?.tiles?.tiles) {
        for (const t of this.config.tiles.tiles) {
          this.canvas.tilesById.set(t.id, t);
        }
      }

      if (this.config?.enemies) {
        for (const e of this.config.enemies) {
          this.canvas.enemiesById.set(e.id, e);
        }
      }

      if (this.config?.backgrounds) {
        for (const bg of this.config.backgrounds) {
          this.canvas.backgroundsById.set(bg.id, bg);
        }
      }

      // Наполняем палитры и данные
      this.populateTilePalette();
      this.populateEnemyPalette();
      this.populateBossPalette();
      this.populateDecorPalette();
      this.populateZoneEnemyDropdown();
      this.populateBackgroundDropdowns();
      this.populateWorldRegions();
      this.populateTransitionTargetLevels();
      this.setupNewTileModal();
      this.setupNewLevelModal();
      this.populateLevelDropdown();

      if (this.config?.world) {
        this.worldGraphModal.setWorld(this.config.world, (regionId) => this.handleSelectWorldRegion(regionId));
      }

      // Загружаем начальный уровень (по URL параметру ?level=... или первый доступный)
      const urlLevel = new URLSearchParams(window.location.search).get('level');
      const targetLvl = (urlLevel ? this.config?.levels?.find(l => l.filename === urlLevel || l.data.id === urlLevel) : undefined)
        ?? this.config?.levels?.find(l => l.filename === 'test_level.json')
        ?? this.config?.levels?.[0];

      if (targetLvl) {
        this.loadLevel(targetLvl.filename, targetLvl.data);
      }

      this.setStatus('Готов к работе');
    } catch (err: any) {
      console.error('Failed to init editor:', err);
      this.setStatus(`Ошибка загрузки: ${err.message}`, true);
    }
  }

  private setStatus(msg: string, isError: boolean = false) {
    const elem = document.getElementById('status-message');
    if (elem) {
      elem.textContent = msg;
      elem.style.color = isError ? '#ef4444' : '#94a3b8';
    }
  }

  private updateCoords(x: number, y: number) {
    const coordsElem = document.getElementById('status-coords');
    if (!coordsElem) return;
    if (this.canvas.level && x >= 0 && x < this.canvas.level.width && y >= 0 && y < this.canvas.level.height) {
      const ts = this.canvas.level.tile_size;
      const char = this.canvas.level.rows[y][x];
      const tileId = this.canvas.level.legend[char] || 'пусто';
      coordsElem.textContent = `Клетка: [${x}, ${y}] | Мир: [${x * ts}px, ${y * ts}px] | Тайл: "${tileId}" ('${char}')`;
    } else {
      coordsElem.textContent = 'Клетка: — , —';
    }
  }

  private populateBackgroundDropdowns() {
    const settingBg = document.getElementById('setting-level-bg') as HTMLSelectElement;
    const newBg = document.getElementById('new-level-bg') as HTMLSelectElement;
    const bgSelect = document.getElementById('bg-select') as HTMLSelectElement;

    if (settingBg) settingBg.innerHTML = '<option value="">Без фона</option>';
    if (newBg) newBg.innerHTML = '<option value="">Без фона</option>';
    if (bgSelect) bgSelect.innerHTML = '';

    for (const [id, bg] of this.canvas.backgroundsById.entries()) {
      if (settingBg) {
        const opt1 = document.createElement('option');
        opt1.value = id;
        opt1.textContent = id;
        settingBg.appendChild(opt1);
      }

      if (newBg) {
        const opt2 = document.createElement('option');
        opt2.value = id;
        opt2.textContent = id;
        newBg.appendChild(opt2);
      }

      if (bgSelect) {
        const opt3 = document.createElement('option');
        opt3.value = id;
        opt3.textContent = `${id} (${bg.layers?.length || 0} сл.)`;
        bgSelect.appendChild(opt3);
      }
    }

    // Выбираем первый фон или текущий
    const initialBgId = this.canvas.level?.background_id || (this.canvas.backgroundsById.keys().next().value ?? '');
    if (initialBgId && this.canvas.backgroundsById.has(initialBgId)) {
      this.selectBackground(initialBgId, false);
    }
  }

  private selectBackground(bgId: string, applyToLevel: boolean = false) {
    if (!bgId) return;
    const bg = this.canvas.backgroundsById.get(bgId);
    if (!bg) return;

    this.currentBackgroundId = bgId;

    const bgSelect = document.getElementById('bg-select') as HTMLSelectElement;
    if (bgSelect && bgSelect.value !== bgId) {
      bgSelect.value = bgId;
    }

    // Заполняем поля формы фона
    const idInput = document.getElementById('bg-id') as HTMLInputElement;
    if (idInput) idInput.value = bg.id;

    const descInput = document.getElementById('bg-description') as HTMLInputElement;
    if (descInput) descInput.value = bg.description || '';

    const skyColorPicker = document.getElementById('bg-sky-color') as HTMLInputElement;
    const skyColorHex = document.getElementById('bg-sky-color-hex') as HTMLInputElement;
    if (skyColorPicker) skyColorPicker.value = bg.sky_color;
    if (skyColorHex) skyColorHex.value = bg.sky_color;

    const groundColorPicker = document.getElementById('bg-ground-color') as HTMLInputElement;
    const groundColorHex = document.getElementById('bg-ground-color-hex') as HTMLInputElement;
    const groundCol = bg.ground_color || '#1f1a38';
    if (groundColorPicker) groundColorPicker.value = groundCol;
    if (groundColorHex) groundColorHex.value = groundCol;

    const scaleInput = document.getElementById('bg-scale') as HTMLInputElement;
    if (scaleInput) scaleInput.value = (bg.scale || 1).toString();

    const offsetInput = document.getElementById('bg-ground-offset') as HTMLInputElement;
    const offsetLabel = document.getElementById('label-bg-ground-offset');
    const offsetVal = bg.ground_offset ?? 0;
    if (offsetInput) offsetInput.value = offsetVal.toString();
    if (offsetLabel) offsetLabel.textContent = `${offsetVal}px`;

    this.renderLayersList(bg);

    if (applyToLevel && this.canvas.level) {
      this.canvas.level.background_id = bgId;
      const settingBg = document.getElementById('setting-level-bg') as HTMLSelectElement;
      if (settingBg) settingBg.value = bgId;
      this.canvas.saveStateToHistory();
      this.canvas.render();
    }
  }

  private renderLayersList(bg: BackgroundDef) {
    const container = document.getElementById('bg-layers-container');
    if (!container) return;
    container.innerHTML = '';

    if (!bg.layers || bg.layers.length === 0) {
      container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 12px; background: var(--bg-main); border-radius: 6px;">В этом фоне пока нет слоёв. Нажмите «+ Добавить слой».</div>';
      return;
    }

    const allSprites = this.assets.getAllSprites();
    const isBgSprite = (s: any) => s.id.startsWith('bg_') || (s.image && s.image.includes('background'));
    const bgSprites = allSprites.filter(isBgSprite);
    const otherSprites = allSprites.filter(s => !isBgSprite(s));

    bg.layers.forEach((layer, idx) => {
      const card = document.createElement('div');
      const isVisible = layer.visible !== false;
      card.className = `bg-layer-card ${!isVisible ? 'layer-disabled' : ''}`;

      card.innerHTML = `
        <div class="bg-layer-header">
          <span style="font-weight: 700; font-size: 11px; color: #38bdf8;">
            #${idx + 1} ${layer.name || 'Слой'}
          </span>
          <div class="bg-layer-actions">
            <button type="button" class="btn-layer-vis" title="Вкл/Выкл видимость">${isVisible ? '👁️' : '🚫'}</button>
            <button type="button" class="btn-layer-up" title="Поднять слой (дальше)" ${idx === 0 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>🔼</button>
            <button type="button" class="btn-layer-down" title="Опустить слой (ближе)" ${idx === bg.layers.length - 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>🔽</button>
            <button type="button" class="btn-layer-del" title="Удалить слой" style="color: var(--danger);">🗑️</button>
          </div>
        </div>

        <div class="form-row" style="gap: 6px; margin-bottom: 4px;">
          <div class="form-group" style="flex: 1;">
            <label class="form-label" style="font-size: 10px;">Имя слоя</label>
            <input type="text" class="text-input layer-input-name" value="${layer.name || ''}" style="width: 100%; font-size: 11px;" />
          </div>
          <div class="form-group" style="flex: 1;">
            <label class="form-label" style="font-size: 10px;">Спрайт слоя</label>
            <select class="select-input layer-select-sprite" style="width: 100%; font-size: 11px;"></select>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 4px;">
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-bottom: 2px;">
            <span>Параллакс X (0 = статика, 1 = мир):</span>
            <span class="layer-parallax-label">${(layer.parallax_x || 0).toFixed(2)}x</span>
          </div>
          <input type="range" min="0" max="1" step="0.01" value="${layer.parallax_x || 0}" class="layer-input-parallax" style="width: 100%; accent-color: var(--accent);" />
        </div>

        <div class="form-row" style="gap: 6px; align-items: center;">
          <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-muted); cursor: pointer; flex: 1;">
            <input type="checkbox" class="layer-input-mirror" ${layer.mirror ? 'checked' : ''} />
            <span>Зеркалить (без шва)</span>
          </label>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-size: 10px; color: var(--text-muted);">Срез слева:</span>
            <input type="number" min="0" max="32" value="${layer.crop_left ?? 0}" class="text-input layer-input-crop" style="width: 44px; font-size: 10px; padding: 2px 4px;" />
            <span style="font-size: 10px; color: var(--text-muted);">px</span>
          </div>
        </div>
      `;

      // Заполняем спрайты
      const spriteSelect = card.querySelector('.layer-select-sprite') as HTMLSelectElement;
      if (bgSprites.length > 0) {
        const bgGroup = document.createElement('optgroup');
        bgGroup.label = 'Фоновые спрайты (Backgrounds)';
        for (const s of bgSprites) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = `${s.id} (${s.frame_width}x${s.frame_height})`;
          bgGroup.appendChild(opt);
        }
        spriteSelect.appendChild(bgGroup);
      }
      if (otherSprites.length > 0) {
        const otherGroup = document.createElement('optgroup');
        otherGroup.label = 'Остальные спрайты';
        for (const s of otherSprites) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.id;
          otherGroup.appendChild(opt);
        }
        spriteSelect.appendChild(otherGroup);
      }
      spriteSelect.value = layer.sprite_id;

      // Привязка событий карточки
      const nameInput = card.querySelector('.layer-input-name') as HTMLInputElement;
      nameInput.addEventListener('input', () => {
        layer.name = nameInput.value;
        const titleSpan = card.querySelector('.bg-layer-header span');
        if (titleSpan) titleSpan.textContent = `#${idx + 1} ${layer.name}`;
      });

      spriteSelect.addEventListener('change', () => {
        layer.sprite_id = spriteSelect.value;
        this.canvas.render();
      });

      const parallaxInput = card.querySelector('.layer-input-parallax') as HTMLInputElement;
      const parallaxLabel = card.querySelector('.layer-parallax-label')!;
      parallaxInput.addEventListener('input', () => {
        layer.parallax_x = parseFloat(parallaxInput.value);
        parallaxLabel.textContent = `${layer.parallax_x.toFixed(2)}x`;
        this.canvas.render();
      });

      const mirrorCheckbox = card.querySelector('.layer-input-mirror') as HTMLInputElement;
      mirrorCheckbox.addEventListener('change', () => {
        layer.mirror = mirrorCheckbox.checked;
        this.canvas.render();
      });

      const cropInput = card.querySelector('.layer-input-crop') as HTMLInputElement;
      cropInput.addEventListener('input', () => {
        layer.crop_left = parseInt(cropInput.value, 10) || 0;
        this.canvas.render();
      });

      card.querySelector('.btn-layer-vis')?.addEventListener('click', () => {
        layer.visible = isVisible ? false : true;
        this.renderLayersList(bg);
        this.canvas.render();
      });

      card.querySelector('.btn-layer-up')?.addEventListener('click', () => {
        if (idx > 0) {
          const tmp = bg.layers[idx];
          bg.layers[idx] = bg.layers[idx - 1];
          bg.layers[idx - 1] = tmp;
          this.renderLayersList(bg);
          this.canvas.render();
        }
      });

      card.querySelector('.btn-layer-down')?.addEventListener('click', () => {
        if (idx < bg.layers.length - 1) {
          const tmp = bg.layers[idx];
          bg.layers[idx] = bg.layers[idx + 1];
          bg.layers[idx + 1] = tmp;
          this.renderLayersList(bg);
          this.canvas.render();
        }
      });

      card.querySelector('.btn-layer-del')?.addEventListener('click', () => {
        if (confirm(`Удалить слой #${idx + 1} (${layer.name})?`)) {
          bg.layers.splice(idx, 1);
          this.renderLayersList(bg);
          this.canvas.render();
          this.setStatus(`Слой "${layer.name}" удалён`);
        }
      });

      container.appendChild(card);
    });
  }

  private populateWorldRegions() {
    const regionSelect = document.getElementById('setting-level-region') as HTMLSelectElement;
    const descElem = document.getElementById('setting-region-desc');
    if (!regionSelect) return;

    regionSelect.innerHTML = '<option value="">(Не привязан к региону)</option>';

    if (this.config?.world?.regions) {
      for (const reg of this.config.world.regions) {
        const opt = document.createElement('option');
        opt.value = reg.id;
        opt.textContent = `${reg.display_name} [${reg.id}]`;
        regionSelect.appendChild(opt);
      }

      regionSelect.addEventListener('change', () => {
        const regId = regionSelect.value;
        const reg = this.config?.world?.regions.find(r => r.id === regId);
        if (reg && descElem) {
          descElem.innerHTML = `
            <div><b>Категория:</b> ${reg.category}</div>
            <div>${reg.description}</div>
            ${reg.boss_id ? `<div style="color: #eab308; margin-top: 2px;">⚠️ Арена босса: <b>${reg.boss_id}</b></div>` : ''}
            ${reg.has_resistor ? `<div style="color: #10b981;">⚡ Содержит сюжетный резистор</div>` : ''}
          `;
        } else if (descElem) {
          descElem.innerHTML = '';
        }
      });
    }
  }

  private setupNewTileModal() {
    const modal = document.getElementById('new-tile-modal');
    const btnOpen = document.getElementById('btn-add-tile');
    const btnCancel = document.getElementById('modal-tile-cancel-btn');
    const form = document.getElementById('new-tile-form') as HTMLFormElement;
    const spriteSelect = document.getElementById('new-tile-sprite') as HTMLSelectElement;
    const preview = document.getElementById('new-tile-sprite-preview');

    if (!modal || !btnOpen || !form || !spriteSelect) return;

    btnOpen.addEventListener('click', () => {
      spriteSelect.innerHTML = '';
      if (this.config?.sprites?.sprites) {
        const sorted = [...this.config.sprites.sprites].sort((a, b) => {
          if (a.category === 'tiles' && b.category !== 'tiles') return -1;
          if (a.category !== 'tiles' && b.category === 'tiles') return 1;
          return a.id.localeCompare(b.id);
        });

        for (const s of sorted) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = `[${s.category}] ${s.id}`;
          spriteSelect.appendChild(opt);
        }
      }

      const updatePreview = () => {
        const sId = spriteSelect.value;
        const sDef = this.assets.getSpriteDef(sId);
        if (sDef && preview) {
          preview.innerHTML = `<img src="/ld60-assets/${sDef.image}" style="max-width: 44px; max-height: 44px; image-rendering: pixelated;" />`;
        } else if (preview) {
          preview.innerHTML = '';
        }
      };

      spriteSelect.addEventListener('change', updatePreview);
      updatePreview();

      modal.classList.add('open');
    });

    btnCancel?.addEventListener('click', () => {
      modal.classList.remove('open');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = (document.getElementById('new-tile-id') as HTMLInputElement).value.trim();
      const name = (document.getElementById('new-tile-name') as HTMLInputElement).value.trim();
      const sprite_id = spriteSelect.value;
      const solid = (document.getElementById('new-tile-solid') as HTMLInputElement).checked;
      const one_way = (document.getElementById('new-tile-oneway') as HTMLInputElement).checked;

      if (!id || !sprite_id || !this.config) return;

      if (!this.config.tiles) {
        this.config.tiles = { tile_size: 32, tiles: [] };
      }

      const existingIdx = this.config.tiles.tiles.findIndex(t => t.id === id);
      const newTile: TileDef = {
        id,
        display_name: name,
        sprite_id,
        solid,
        one_way: one_way || undefined
      };

      if (existingIdx !== -1) {
        this.config.tiles.tiles[existingIdx] = newTile;
      } else {
        this.config.tiles.tiles.push(newTile);
      }

      this.canvas.tilesById.set(id, newTile);

      try {
        const res = await fetch('/api/ld60/tiles/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.config.tiles)
        });

        if (!res.ok) throw new Error('Ошибка записи в tiles.json');

        this.populateTilePalette();
        this.canvas.selectedTileId = id;
        this.setStatus(`Новый тайл "${name}" сохранён в LD60/data/tiles/tiles.json`);
        modal.classList.remove('open');
        form.reset();
      } catch (err: any) {
        alert(`Ошибка сохранения тайла: ${err.message}`);
      }
    });
  }

  private setupNewLevelModal() {
    const modal = document.getElementById('new-level-modal') as HTMLElement;
    const form = document.getElementById('new-level-form') as HTMLFormElement;
    const btnOpen = document.getElementById('btn-new-level') as HTMLButtonElement;
    const btnCancel = document.getElementById('modal-level-cancel-btn') as HTMLButtonElement;
    const bgSelect = document.getElementById('new-level-bg') as HTMLSelectElement;

    if (!modal || !form || !btnOpen) return;

    btnOpen.addEventListener('click', () => {
      // Заполняем доступные фоны
      if (bgSelect) {
        bgSelect.innerHTML = '<option value="">Без фона</option>';
        if (this.config?.backgrounds) {
          for (const bg of this.config.backgrounds) {
            const opt = document.createElement('option');
            opt.value = bg.id;
            opt.textContent = `${bg.id} (${bg.description || 'Параллакс'})`;
            bgSelect.appendChild(opt);
          }
        }
      }
      modal.classList.add('open');
      const idInput = document.getElementById('new-level-id') as HTMLInputElement;
      idInput?.focus();
    });

    btnCancel?.addEventListener('click', () => {
      modal.classList.remove('open');
      form.reset();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('open');
        form.reset();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const idInput = document.getElementById('new-level-id') as HTMLInputElement;
      const nameInput = document.getElementById('new-level-name') as HTMLInputElement;
      const widthInput = document.getElementById('new-level-width') as HTMLInputElement;
      const heightInput = document.getElementById('new-level-height') as HTMLInputElement;
      const borderCheck = document.getElementById('new-level-border') as HTMLInputElement;

      const rawId = (idInput?.value || '').trim();
      const levelId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      const displayName = (nameInput?.value || '').trim() || levelId;
      const w = Math.max(10, Math.min(300, parseInt(widthInput?.value || '40', 10)));
      const h = Math.max(8, Math.min(200, parseInt(heightInput?.value || '20', 10)));
      const bgId = bgSelect?.value || undefined;
      const withBorder = borderCheck?.checked ?? true;

      if (!levelId) {
        alert('Укажите корректный ID карты');
        return;
      }

      const rows: string[] = [];
      for (let y = 0; y < h; y++) {
        let row = '';
        for (let x = 0; x < w; x++) {
          if (withBorder && (x === 0 || x === w - 1 || y === 0 || y === h - 1)) {
            row += '#';
          } else {
            row += '.';
          }
        }
        rows.push(row);
      }

      const newLevel: LevelDef = {
        $schema: '../schemas/level.schema.json',
        id: levelId,
        display_name: displayName,
        background_id: bgId,
        tile_size: 32,
        width: w,
        height: h,
        legend: {
          '#': 'platform_block',
          '.': null
        },
        rows,
        player_spawn: {
          x: Math.min(4, w - 2),
          y: Math.max(1, h - 2)
        },
        enemies: [],
        rooms: [],
        spawn_zones: [],
        cables: [],
        transitions: []
      };

      const filename = `${levelId}.json`;

      try {
        const res = await fetch('/api/ld60/level/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, level: newLevel })
        });

        if (!res.ok) throw new Error(`Ошибка HTTP ${res.status}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Ошибка сохранения');

        if (!this.config) {
          this.config = { ld60Path: '', tiles: null, sprites: null, enemies: [], bosses: [], world: null, backgrounds: [], levels: [] };
        }

        const existingIdx = this.config.levels.findIndex(l => l.filename === filename);
        if (existingIdx !== -1) {
          this.config.levels[existingIdx] = { filename, data: newLevel };
        } else {
          this.config.levels.push({ filename, data: newLevel });
        }

        this.populateLevelDropdown();
        this.populateTransitionTargetLevels();
        this.loadLevel(filename, newLevel);

        this.setStatus(`Создана новая карта: "${displayName}" (${w}×${h} тайлов, ${filename})`);
        modal.classList.remove('open');
        form.reset();
      } catch (err: any) {
        alert(`Ошибка создания карты: ${err.message}`);
      }
    });
  }

  private populateLevelDropdown() {
    const select = document.getElementById('editor-level-select') as HTMLSelectElement;
    if (!select || !this.config?.levels) return;
    select.innerHTML = '';

    for (const lvl of this.config.levels) {
      const opt = document.createElement('option');
      opt.value = lvl.filename;
      opt.textContent = `${lvl.data.display_name || lvl.data.id} (${lvl.filename})`;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      const chosen = this.config?.levels.find((l) => l.filename === select.value);
      if (chosen) {
        this.loadLevel(chosen.filename, chosen.data);
      }
    });
  }

  private loadLevel(filename: string, levelData: LevelDef) {
    this.currentFilename = filename;
    const select = document.getElementById('editor-level-select') as HTMLSelectElement;
    if (select && select.value !== filename) {
      select.value = filename;
    }

    // Клонируем, чтобы работать независимо
    const clone: LevelDef = JSON.parse(JSON.stringify(levelData));
    this.canvas.setLevel(clone);

    this.syncSettingsForm();
    this.syncRoomsAndZonesUI();
    this.setStatus(`Загружен единый мир: ${clone.display_name || clone.id} (${clone.width}×${clone.height})`);
  }

  private syncSettingsForm() {
    if (!this.canvas.level) return;
    const lvl = this.canvas.level;

    const dimElem = document.getElementById('world-stats-dimensions');
    if (dimElem) dimElem.textContent = `${lvl.width} × ${lvl.height}`;

    const roomsElem = document.getElementById('world-stats-rooms');
    if (roomsElem) roomsElem.textContent = `${lvl.rooms?.length || 0}`;

    const zonesElem = document.getElementById('world-stats-zones');
    if (zonesElem) zonesElem.textContent = `${lvl.spawn_zones?.length || 0}`;

    const enemiesElem = document.getElementById('world-stats-enemies');
    if (enemiesElem) enemiesElem.textContent = `${lvl.enemies.length}`;

    const bgSelect = document.getElementById('setting-level-bg') as HTMLSelectElement;
    if (bgSelect) {
      bgSelect.value = lvl.background_id || '';
    }
    if (lvl.background_id && this.canvas.backgroundsById.has(lvl.background_id)) {
      this.selectBackground(lvl.background_id, false);
    }
  }

  private populateTilePalette() {
    const container = document.getElementById('palette-tiles-list')!;
    container.innerHTML = '';

    if (!this.config?.tiles?.tiles) return;

    for (const tile of this.config.tiles.tiles) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.dataset.tileId = tile.id;

      const thumb = document.createElement('div');
      thumb.className = 'palette-item-thumb';

      const spriteDef = this.assets.getSpriteDef(tile.sprite_id);
      if (spriteDef) {
        const img = document.createElement('img');
        img.src = `/ld60-assets/${spriteDef.image}`;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '🟩';
      }

      const label = document.createElement('div');
      label.className = 'palette-item-label';
      label.textContent = tile.display_name || tile.id;
      label.title = `${tile.display_name || tile.id} (${tile.id})`;

      item.appendChild(thumb);
      item.appendChild(label);

      item.addEventListener('click', () => {
        document.querySelectorAll('.palette-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        this.canvas.selectedTileId = tile.id;
        this.setTool('brush');
        this.setStatus(`Выбран тайл: ${tile.display_name || tile.id}`);
      });

      container.appendChild(item);
    }

    // Выбираем первый по умолчанию
    if (this.config.tiles.tiles.length > 0) {
      this.canvas.selectedTileId = this.config.tiles.tiles[0].id;
      const first = container.querySelector('.palette-item');
      first?.classList.add('active');
    }
  }

  private populateEnemyPalette() {
    const container = document.getElementById('palette-enemies-list')!;
    container.innerHTML = '';

    if (!this.config?.enemies) return;

    for (const enemy of this.config.enemies) {
      const card = document.createElement('div');
      card.className = 'enemy-card';
      card.dataset.enemyId = enemy.id;

      let activeVariant = enemy.sprite_variants[0] || '';

      const header = document.createElement('div');
      header.className = 'enemy-card-header';

      const thumb = document.createElement('div');
      thumb.className = 'enemy-card-thumb';
      const spriteDef = this.assets.getSpriteDef(activeVariant);
      const img = document.createElement('img');
      if (spriteDef) {
        img.src = `/ld60-assets/${spriteDef.image}`;
      }
      thumb.appendChild(img);

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'enemy-card-title';
      title.textContent = enemy.display_name;
      const stats = document.createElement('div');
      stats.className = 'enemy-card-stats';
      stats.textContent = `HP: ${enemy.stats?.max_health ?? 30} | Урон: ${enemy.stats?.contact_damage ?? 10}`;

      info.appendChild(title);
      info.appendChild(stats);
      header.appendChild(thumb);
      header.appendChild(info);
      card.appendChild(header);

      // Варианты внешности
      if (enemy.sprite_variants.length > 1) {
        const variantSelect = document.createElement('select');
        variantSelect.className = 'select-input';
        variantSelect.style.width = '100%';
        variantSelect.style.fontSize = '11px';
        variantSelect.style.marginTop = '4px';

        for (const v of enemy.sprite_variants) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          variantSelect.appendChild(opt);
        }

        variantSelect.addEventListener('change', (e) => {
          e.stopPropagation();
          activeVariant = variantSelect.value;
          const sDef = this.assets.getSpriteDef(activeVariant);
          if (sDef) img.src = `/ld60-assets/${sDef.image}`;
          this.canvas.selectedEnemySpriteId = activeVariant;
        });

        card.appendChild(variantSelect);
      }

      card.addEventListener('click', () => {
        document.querySelectorAll('.enemy-card').forEach(el => el.classList.remove('active'));
        card.classList.add('active');
        this.canvas.selectedEnemyId = enemy.id;
        this.canvas.selectedEnemySpriteId = activeVariant;
        this.setTool('enemy_spawn');
        this.setStatus(`Выбран враг для спавна: ${enemy.display_name}`);
      });

      container.appendChild(card);
    }
  }

  private populateBossPalette() {
    const container = document.getElementById('palette-bosses-list');
    if (!container || !this.config?.bosses) return;
    container.innerHTML = '';

    for (const boss of this.config.bosses) {
      const card = document.createElement('div');
      card.className = 'boss-card';
      card.dataset.bossId = boss.id;

      const bossSpriteId = boss.sprite_id || this.canvas.enemiesById.get(boss.id)?.sprite_variants[0] || 'boss_textalite';
      const spriteDef = this.assets.getSpriteDef(bossSpriteId);

      const header = document.createElement('div');
      header.className = 'boss-card-header';

      const thumb = document.createElement('div');
      thumb.className = 'boss-card-thumb';
      if (spriteDef) {
        const img = document.createElement('img');
        img.src = `/ld60-assets/${spriteDef.image}`;
        img.alt = boss.display_name || boss.id;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '👑';
      }

      const info = document.createElement('div');
      info.style.flex = '1';

      const name = document.createElement('div');
      name.className = 'boss-card-name';
      name.innerHTML = `<span class="boss-card-crown">👑</span> ${boss.display_name || boss.id}`;

      const stats = document.createElement('div');
      stats.className = 'boss-card-stats';
      stats.textContent = `HP: ${boss.stats?.max_health ?? 350} | Урон: ${boss.stats?.contact_damage ?? 20} | Спрайт: ${bossSpriteId}`;

      info.appendChild(name);
      info.appendChild(stats);

      header.appendChild(thumb);
      header.appendChild(info);
      card.appendChild(header);

      if (boss.attacks && boss.attacks.length > 0) {
        const attacksWrap = document.createElement('div');
        attacksWrap.className = 'boss-card-attacks';
        for (const atk of boss.attacks) {
          const badge = document.createElement('span');
          badge.className = 'boss-attack-badge';
          badge.textContent = `⚔️ ${atk.name || atk.id}`;
          badge.title = atk.description || '';
          attacksWrap.appendChild(badge);
        }
        card.appendChild(attacksWrap);
      }

      card.addEventListener('click', () => {
        document.querySelectorAll('.boss-card').forEach(el => el.classList.remove('active'));
        card.classList.add('active');
        this.canvas.selectedBossId = boss.id;
        this.canvas.selectedBossDisplayName = boss.display_name || boss.id;
        this.canvas.selectedBossSpriteId = bossSpriteId;
        this.setTool('boss_spawn');
        this.setStatus(`👑 Выбран босс для спавна: ${boss.display_name} (${bossSpriteId})`);
      });

      container.appendChild(card);
    }

    // По умолчанию выбираем первого босса
    if (this.config.bosses.length > 0) {
      const firstBoss = this.config.bosses[0];
      const bossSpriteId = firstBoss.sprite_id || this.canvas.enemiesById.get(firstBoss.id)?.sprite_variants[0] || 'boss_textalite';
      this.canvas.selectedBossId = firstBoss.id;
      this.canvas.selectedBossDisplayName = firstBoss.display_name || firstBoss.id;
      this.canvas.selectedBossSpriteId = bossSpriteId;
      const firstCard = container.querySelector('.boss-card');
      firstCard?.classList.add('active');
    }
  }

  private populateDecorPalette() {
    const container = document.getElementById('palette-decor-list');
    if (!container) return;
    container.innerHTML = '';

    const allSprites = this.assets.getAllSprites();
    const filter = this.decorCategoryFilter;
    const q = this.decorSearchQuery;

    const filteredSprites = allSprites.filter(s => {
      // 1. Фильтр по категории
      if (filter === 'decor') {
        if (!(s.category === 'decor' || s.id.startsWith('deco_') || s.id.startsWith('terminal_'))) return false;
      } else if (filter === 'items') {
        if (!(s.category === 'items' || s.id.startsWith('item_') || s.id.startsWith('mat_') || s.id.includes('bullet') || s.id.includes('battery'))) return false;
      } else if (filter === 'enemies') {
        if (!(s.category === 'enemies' || s.category === 'bosses' || s.id.startsWith('enemy_') || s.id.startsWith('boss_'))) return false;
      } else if (filter === 'effects') {
        if (!(s.category === 'effects' || s.id.startsWith('fx_'))) return false;
      } else if (filter === 'ui') {
        if (!(s.category === 'ui' || s.id.startsWith('ui_') || s.category === 'backgrounds' || s.category === 'player')) return false;
      }

      // 2. Текстовый поиск
      if (q) {
        const matchesId = s.id.toLowerCase().includes(q);
        const matchesCat = s.category.toLowerCase().includes(q);
        const matchesImg = s.image && s.image.toLowerCase().includes(q);
        if (!matchesId && !matchesCat && !matchesImg) return false;
      }

      return true;
    });

    const countBadge = document.getElementById('decor-count-badge');
    if (countBadge) {
      countBadge.textContent = `(${filteredSprites.length} шт.)`;
    }

    if (filteredSprites.length === 0) {
      container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); font-size: 11px; padding: 18px 8px; background: rgba(0,0,0,0.2); border-radius: 6px;">Ничего не найдено по фильтрам</div>`;
      return;
    }

    // Сортируем: decor -> items -> effects -> enemies -> bosses -> ui -> backgrounds -> player
    filteredSprites.sort((a, b) => {
      const order = (cat: string) => {
        if (cat === 'decor') return 1;
        if (cat === 'items') return 2;
        if (cat === 'effects') return 3;
        if (cat === 'enemies') return 4;
        if (cat === 'bosses') return 5;
        if (cat === 'ui') return 6;
        if (cat === 'backgrounds') return 7;
        return 8;
      };
      const catA = order(a.category);
      const catB = order(b.category);
      if (catA !== catB) return catA - catB;
      return a.id.localeCompare(b.id);
    });

    for (const sprite of filteredSprites) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.dataset.spriteId = sprite.id;
      if (this.canvas.selectedDecorSpriteId === sprite.id) {
        item.classList.add('active');
      }

      const thumb = document.createElement('div');
      thumb.className = 'palette-item-thumb';
      thumb.style.display = 'flex';
      thumb.style.alignItems = 'center';
      thumb.style.justifyContent = 'center';
      thumb.style.padding = '2px';

      const img = document.createElement('img');
      img.src = `/ld60-assets/${sprite.image}`;
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      img.style.objectFit = 'contain';
      img.style.imageRendering = 'pixelated';
      thumb.appendChild(img);

      const label = document.createElement('div');
      label.className = 'palette-item-label';
      label.textContent = sprite.id.replace(/^(deco_|item_|fx_|ui_|enemy_|boss_|tile_|bg_)/, '');
      label.title = `${sprite.id} (${sprite.frame_width}×${sprite.frame_height}px) [${sprite.category}]`;

      item.appendChild(thumb);
      item.appendChild(label);

      item.addEventListener('click', () => {
        container.querySelectorAll('.palette-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        this.canvas.selectedDecorSpriteId = sprite.id;
        this.setTool('decor');
        this.setStatus(`🖼️ Выбран спрайт: ${sprite.id} (${sprite.frame_width}×${sprite.frame_height}px, категория: ${sprite.category}). Кликните по карте.`);
      });

      container.appendChild(item);
    }

    if (filteredSprites.length > 0 && !this.canvas.selectedDecorSpriteId) {
      this.canvas.selectedDecorSpriteId = filteredSprites[0].id;
      const firstItem = container.querySelector('.palette-item');
      firstItem?.classList.add('active');
    }
  }

  private populateZoneEnemyDropdown() {
    const select = document.getElementById('zone-enemy-select') as HTMLSelectElement;
    if (!select || !this.config?.enemies) return;
    select.innerHTML = '';

    for (const enemy of this.config.enemies) {
      const opt = document.createElement('option');
      opt.value = enemy.id;
      opt.textContent = `${enemy.display_name || enemy.id} (HP: ${enemy.stats?.max_health ?? 30})`;
      select.appendChild(opt);
    }

    if (this.config.enemies.length > 0) {
      this.canvas.selectedMobZoneEnemyId = this.config.enemies[0].id;
    }
  }

  private syncRoomsAndZonesUI() {
    if (!this.canvas.level) return;
    const lvl = this.canvas.level;

    // 1. Комнаты
    const roomsCountBadge = document.getElementById('badge-rooms-count');
    const roomsList = document.getElementById('rooms-list');
    if (roomsCountBadge && roomsList) {
      const rooms = lvl.rooms || [];
      roomsCountBadge.textContent = `${rooms.length} ${rooms.length === 1 ? 'комната' : rooms.length < 5 ? 'комнаты' : 'комнат'}`;
      roomsList.innerHTML = '';

      rooms.forEach((room, idx) => {
        const item = document.createElement('div');
        item.className = `room-card ${idx === this.canvas.selectedRoomIndex ? 'active' : ''}`;
        
        const title = document.createElement('div');
        title.className = 'room-card-title';
        title.textContent = `🏛️ ${room.name}`;

        const meta = document.createElement('div');
        meta.className = 'room-card-meta';
        meta.textContent = `[${room.x}, ${room.y}] ${room.width}×${room.height}${room.beveled ? ' (скосы)' : ''}`;

        item.appendChild(title);
        item.appendChild(meta);

        item.addEventListener('click', () => {
          this.canvas.selectedRoomIndex = idx;
          this.updateSelectedRoom(room, idx);
          this.canvas.render();
        });

        roomsList.appendChild(item);
      });
    }

    // 2. Зоны спавна
    const zonesCountBadge = document.getElementById('badge-zones-count');
    const zonesList = document.getElementById('zones-list');
    if (zonesCountBadge && zonesList) {
      const zones = lvl.spawn_zones || [];
      zonesCountBadge.textContent = `${zones.length} ${zones.length === 1 ? 'зона' : zones.length < 5 ? 'зоны' : 'зон'}`;
      zonesList.innerHTML = '';

      zones.forEach((zone, idx) => {
        const item = document.createElement('div');
        item.className = `zone-card ${idx === this.canvas.selectedMobZoneIndex ? 'active' : ''}`;
        
        const title = document.createElement('div');
        title.className = 'zone-card-title';
        title.textContent = `👾 ${zone.name || zone.enemy_id}`;

        const floors = this.canvas.getValidFloorTilesInZone(zone);
        const meta = document.createElement('div');
        meta.className = 'zone-card-meta';
        meta.textContent = `${zone.enemy_id} ×${zone.count} (пол: ${floors.length})`;

        item.appendChild(title);
        item.appendChild(meta);

        item.addEventListener('click', () => {
          this.canvas.selectedMobZoneIndex = idx;
          this.updateSelectedMobZone(zone, idx);
          this.canvas.render();
        });

        zonesList.appendChild(item);
      });
    }
  }

  private setTool(tool: ToolType) {
    this.canvas.setTool(tool);
    document.querySelectorAll('.tool-btn').forEach(btn => {
      const t = (btn as HTMLElement).dataset.tool;
      btn.classList.toggle('active', t === tool);
    });
    if (tool === 'decor') {
      this.activateTab('tab-decor-btn', 'tab-decor');
    }
  }

  private updateSelectedEnemy(enemy: EnemySpawnDef | null, _idx: number) {
    const info = document.getElementById('selected-entity-info')!;
    const delBtn = document.getElementById('btn-delete-enemy')!;

    if (enemy) {
      info.innerHTML = `
        <div style="font-weight: 600; color: #fff; margin-bottom: 4px;">${enemy.enemy_id}</div>
        <div>Позиция: <b>(${enemy.x}, ${enemy.y})</b></div>
        <div>Спрайт: ${enemy.sprite_id}</div>
      `;
      delBtn.style.display = 'block';
    } else {
      info.textContent = 'Кликните на врага инструментом 🔍 для редактирования или нажмите Delete для удаления.';
      delBtn.style.display = 'none';
    }
  }

  private updatePlaytestUI(active: boolean) {
    const btn = document.getElementById('btn-playtest');
    if (!btn) return;
    if (active) {
      btn.textContent = '⏹ Стоп (Esc)';
      btn.classList.remove('btn-success');
      btn.classList.add('btn-danger');
    } else {
      btn.textContent = '▶️ Тест';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-success');
    }
  }

  private updateSelectedTransition(trans: LevelTransitionDef | null, _idx: number) {
    const panel = document.getElementById('transition-editor-panel');
    if (!panel) return;

    if (trans) {
      panel.style.display = 'block';
      (document.getElementById('trans-id') as HTMLInputElement).value = trans.id;
      (document.getElementById('trans-label') as HTMLInputElement).value = trans.label || '';
      (document.getElementById('trans-target-level') as HTMLSelectElement).value = trans.target_level;
      (document.getElementById('trans-target-spawn-x') as HTMLInputElement).value = (trans.target_spawn?.x ?? 2).toString();
      (document.getElementById('trans-target-spawn-y') as HTMLInputElement).value = (trans.target_spawn?.y ?? 14).toString();
      (document.getElementById('trans-resistors') as HTMLInputElement).value = (trans.requires_resistors ?? 0).toString();

      this.activateTab('tab-decor-btn', 'tab-decor');
    } else {
      panel.style.display = 'none';
    }
  }

  private updateSelectedCable(cable: CableDef | null, _idx: number) {
    const box = document.getElementById('selected-cable-box');
    const desc = document.getElementById('selected-cable-desc');
    if (!box || !desc) return;

    if (cable) {
      box.style.display = 'block';
      desc.textContent = `Тип: ${cable.type || 'sata'} | Толщина: ${cable.thickness}px | Прогиб: ${cable.sag}px`;
      (document.getElementById('slider-cable-sag') as HTMLInputElement).value = cable.sag.toString();
      document.getElementById('label-cable-sag')!.textContent = `${cable.sag}px`;
      (document.getElementById('slider-cable-thick') as HTMLInputElement).value = cable.thickness.toString();
      document.getElementById('label-cable-thick')!.textContent = `${cable.thickness}px`;

      this.activateTab('tab-decor-btn', 'tab-decor');
    } else {
      box.style.display = 'none';
    }
  }

  private updateSelectedDecor(decor: DecorDef | null, idx: number) {
    const panel = document.getElementById('selected-decor-panel');
    const desc = document.getElementById('selected-decor-desc');
    const inputX = document.getElementById('decor-edit-x') as HTMLInputElement;
    const inputY = document.getElementById('decor-edit-y') as HTMLInputElement;
    const selectLayer = document.getElementById('decor-edit-layer') as HTMLSelectElement;

    if (!panel) return;

    if (decor) {
      panel.style.display = 'block';
      if (desc) {
        const sDef = this.assets.getSpriteDef(decor.sprite_id);
        const sizeStr = sDef ? ` (${sDef.frame_width}×${sDef.frame_height}px)` : '';
        desc.textContent = `#${idx + 1}: ${decor.sprite_id}${sizeStr} [слой: ${decor.layer || 'front'}]`;
      }
      if (inputX) inputX.value = decor.x.toString();
      if (inputY) inputY.value = decor.y.toString();
      if (selectLayer) selectLayer.value = decor.layer || 'front';

      this.activateTab('tab-decor-btn', 'tab-decor');
    } else {
      panel.style.display = 'none';
    }
  }

  private updateSelectedRoom(room: RoomDef | null, _idx: number) {
    const panel = document.getElementById('selected-room-panel');
    const desc = document.getElementById('selected-room-desc');
    if (!panel || !desc) return;

    if (room) {
      panel.style.display = 'block';
      desc.innerHTML = `
        <div><b>${room.name}</b> (${room.id})</div>
        <div>Позиция: <b>[${room.x}, ${room.y}]</b></div>
        <div>Размер: <b>${room.width} × ${room.height}</b> клеток</div>
        <div>Срез углов: <b>${room.beveled ? 'Да (45° скосы)' : 'Прямые углы'}</b></div>
      `;
      this.activateTab('tab-rooms-btn', 'tab-rooms');
    } else {
      panel.style.display = 'none';
    }
    this.syncRoomsAndZonesUI();
  }

  private updateSelectedMobZone(zone: MobSpawnZoneDef | null, _idx: number) {
    const panel = document.getElementById('selected-zone-panel');
    const desc = document.getElementById('selected-zone-desc');
    if (!panel || !desc) return;

    if (zone) {
      panel.style.display = 'block';
      const floors = this.canvas.getValidFloorTilesInZone(zone);
      desc.innerHTML = `
        <div><b>${zone.name || zone.enemy_id}</b></div>
        <div>Область: <b>[${zone.x}, ${zone.y}]</b> размер: <b>${zone.width} × ${zone.height}</b></div>
        <div>Враг: <b>${zone.enemy_id}</b> | Количество: <b>${zone.count}</b></div>
        <div style="color: #4ade80; margin-top: 4px;">✓ Валидных мест пола для спавна: <b>${floors.length}</b></div>
      `;
      const enemySelect = document.getElementById('zone-enemy-select') as HTMLSelectElement;
      if (enemySelect) enemySelect.value = zone.enemy_id;
      const countInput = document.getElementById('zone-mob-count') as HTMLInputElement;
      if (countInput) countInput.value = zone.count.toString();
      this.activateTab('tab-zones-btn', 'tab-zones');
    } else {
      panel.style.display = 'none';
    }
    this.syncRoomsAndZonesUI();
  }

  private activateTab(btnId: string, contentId: string) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(btnId)?.classList.add('active');
    document.getElementById(contentId)?.classList.add('active');
  }

  private populateTransitionTargetLevels() {
    const select = document.getElementById('trans-target-level') as HTMLSelectElement;
    if (!select || !this.config?.levels) return;
    select.innerHTML = '';
    for (const lvl of this.config.levels) {
      const opt = document.createElement('option');
      opt.value = lvl.data.id;
      opt.textContent = `${lvl.data.display_name || lvl.data.id} (${lvl.filename})`;
      select.appendChild(opt);
    }
  }

  private getCurrentRegionId(): string | undefined {
    return (document.getElementById('setting-level-region') as HTMLSelectElement)?.value || undefined;
  }

  private handleSelectWorldRegion(regionId: string) {
    const regDef = this.config?.world?.regions.find(r => r.id === regionId);
    const name = regDef ? regDef.display_name : regionId;
    const regionSelect = document.getElementById('setting-level-region') as HTMLSelectElement;
    if (regionSelect) {
      regionSelect.value = regionId;
    }
    this.setStatus(`Выбран регион единого мира: "${name}" (${regionId})`);

    // Если в едином мире есть комната с таким регионом или ID, центрируем камеру на ней
    if (this.canvas.level?.rooms) {
      const room = this.canvas.level.rooms.find(r => r.id === regionId || r.name.toLowerCase().includes(name.toLowerCase()));
      if (room) {
        const ts = this.canvas.level.tile_size;
        const rx = (room.x + room.width / 2) * ts;
        const ry = (room.y + room.height / 2) * ts;
        this.canvas.panX = Math.round(this.canvas.canvas.width / 2 - rx * this.canvas.zoom);
        this.canvas.panY = Math.round(this.canvas.canvas.height / 2 - ry * this.canvas.zoom);
        this.canvas.render();
      }
    }
  }

  private async saveCurrentLevel() {
    if (!this.canvas.level) return;
    const saveBtn = document.getElementById('btn-save')!;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = '⏳ Сохраняю...';

    try {
      const res = await fetch('/api/ld60/level/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: this.currentFilename,
          level: this.canvas.level
        })
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unknown error');

      saveBtn.textContent = '✅ Сохранено!';
      saveBtn.classList.remove('btn-primary');
      saveBtn.classList.add('btn-success');
      this.setStatus(`Уровень успешно сохранён в LD60: ${data.filename}`);

      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.classList.remove('btn-success');
        saveBtn.classList.add('btn-primary');
      }, 2000);
    } catch (err: any) {
      console.error('Save failed:', err);
      alert(`Ошибка сохранения уровня: ${err.message}`);
      saveBtn.textContent = originalText;
      this.setStatus(`Ошибка сохранения: ${err.message}`, true);
    }
  }

  private setupUIEvents() {
    // Инструменты в левом тулбаре
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = (btn as HTMLElement).dataset.tool as ToolType;
        if (tool) this.setTool(tool);
      });
    });

    // Вкладки справа
    const tabs: Record<string, string> = {
      'tab-tiles-btn': 'tab-tiles',
      'tab-rooms-btn': 'tab-rooms',
      'tab-zones-btn': 'tab-zones',
      'tab-bosses-btn': 'tab-bosses',
      'tab-enemies-btn': 'tab-enemies',
      'tab-decor-btn': 'tab-decor',
      'tab-bg-btn': 'tab-bg',
      'tab-settings-btn': 'tab-settings'
    };

    for (const [btnId, contentId] of Object.entries(tabs)) {
      document.getElementById(btnId)?.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(btnId)?.classList.add('active');
        document.getElementById(contentId)?.classList.add('active');
      });
    }

    // Поиск декора и предметов
    const decorSearch = document.getElementById('decor-search-input') as HTMLInputElement;
    decorSearch?.addEventListener('input', () => {
      this.decorSearchQuery = decorSearch.value.trim().toLowerCase();
      this.populateDecorPalette();
    });

    // Фильтры категорий декора и предметов
    document.querySelectorAll('#decor-category-filters .btn-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#decor-category-filters .btn-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.decorCategoryFilter = (btn as HTMLElement).dataset.filter || 'all';
        this.populateDecorPalette();
      });
    });

    (document.getElementById('setting-level-bg') as HTMLSelectElement)?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val && this.canvas.backgroundsById.has(val)) {
        this.selectBackground(val, false);
      }
    });

    this.setupBackgroundCustomizer();

    // Верхняя панель: Instant Playtest & World Graph
    document.getElementById('btn-playtest')?.addEventListener('click', () => {
      this.canvas.togglePlaytest();
    });

    document.getElementById('btn-world-graph')?.addEventListener('click', () => {
      this.worldGraphModal.open(this.getCurrentRegionId());
    });

    // Переключатель оверлея проходимости (кубики)
    const btnWalk = document.getElementById('toggle-walkability');
    btnWalk?.addEventListener('click', () => {
      const active = this.canvas.toggleWalkability();
      btnWalk.classList.toggle('active', active);
      this.setStatus(active ? '🟩 Оверлей проходимости ВКЛЮЧЁН (зелёный = пол, красный = блок)' : 'Оверлей проходимости выключен');
    });

    // Инструменты комнат и проходов
    document.getElementById('btn-tool-room')?.addEventListener('click', () => {
      this.setTool('room');
      this.setStatus('🏛️ Создание комнат (R). Тяните мышь на холсте.');
    });

    const checkRoomBevel = document.getElementById('checkbox-room-bevel') as HTMLInputElement;
    checkRoomBevel?.addEventListener('change', () => {
      this.canvas.roomBevelCorners = checkRoomBevel.checked;
      this.setStatus(checkRoomBevel.checked ? 'Срез углов комнат включён (45° скосы)' : 'Срез углов выключен');
    });

    document.getElementById('btn-tool-passage')?.addEventListener('click', () => {
      this.setTool('passage');
      this.setStatus('⛏️ Рисование проходов (W). Зажмите ЛКМ и рисуйте тоннели.');
    });

    const sliderPassageW = document.getElementById('slider-passage-width') as HTMLInputElement;
    sliderPassageW?.addEventListener('input', () => {
      const val = parseInt(sliderPassageW.value, 10);
      this.canvas.passageWidth = val;
      const label = document.getElementById('label-passage-width');
      if (label) label.textContent = `${val} ${val === 1 ? 'клетка' : val < 5 ? 'клетки' : 'клеток'}`;
    });

    const checkPassageWalls = document.getElementById('checkbox-passage-autowalls') as HTMLInputElement;
    checkPassageWalls?.addEventListener('change', () => {
      this.canvas.passageAutoWalls = checkPassageWalls.checked;
    });

    const btnWalkPassable = document.getElementById('btn-walk-passable');
    const btnWalkSolid = document.getElementById('btn-walk-solid');
    btnWalkPassable?.addEventListener('click', () => {
      this.canvas.walkabilityMode = 'passable';
      btnWalkPassable.classList.add('active');
      btnWalkSolid?.classList.remove('active');
      this.setTool('walkability');
      this.setStatus('Кисть проходимости: очистка в проходимый пол / воздух');
    });
    btnWalkSolid?.addEventListener('click', () => {
      this.canvas.walkabilityMode = 'solid';
      btnWalkSolid.classList.add('active');
      btnWalkPassable?.classList.remove('active');
      this.setTool('walkability');
      this.setStatus('Кисть проходимости: установка блоков стен');
    });

    document.getElementById('btn-delete-room')?.addEventListener('click', () => {
      this.canvas.deleteSelectedRoom();
      this.syncRoomsAndZonesUI();
    });

    // Инструменты зон спавна мобов
    document.getElementById('btn-tool-mob-zone')?.addEventListener('click', () => {
      this.setTool('mob_zone');
      this.setStatus('👾 Задание области спавна (Z). Выделите прямоугольник на карте.');
    });

    const selectZoneEnemy = document.getElementById('zone-enemy-select') as HTMLSelectElement;
    selectZoneEnemy?.addEventListener('change', () => {
      this.canvas.selectedMobZoneEnemyId = selectZoneEnemy.value;
      if (this.canvas.selectedMobZoneIndex !== -1 && this.canvas.level?.spawn_zones?.[this.canvas.selectedMobZoneIndex]) {
        this.canvas.level.spawn_zones[this.canvas.selectedMobZoneIndex].enemy_id = selectZoneEnemy.value;
        this.canvas.render();
        this.syncRoomsAndZonesUI();
      }
    });

    const inputZoneCount = document.getElementById('zone-mob-count') as HTMLInputElement;
    inputZoneCount?.addEventListener('input', () => {
      const count = parseInt(inputZoneCount.value, 10) || 1;
      this.canvas.selectedMobZoneCount = count;
      if (this.canvas.selectedMobZoneIndex !== -1 && this.canvas.level?.spawn_zones?.[this.canvas.selectedMobZoneIndex]) {
        this.canvas.level.spawn_zones[this.canvas.selectedMobZoneIndex].count = count;
        this.canvas.render();
        this.syncRoomsAndZonesUI();
      }
    });

    document.getElementById('btn-generate-zone-mobs')?.addEventListener('click', () => {
      if (this.canvas.selectedMobZoneIndex !== -1) {
        this.canvas.generateZoneMobs(this.canvas.selectedMobZoneIndex);
      } else {
        this.setStatus('Сначала выберите зону спавна на карте или в списке!', true);
      }
    });

    document.getElementById('btn-delete-zone')?.addEventListener('click', () => {
      this.canvas.deleteSelectedMobZone();
      this.syncRoomsAndZonesUI();
    });

    // Инструмент спавна боссов
    document.getElementById('btn-tool-boss-spawn')?.addEventListener('click', () => {
      this.setTool('boss_spawn');
      this.setStatus(`👑 Спавн боссов (F). Кликните на карту для размещения ${this.canvas.selectedBossDisplayName || 'босса'}.`);
    });

    // Переключатель автотайлинга
    const btnAutotile = document.getElementById('btn-toggle-autotile');
    btnAutotile?.addEventListener('click', () => {
      this.canvas.autotileEnabled = !this.canvas.autotileEnabled;
      btnAutotile.classList.toggle('active', this.canvas.autotileEnabled);
      this.setStatus(this.canvas.autotileEnabled ? 'Автотайлинг (9-slice) включен' : 'Автотайлинг выключен');
    });

    // Переключатель дуги прыжка
    const btnArc = document.getElementById('btn-toggle-arc');
    btnArc?.addEventListener('click', () => {
      this.canvas.showJumpArc = !this.canvas.showJumpArc;
      btnArc.classList.toggle('active', this.canvas.showJumpArc);
      this.canvas.render();
    });

    // Пресеты кабелей
    const setCablePreset = (color: string, thick: number, type: 'sata' | 'power' | 'ide' | 'ground', sag: number) => {
      this.canvas.cableColor = color;
      this.canvas.cableThickness = thick;
      this.canvas.cableType = type;
      this.canvas.cableSag = sag;
      const sagSlider = document.getElementById('slider-cable-sag') as HTMLInputElement;
      if (sagSlider) sagSlider.value = sag.toString();
      const sagLabel = document.getElementById('label-cable-sag');
      if (sagLabel) sagLabel.textContent = `${sag}px`;
      const thickSlider = document.getElementById('slider-cable-thick') as HTMLInputElement;
      if (thickSlider) thickSlider.value = thick.toString();
      const thickLabel = document.getElementById('label-cable-thick');
      if (thickLabel) thickLabel.textContent = `${thick}px`;
      this.setTool('cable');
      this.setStatus(`Выбран пресет кабеля: ${type.toUpperCase()}`);
    };

    document.getElementById('btn-preset-sata')?.addEventListener('click', () => setCablePreset('#ef4444', 3, 'sata', 35));
    document.getElementById('btn-preset-power')?.addEventListener('click', () => setCablePreset('#f59e0b', 2, 'power', 45));
    document.getElementById('btn-preset-ide')?.addEventListener('click', () => setCablePreset('#94a3b8', 8, 'ide', 25));
    document.getElementById('btn-preset-ground')?.addEventListener('click', () => setCablePreset('#10b981', 2, 'ground', 30));

    // Слайдеры параметров кабелей
    const sliderSag = document.getElementById('slider-cable-sag') as HTMLInputElement;
    sliderSag?.addEventListener('input', () => {
      const val = parseInt(sliderSag.value, 10);
      this.canvas.cableSag = val;
      const sagLabel = document.getElementById('label-cable-sag');
      if (sagLabel) sagLabel.textContent = `${val}px`;
      if (this.canvas.selectedCableIndex !== -1 && this.canvas.level?.cables?.[this.canvas.selectedCableIndex]) {
        this.canvas.level.cables[this.canvas.selectedCableIndex].sag = val;
        this.canvas.render();
      }
    });

    const sliderThick = document.getElementById('slider-cable-thick') as HTMLInputElement;
    sliderThick?.addEventListener('input', () => {
      const val = parseInt(sliderThick.value, 10);
      this.canvas.cableThickness = val;
      const thickLabel = document.getElementById('label-cable-thick');
      if (thickLabel) thickLabel.textContent = `${val}px`;
      if (this.canvas.selectedCableIndex !== -1 && this.canvas.level?.cables?.[this.canvas.selectedCableIndex]) {
        this.canvas.level.cables[this.canvas.selectedCableIndex].thickness = val;
        this.canvas.render();
      }
    });

    document.getElementById('btn-delete-cable')?.addEventListener('click', () => {
      this.canvas.deleteSelectedCable();
    });

    // Инструменты декора и инспектора
    document.getElementById('btn-tool-decor')?.addEventListener('click', () => {
      this.setTool('decor');
      this.setStatus('🖼️ Режим декора (Y). Выберите спрайт из палитры и кликните на карте.');
    });

    const decorLayerSelect = document.getElementById('decor-layer-select') as HTMLSelectElement;
    decorLayerSelect?.addEventListener('change', () => {
      const layer = decorLayerSelect.value === 'back' ? 'back' : 'front';
      this.canvas.selectedDecorLayer = layer;
      this.setStatus(`Слой нового декора: ${layer}`);
    });

    const inputDecorX = document.getElementById('decor-edit-x') as HTMLInputElement;
    inputDecorX?.addEventListener('change', () => {
      if (this.canvas.selectedDecorIndex !== -1 && this.canvas.level?.decor?.[this.canvas.selectedDecorIndex]) {
        const val = parseFloat(inputDecorX.value);
        if (!isNaN(val)) {
          this.canvas.level.decor[this.canvas.selectedDecorIndex].x = val;
          this.canvas.saveStateToHistory();
          this.canvas.render();
        }
      }
    });

    const inputDecorY = document.getElementById('decor-edit-y') as HTMLInputElement;
    inputDecorY?.addEventListener('change', () => {
      if (this.canvas.selectedDecorIndex !== -1 && this.canvas.level?.decor?.[this.canvas.selectedDecorIndex]) {
        const val = parseFloat(inputDecorY.value);
        if (!isNaN(val)) {
          this.canvas.level.decor[this.canvas.selectedDecorIndex].y = val;
          this.canvas.saveStateToHistory();
          this.canvas.render();
        }
      }
    });

    const selectDecorLayer = document.getElementById('decor-edit-layer') as HTMLSelectElement;
    selectDecorLayer?.addEventListener('change', () => {
      if (this.canvas.selectedDecorIndex !== -1 && this.canvas.level?.decor?.[this.canvas.selectedDecorIndex]) {
        const layer = selectDecorLayer.value === 'back' ? 'back' : 'front';
        this.canvas.level.decor[this.canvas.selectedDecorIndex].layer = layer;
        this.canvas.saveStateToHistory();
        this.canvas.render();
        this.updateSelectedDecor(this.canvas.level.decor[this.canvas.selectedDecorIndex], this.canvas.selectedDecorIndex);
      }
    });

    document.getElementById('btn-delete-decor')?.addEventListener('click', () => {
      this.canvas.deleteSelectedDecor();
    });

    // Редактирование и удаление перехода (шлюза)
    document.getElementById('btn-save-trans')?.addEventListener('click', () => {
      if (!this.canvas.level || this.canvas.selectedTransitionIndex === -1 || !this.canvas.level.transitions) return;
      const t = this.canvas.level.transitions[this.canvas.selectedTransitionIndex];
      t.label = (document.getElementById('trans-label') as HTMLInputElement).value.trim();
      t.target_level = (document.getElementById('trans-target-level') as HTMLSelectElement).value;
      t.target_spawn = {
        x: parseInt((document.getElementById('trans-target-spawn-x') as HTMLInputElement).value, 10) || 0,
        y: parseInt((document.getElementById('trans-target-spawn-y') as HTMLInputElement).value, 10) || 0
      };
      t.requires_resistors = parseInt((document.getElementById('trans-resistors') as HTMLInputElement).value, 10) || 0;
      this.canvas.saveStateToHistory();
      this.canvas.render();
      this.setStatus(`Параметры шлюза "${t.id}" сохранены`);
    });

    document.getElementById('btn-delete-trans')?.addEventListener('click', () => {
      this.canvas.deleteSelectedTransition();
    });

    // Кнопка сохранения
    document.getElementById('btn-save')?.addEventListener('click', () => this.saveCurrentLevel());
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this.saveCurrentLevel();
      }
    });

    // Undo / Redo
    document.getElementById('btn-undo')?.addEventListener('click', () => this.canvas.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => this.canvas.redo());

    // Зум
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      this.canvas.zoom = Math.min(this.canvas.zoom * 1.25, 8.0);
      this.canvas.render();
    });
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      this.canvas.zoom = Math.max(this.canvas.zoom / 1.25, 0.25);
      this.canvas.render();
    });
    document.getElementById('btn-zoom-fit')?.addEventListener('click', () => this.canvas.centerView());

    // Переключатели слоёв
    const toggleSetup = (id: string, prop: 'showGrid' | 'showCollisions' | 'showBackground' | 'showEntities') => {
      const btn = document.getElementById(id);
      btn?.addEventListener('click', () => {
        this.canvas[prop] = !this.canvas[prop];
        btn.classList.toggle('active', this.canvas[prop]);
        this.canvas.render();
      });
    };
    toggleSetup('toggle-grid', 'showGrid');
    toggleSetup('toggle-collisions', 'showCollisions');
    toggleSetup('toggle-bg', 'showBackground');
    toggleSetup('toggle-entities', 'showEntities');

    // Кнопка удаления выбранного врага
    document.getElementById('btn-delete-enemy')?.addEventListener('click', () => {
      this.canvas.deleteSelectedEnemy();
    });

    // Кнопки сдвига карты (Shift)
    document.getElementById('btn-shift-left')?.addEventListener('click', () => this.canvas.shiftMap(-1, 0));
    document.getElementById('btn-shift-right')?.addEventListener('click', () => this.canvas.shiftMap(1, 0));
    document.getElementById('btn-shift-up')?.addEventListener('click', () => this.canvas.shiftMap(0, -1));
    document.getElementById('btn-shift-down')?.addEventListener('click', () => this.canvas.shiftMap(0, 1));

    // Кнопки авто-подгонки границ мира под комнаты
    const onAutoFit = () => this.canvas.autoFitBounds(3);
    document.getElementById('btn-auto-fit-bounds')?.addEventListener('click', onAutoFit);
    document.getElementById('btn-auto-fit-bounds-sidebar')?.addEventListener('click', onAutoFit);

    // Добавление свободного пространства вокруг (+10 клеток)
    document.getElementById('btn-pad-top')?.addEventListener('click', () => this.canvas.expand('top', 10));
    document.getElementById('btn-pad-bottom')?.addEventListener('click', () => this.canvas.expand('bottom', 10));
    document.getElementById('btn-pad-left')?.addEventListener('click', () => this.canvas.expand('left', 10));
    document.getElementById('btn-pad-right')?.addEventListener('click', () => this.canvas.expand('right', 10));

    // Смена региона мира
    (document.getElementById('setting-level-region') as HTMLSelectElement)?.addEventListener('change', (e) => {
      const regionId = (e.target as HTMLSelectElement).value;
      this.setStatus(`Регион мира: ${regionId || 'Не привязан'}`);
    });
  }

  private setupBackgroundCustomizer() {
    const bgSelect = document.getElementById('bg-select') as HTMLSelectElement;
    bgSelect?.addEventListener('change', () => {
      this.selectBackground(bgSelect.value);
    });

    const skyColorPicker = document.getElementById('bg-sky-color') as HTMLInputElement;
    const skyColorHex = document.getElementById('bg-sky-color-hex') as HTMLInputElement;
    skyColorPicker?.addEventListener('input', () => {
      skyColorHex.value = skyColorPicker.value;
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (bg) {
        bg.sky_color = skyColorPicker.value;
        this.canvas.render();
      }
    });
    skyColorHex?.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(skyColorHex.value)) {
        skyColorPicker.value = skyColorHex.value;
        const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
        if (bg) {
          bg.sky_color = skyColorHex.value;
          this.canvas.render();
        }
      }
    });

    const groundColorPicker = document.getElementById('bg-ground-color') as HTMLInputElement;
    const groundColorHex = document.getElementById('bg-ground-color-hex') as HTMLInputElement;
    groundColorPicker?.addEventListener('input', () => {
      groundColorHex.value = groundColorPicker.value;
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (bg) {
        bg.ground_color = groundColorPicker.value;
        this.canvas.render();
      }
    });
    groundColorHex?.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(groundColorHex.value)) {
        groundColorPicker.value = groundColorHex.value;
        const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
        if (bg) {
          bg.ground_color = groundColorHex.value;
          this.canvas.render();
        }
      }
    });

    const scaleInput = document.getElementById('bg-scale') as HTMLInputElement;
    scaleInput?.addEventListener('input', () => {
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (bg) {
        bg.scale = Math.max(1, parseInt(scaleInput.value, 10) || 1);
        this.canvas.render();
      }
    });

    const offsetInput = document.getElementById('bg-ground-offset') as HTMLInputElement;
    const offsetLabel = document.getElementById('label-bg-ground-offset');
    offsetInput?.addEventListener('input', () => {
      const val = Math.max(0, parseInt(offsetInput.value, 10) || 0);
      if (offsetLabel) offsetLabel.textContent = `${val}px`;
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (bg) {
        bg.ground_offset = val;
        this.canvas.render();
      }
    });

    const descInput = document.getElementById('bg-description') as HTMLInputElement;
    descInput?.addEventListener('input', () => {
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (bg) {
        bg.description = descInput.value;
      }
    });

    const idInput = document.getElementById('bg-id') as HTMLInputElement;
    idInput?.addEventListener('change', () => {
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      const newId = idInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      if (bg && newId && newId !== this.currentBackgroundId) {
        if (this.canvas.backgroundsById.has(newId)) {
          alert(`Фон с ID "${newId}" уже существует!`);
          idInput.value = this.currentBackgroundId;
          return;
        }
        this.canvas.backgroundsById.delete(this.currentBackgroundId);
        bg.id = newId;
        this.canvas.backgroundsById.set(newId, bg);
        if (this.canvas.level?.background_id === this.currentBackgroundId) {
          this.canvas.level.background_id = newId;
        }
        this.currentBackgroundId = newId;
        this.populateBackgroundDropdowns();
        this.selectBackground(newId);
      }
    });

    document.getElementById('btn-add-bg-layer')?.addEventListener('click', () => {
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (!bg) return;
      const allSprites = this.assets.getAllSprites();
      const isBg = (s: any) => s.id.startsWith('bg_') || (s.image && s.image.includes('background'));
      const bgSprites = allSprites.filter(isBg);
      const defaultSprite = bgSprites.length > 0 ? bgSprites[0].id : (allSprites[0]?.id || 'bg_textalite_layer1');

      bg.layers = bg.layers || [];
      bg.layers.push({
        name: `layer_${bg.layers.length + 1}`,
        sprite_id: defaultSprite,
        parallax_x: Math.min(1, Math.round(bg.layers.length * 0.1 * 100) / 100),
        mirror: true,
        crop_left: 0,
        visible: true
      });
      this.renderLayersList(bg);
      this.canvas.render();
      this.setStatus(`Добавлен новый слой в фон "${bg.id}"`);
    });

    document.getElementById('btn-new-bg')?.addEventListener('click', () => {
      const newId = prompt('Введите ID нового фона (например: bg_subway):', `bg_${Date.now().toString().slice(-4)}`);
      if (!newId) return;
      const cleanId = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      if (this.canvas.backgroundsById.has(cleanId)) {
        alert('Фон с таким ID уже существует!');
        return;
      }

      const allSprites = this.assets.getAllSprites();
      const isBg = (s: any) => s.id.startsWith('bg_') || (s.image && s.image.includes('background'));
      const bgSprites = allSprites.filter(isBg);
      const defaultSprite = bgSprites[0]?.id || allSprites[0]?.id || 'bg_textalite_layer1';

      const newBg: BackgroundDef = {
        $schema: '../schemas/background.schema.json',
        id: cleanId,
        description: 'Новый параллакс-фон',
        sky_color: '#120a36',
        ground_color: '#1f1a38',
        scale: 1,
        ground_offset: 32,
        layers: [
          { name: 'distant_sky', sprite_id: defaultSprite, parallax_x: 0, mirror: true },
          { name: 'foreground_details', sprite_id: bgSprites[1]?.id || defaultSprite, parallax_x: 0.2 }
        ]
      };
      this.canvas.backgroundsById.set(cleanId, newBg);
      if (this.config) {
        this.config.backgrounds = this.config.backgrounds || [];
        this.config.backgrounds.push(newBg);
      }
      this.populateBackgroundDropdowns();
      this.selectBackground(cleanId, true);
      this.setStatus(`Создан новый фон: "${cleanId}"`);
    });

    document.getElementById('btn-apply-bg-to-level')?.addEventListener('click', () => {
      if (!this.canvas.level || !this.currentBackgroundId) return;
      this.canvas.level.background_id = this.currentBackgroundId;
      const settingBg = document.getElementById('setting-level-bg') as HTMLSelectElement;
      if (settingBg) settingBg.value = this.currentBackgroundId;
      this.canvas.saveStateToHistory();
      this.canvas.render();
      this.setStatus(`Фон "${this.currentBackgroundId}" привязан к текущему уровню`);
    });

    document.getElementById('btn-save-bg')?.addEventListener('click', async () => {
      const bg = this.canvas.backgroundsById.get(this.currentBackgroundId);
      if (!bg) {
        alert('Не выбран фон для сохранения');
        return;
      }
      const btn = document.getElementById('btn-save-bg')!;
      const originalText = btn.textContent;
      try {
        btn.textContent = '⏳ Сохраняю фон...';
        const res = await fetch('/api/ld60/background/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ background: bg })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        btn.textContent = '✅ Сохранено в проект!';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
        this.setStatus(`Фон "${bg.id}" успешно сохранён в data/backgrounds/${bg.id}.json`);
      } catch (err: any) {
        console.error('Failed to save background:', err);
        btn.textContent = originalText;
        alert(`Ошибка сохранения фона: ${err.message}`);
        this.setStatus(`Ошибка сохранения фона: ${err.message}`, true);
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new EditorApp();
  app.init();
});
