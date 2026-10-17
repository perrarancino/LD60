import { AssetManager } from './assetManager';
import { EditorCanvas } from './editorCanvas';
import type { CableDef, EditorConfigResponse, EnemySpawnDef, LevelDef, LevelTransitionDef, TileDef, ToolType } from './types';
import { WorldGraphModal } from './worldGraph';

class EditorApp {
  private assets = new AssetManager();
  private canvas!: EditorCanvas;
  private config: EditorConfigResponse | null = null;
  private currentFilename: string = '';
  private worldGraphModal = new WorldGraphModal();

  public async init() {
    const canvasElem = document.getElementById('editor-canvas') as HTMLCanvasElement;
    this.canvas = new EditorCanvas(canvasElem, this.assets, {
      onHoverTile: (x, y) => this.updateCoords(x, y),
      onSelectEnemy: (enemy, idx) => this.updateSelectedEnemy(enemy, idx),
      onSelectTransition: (trans, idx) => this.updateSelectedTransition(trans, idx),
      onSelectCable: (cable, idx) => this.updateSelectedCable(cable, idx),
      onPlaytestToggle: (active) => this.updatePlaytestUI(active),
      onLevelChanged: () => this.syncSettingsForm(),
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

    settingBg.innerHTML = '<option value="">Без фона</option>';
    newBg.innerHTML = '<option value="">Без фона</option>';

    if (this.config?.backgrounds) {
      for (const bg of this.config.backgrounds) {
        const opt1 = document.createElement('option');
        opt1.value = bg.id;
        opt1.textContent = bg.id;
        settingBg.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = bg.id;
        opt2.textContent = bg.id;
        newBg.appendChild(opt2);
      }
    }
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
    (document.getElementById('setting-level-bg') as HTMLSelectElement).value = lvl.background_id || '';
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
      'tab-enemies-btn': 'tab-enemies',
      'tab-decor-btn': 'tab-decor',
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

    // Верхняя панель: Instant Playtest & World Graph
    document.getElementById('btn-playtest')?.addEventListener('click', () => {
      this.canvas.togglePlaytest();
    });

    document.getElementById('btn-world-graph')?.addEventListener('click', () => {
      this.worldGraphModal.open(this.getCurrentRegionId());
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
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new EditorApp();
  app.init();
});
