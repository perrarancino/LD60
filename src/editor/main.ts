import { AssetManager } from './assetManager';
import { EditorCanvas } from './editorCanvas';
import type { BackgroundDef, CableDef, EditorConfigResponse, EnemySpawnDef, LevelDef, LevelTransitionDef, MobSpawnZoneDef, RoomDef, TileDef, ToolType } from './types';
import { WorldGraphModal } from './worldGraph';

class EditorApp {
  private assets = new AssetManager();
  private canvas!: EditorCanvas;
  private config: EditorConfigResponse | null = null;
  private currentFilename: string = '';
  private currentBackgroundId: string = '';
  private worldGraphModal = new WorldGraphModal();

  public async init() {
    const canvasElem = document.getElementById('editor-canvas') as HTMLCanvasElement;
    this.canvas = new EditorCanvas(canvasElem, this.assets, {
      onHoverTile: (x, y) => this.updateCoords(x, y),
      onSelectEnemy: (enemy, idx) => this.updateSelectedEnemy(enemy, idx),
      onSelectTransition: (trans, idx) => this.updateSelectedTransition(trans, idx),
      onSelectCable: (cable, idx) => this.updateSelectedCable(cable, idx),
      onSelectRoom: (room, idx) => this.updateSelectedRoom(room, idx),
      onSelectMobZone: (zone, idx) => this.updateSelectedMobZone(zone, idx),
      onToolChange: (tool) => {
        document.querySelectorAll('.tool-btn').forEach(btn => {
          const t = (btn as HTMLElement).dataset.tool;
          btn.classList.toggle('active', t === tool);
        });
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
      this.populateZoneEnemyDropdown();
      this.populateBackgroundDropdowns();
      this.populateLevelDropdown();
      this.populateWorldRegions();
      this.populateTransitionTargetLevels();
      this.setupNewTileModal();

      if (this.config?.world) {
        this.worldGraphModal.setWorld(this.config.world, (regionId) => this.handleSelectWorldRegion(regionId));
      }

      // Загружаем первый доступный уровень
      if (this.config?.levels && this.config.levels.length > 0) {
        this.loadLevel(this.config.levels[0].filename, this.config.levels[0].data);
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

  private populateLevelDropdown() {
    const select = document.getElementById('level-select') as HTMLSelectElement;
    select.innerHTML = '';

    if (!this.config?.levels || this.config.levels.length === 0) {
      select.innerHTML = '<option value="">Нет уровней</option>';
      return;
    }

    for (const lvl of this.config.levels) {
      const opt = document.createElement('option');
      opt.value = lvl.filename;
      opt.textContent = `${lvl.data.display_name || lvl.data.id} (${lvl.filename})`;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      const chosen = this.config?.levels.find(l => l.filename === select.value);
      if (chosen) {
        this.loadLevel(chosen.filename, chosen.data);
      }
    });
  }

  private loadLevel(filename: string, levelData: LevelDef) {
    this.currentFilename = filename;
    // Клонируем, чтобы работать независимо
    const clone: LevelDef = JSON.parse(JSON.stringify(levelData));
    this.canvas.setLevel(clone);

    const select = document.getElementById('level-select') as HTMLSelectElement;
    if (select.value !== filename) {
      select.value = filename;
    }

    this.syncSettingsForm();
    this.syncRoomsAndZonesUI();
    this.setStatus(`Загружен уровень: ${clone.display_name || clone.id}`);
  }

  private syncSettingsForm() {
    if (!this.canvas.level) return;
    const lvl = this.canvas.level;
    (document.getElementById('setting-level-id') as HTMLInputElement).value = lvl.id;
    (document.getElementById('setting-level-name') as HTMLInputElement).value = lvl.display_name || '';
    (document.getElementById('setting-level-width') as HTMLInputElement).value = lvl.width.toString();
    (document.getElementById('setting-level-height') as HTMLInputElement).value = lvl.height.toString();
    (document.getElementById('setting-level-tilesize') as HTMLInputElement).value = lvl.tile_size.toString();
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

      const header = document.createElement('div');
      header.className = 'boss-card-header';

      const crown = document.createElement('span');
      crown.className = 'boss-card-crown';
      crown.textContent = '👑';

      const name = document.createElement('span');
      name.className = 'boss-card-name';
      name.textContent = boss.display_name || boss.id;

      header.appendChild(crown);
      header.appendChild(name);
      card.appendChild(header);

      const stats = document.createElement('div');
      stats.className = 'boss-card-stats';
      stats.textContent = `Здоровье: ${boss.stats?.max_health ?? 350} HP | Урон: ${boss.stats?.contact_damage ?? 20} | Локация: ${boss.location_id || 'любая'}`;
      card.appendChild(stats);

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
        this.setTool('boss_spawn');
        this.setStatus(`👑 Выбран босс для спавна: ${boss.display_name}`);
      });

      container.appendChild(card);
    }

    // По умолчанию выбираем первого босса
    if (this.config.bosses.length > 0) {
      const firstBoss = this.config.bosses[0];
      this.canvas.selectedBossId = firstBoss.id;
      this.canvas.selectedBossDisplayName = firstBoss.display_name || firstBoss.id;
      const firstCard = container.querySelector('.boss-card');
      firstCard?.classList.add('active');
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
    if (!this.config?.levels) return;
    const matching = this.config.levels.find(l => l.data.id === regionId || l.filename === `${regionId}.json`);
    if (matching) {
      this.loadLevel(matching.filename, matching.data);
      this.setStatus(`Загружен уровень региона: ${matching.data.display_name || regionId}`);
    } else {
      const regDef = this.config.world?.regions.find(r => r.id === regionId);
      const name = regDef ? regDef.display_name : regionId;
      if (confirm(`Уровень для региона "${name}" еще не создан. Создать новый уровень "${regionId}.json"?`)) {
        const newLevel: LevelDef = {
          $schema: '../schemas/level.schema.json',
          id: regionId,
          display_name: name,
          background_id: 'bg_textalite',
          tile_size: 32,
          width: 32,
          height: 16,
          legend: { '#': 'platform_block', '.': null },
          rows: Array.from({ length: 16 }, (_, y) => (y === 15 ? '#'.repeat(32) : '.'.repeat(32))),
          player_spawn: { x: 2, y: 14 },
          enemies: []
        };
        const filename = `${regionId}.json`;
        this.config.levels.push({ filename, data: newLevel });
        this.populateLevelDropdown();
        this.populateTransitionTargetLevels();
        this.loadLevel(filename, newLevel);
        this.saveCurrentLevel();
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

    // Кнопки быстрого расширения границ (+1)
    document.getElementById('btn-quick-expand-top')?.addEventListener('click', () => this.canvas.expand('top', 1));
    document.getElementById('btn-quick-expand-bottom')?.addEventListener('click', () => this.canvas.expand('bottom', 1));
    document.getElementById('btn-quick-expand-left')?.addEventListener('click', () => this.canvas.expand('left', 1));
    document.getElementById('btn-quick-expand-right')?.addEventListener('click', () => this.canvas.expand('right', 1));

    // Форма изменения параметров и размеров уровня
    document.getElementById('level-settings-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.canvas.level) return;

      const lvl = this.canvas.level;
      const newId = (document.getElementById('setting-level-id') as HTMLInputElement).value.trim();
      const newName = (document.getElementById('setting-level-name') as HTMLInputElement).value.trim();
      const newW = parseInt((document.getElementById('setting-level-width') as HTMLInputElement).value, 10);
      const newH = parseInt((document.getElementById('setting-level-height') as HTMLInputElement).value, 10);
      const newBg = (document.getElementById('setting-level-bg') as HTMLSelectElement).value;

      if (!newId || newW < 5 || newH < 5) {
        alert('Некорректные параметры размера или ID');
        return;
      }

      lvl.id = newId;
      lvl.display_name = newName;
      lvl.background_id = newBg || undefined;

      // Изменение размера карты (rows)
      const oldRows = lvl.rows;
      const newRows: string[] = [];

      for (let y = 0; y < newH; y++) {
        let rowStr = '';
        if (y < oldRows.length) {
          const oldRow = oldRows[y];
          if (newW <= oldRow.length) {
            rowStr = oldRow.substring(0, newW);
          } else {
            rowStr = oldRow + '.'.repeat(newW - oldRow.length);
          }
        } else {
          rowStr = '.'.repeat(newW);
        }
        newRows.push(rowStr);
      }

      lvl.width = newW;
      lvl.height = newH;
      lvl.rows = newRows;

      // Обрезаем сущностей, выходящих за границы
      lvl.enemies = lvl.enemies.filter(en => en.x < newW && en.y < newH);
      if (lvl.player_spawn.x >= newW) lvl.player_spawn.x = newW - 1;
      if (lvl.player_spawn.y >= newH) lvl.player_spawn.y = newH - 1;

      this.canvas.saveStateToHistory();
      this.canvas.render();
      this.setStatus(`Размеры уровня обновлены: ${newW}x${newH}`);
    });

    // Модальное окно создания нового уровня
    const modal = document.getElementById('new-level-modal')!;
    document.getElementById('btn-new-level')?.addEventListener('click', () => {
      modal.classList.add('open');
    });
    document.getElementById('modal-cancel-btn')?.addEventListener('click', () => {
      modal.classList.remove('open');
    });

    document.getElementById('new-level-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = (document.getElementById('new-level-id') as HTMLInputElement).value.trim();
      const name = (document.getElementById('new-level-name') as HTMLInputElement).value.trim();
      const w = parseInt((document.getElementById('new-level-width') as HTMLInputElement).value, 10);
      const h = parseInt((document.getElementById('new-level-height') as HTMLInputElement).value, 10);
      const bg = (document.getElementById('new-level-bg') as HTMLSelectElement).value;

      if (!id || w < 5 || h < 5) return;

      const rows: string[] = [];
      for (let y = 0; y < h; y++) {
        if (y === h - 1) {
          rows.push('#'.repeat(w)); // нижний ряд из платформ
        } else {
          rows.push('.'.repeat(w));
        }
      }

      const newLevel: LevelDef = {
        $schema: '../schemas/level.schema.json',
        id,
        display_name: name,
        background_id: bg || undefined,
        tile_size: 32,
        width: w,
        height: h,
        legend: {
          '#': 'platform_block',
          '.': null
        },
        rows,
        player_spawn: { x: 2, y: h - 2 },
        enemies: []
      };

      const filename = `${id}.json`;
      if (!this.config) {
        this.config = { ld60Path: '', tiles: null, sprites: null, enemies: [], bosses: [], world: null, backgrounds: [], levels: [] };
      }
      this.config.levels.push({ filename, data: newLevel });

      this.populateLevelDropdown();
      this.loadLevel(filename, newLevel);
      modal.classList.remove('open');
      this.saveCurrentLevel();
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
