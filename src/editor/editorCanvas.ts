import type { AssetManager } from './assetManager';
import type { BackgroundDef, EnemyDef, EnemySpawnDef, EntityDragState, LevelDef, ResizeDirection, TileDef, ToolType } from './types';

export interface EditorCallbacks {
  onHoverTile?: (x: number, y: number) => void;
  onSelectEnemy?: (enemy: EnemySpawnDef | null, index: number) => void;
  onLevelChanged?: () => void;
  onStatusMessage?: (msg: string) => void;
}

interface CanvasButton {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
  action: () => void;
}

export class EditorCanvas {
  public canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private assets: AssetManager;

  // Данные
  public level: LevelDef | null = null;
  public tilesById = new Map<string, TileDef>();
  public enemiesById = new Map<string, EnemyDef>();
  public backgroundsById = new Map<string, BackgroundDef>();

  // Настройки отображения
  public showGrid: boolean = true;
  public showCollisions: boolean = false;
  public showBackground: boolean = true;
  public showEntities: boolean = true;

  // Камера
  public zoom: number = 2.0;
  public panX: number = 60;
  public panY: number = 60;

  // Текущий инструмент и выделение
  public activeTool: ToolType = 'brush';
  public selectedTileId: string | null = null;
  public selectedEnemyId: string | null = null;
  public selectedEnemySpriteId: string | null = null;
  public selectedEnemyIndex: number = -1;

  // Перетаскивание элементов (Drag-and-Drop)
  public dragState: EntityDragState | null = null;

  // Мышь и ввод
  private isMouseDown: boolean = false;
  private isPanning: boolean = false;
  private isSpaceDown: boolean = false;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  public hoveredTileX: number = -1;
  public hoveredTileY: number = -1;

  // Экранные кнопки манипуляторов границ
  private borderButtons: CanvasButton[] = [];

  // Undo / Redo
  private history: string[] = [];
  private historyIndex: number = -1;
  private maxHistory: number = 50;

  private callbacks: EditorCallbacks;

  constructor(canvas: HTMLCanvasElement, assets: AssetManager, callbacks: EditorCallbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.assets = assets;
    this.callbacks = callbacks;

    this.setupEvents();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  public setLevel(level: LevelDef) {
    this.level = level;
    this.history = [];
    this.historyIndex = -1;
    this.saveStateToHistory();
    this.centerView();
    this.render();
  }

  public resizeCanvas() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.render();
    }
  }

  public centerView() {
    if (!this.level) return;
    const levelPixelW = this.level.width * this.level.tile_size;
    const levelPixelH = this.level.height * this.level.tile_size;

    const availableW = this.canvas.width;
    const availableH = this.canvas.height;

    // Подбираем удобный зум
    const scaleX = (availableW - 120) / levelPixelW;
    const scaleY = (availableH - 120) / levelPixelH;
    this.zoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.5), 3.0);

    this.panX = Math.round((availableW - levelPixelW * this.zoom) / 2);
    this.panY = Math.round((availableH - levelPixelH * this.zoom) / 2);
    this.render();
  }

  // --- История изменений (Undo/Redo) ---
  public saveStateToHistory() {
    if (!this.level) return;
    const snapshot = JSON.stringify({
      rows: this.level.rows,
      legend: this.level.legend,
      player_spawn: this.level.player_spawn,
      enemies: this.level.enemies,
      width: this.level.width,
      height: this.level.height
    });

    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.historyIndex++;
    }
  }

  public undo() {
    if (this.historyIndex > 0 && this.level) {
      this.historyIndex--;
      const snapshot = JSON.parse(this.history[this.historyIndex]);
      this.level.rows = snapshot.rows;
      this.level.legend = snapshot.legend;
      this.level.player_spawn = snapshot.player_spawn;
      this.level.enemies = snapshot.enemies;
      this.level.width = snapshot.width;
      this.level.height = snapshot.height;
      this.callbacks.onLevelChanged?.();
      this.render();
      this.callbacks.onStatusMessage?.('Отмена (Undo)');
    }
  }

  public redo() {
    if (this.historyIndex < this.history.length - 1 && this.level) {
      this.historyIndex++;
      const snapshot = JSON.parse(this.history[this.historyIndex]);
      this.level.rows = snapshot.rows;
      this.level.legend = snapshot.legend;
      this.level.player_spawn = snapshot.player_spawn;
      this.level.enemies = snapshot.enemies;
      this.level.width = snapshot.width;
      this.level.height = snapshot.height;
      this.callbacks.onLevelChanged?.();
      this.render();
      this.callbacks.onStatusMessage?.('Повтор (Redo)');
    }
  }

  // --- Координатные преобразования ---
  public screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom
    };
  }

  public worldToTile(wx: number, wy: number): { tileX: number; tileY: number } {
    if (!this.level) return { tileX: -1, tileY: -1 };
    const ts = this.level.tile_size;
    return {
      tileX: Math.floor(wx / ts),
      tileY: Math.floor(wy / ts)
    };
  }

  // --- Расширение и сжатие границ карты ---
  public expand(direction: ResizeDirection, count: number = 1) {
    if (!this.level || count <= 0) return;
    const w = this.level.width;

    if (direction === 'top') {
      const newRows: string[] = [];
      for (let i = 0; i < count; i++) newRows.push('.'.repeat(w));
      this.level.rows = [...newRows, ...this.level.rows];
      this.level.height += count;
      this.level.player_spawn.y += count;
      this.level.enemies.forEach(e => (e.y += count));
      this.panY -= count * this.level.tile_size * this.zoom;
    } else if (direction === 'bottom') {
      for (let i = 0; i < count; i++) this.level.rows.push('.'.repeat(w));
      this.level.height += count;
    } else if (direction === 'left') {
      const prefix = '.'.repeat(count);
      this.level.rows = this.level.rows.map(r => prefix + r);
      this.level.width += count;
      this.level.player_spawn.x += count;
      this.level.enemies.forEach(e => (e.x += count));
      this.panX -= count * this.level.tile_size * this.zoom;
    } else if (direction === 'right') {
      const suffix = '.'.repeat(count);
      this.level.rows = this.level.rows.map(r => r + suffix);
      this.level.width += count;
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Границы расширены: ${this.level.width}x${this.level.height} (${direction})`);
    this.render();
  }

  public shrink(direction: ResizeDirection, count: number = 1) {
    if (!this.level || count <= 0) return;
    const w = this.level.width;
    const h = this.level.height;

    if (direction === 'top') {
      if (h <= count) return;
      this.level.rows = this.level.rows.slice(count);
      this.level.height -= count;
      this.level.player_spawn.y = Math.max(0, this.level.player_spawn.y - count);
      this.level.enemies.forEach(e => (e.y -= count));
      this.level.enemies = this.level.enemies.filter(e => e.y >= 0);
      this.panY += count * this.level.tile_size * this.zoom;
    } else if (direction === 'bottom') {
      if (h <= count) return;
      this.level.rows = this.level.rows.slice(0, h - count);
      this.level.height -= count;
      this.level.player_spawn.y = Math.min(this.level.height - 1, this.level.player_spawn.y);
      this.level.enemies = this.level.enemies.filter(e => e.y < this.level!.height);
    } else if (direction === 'left') {
      if (w <= count) return;
      this.level.rows = this.level.rows.map(r => r.slice(count));
      this.level.width -= count;
      this.level.player_spawn.x = Math.max(0, this.level.player_spawn.x - count);
      this.level.enemies.forEach(e => (e.x -= count));
      this.level.enemies = this.level.enemies.filter(e => e.x >= 0);
      this.panX += count * this.level.tile_size * this.zoom;
    } else if (direction === 'right') {
      if (w <= count) return;
      this.level.rows = this.level.rows.map(r => r.slice(0, w - count));
      this.level.width -= count;
      this.level.player_spawn.x = Math.min(this.level.width - 1, this.level.player_spawn.x);
      this.level.enemies = this.level.enemies.filter(e => e.x < this.level!.width);
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Границы сжаты: ${this.level.width}x${this.level.height} (${direction})`);
    this.render();
  }

  // --- Сдвиг всей геометрии карты ---
  public shiftMap(dx: number, dy: number) {
    if (!this.level) return;
    const w = this.level.width;
    const h = this.level.height;
    const oldRows = this.level.rows;
    const newRows: string[] = [];

    for (let y = 0; y < h; y++) {
      const srcY = y - dy;
      if (srcY >= 0 && srcY < h) {
        const oldRow = oldRows[srcY];
        let rowStr = '';
        for (let x = 0; x < w; x++) {
          const srcX = x - dx;
          if (srcX >= 0 && srcX < w) {
            rowStr += oldRow[srcX];
          } else {
            rowStr += '.';
          }
        }
        newRows.push(rowStr);
      } else {
        newRows.push('.'.repeat(w));
      }
    }

    this.level.rows = newRows;
    this.level.player_spawn.x = Math.min(Math.max(0, this.level.player_spawn.x + dx), w - 1);
    this.level.player_spawn.y = Math.min(Math.max(0, this.level.player_spawn.y + dy), h - 1);
    this.level.enemies.forEach(e => {
      e.x += dx;
      e.y += dy;
    });
    this.level.enemies = this.level.enemies.filter(e => e.x >= 0 && e.x < w && e.y >= 0 && e.y < h);

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Сдвиг карты на dx=${dx}, dy=${dy}`);
    this.render();
  }

  // --- События мыши и клавиатуры ---
  private setupEvents() {
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // 1. Проверяем клик по экранным кнопкам границ (+ / -)
      for (const btn of this.borderButtons) {
        if (sx >= btn.x && sx <= btn.x + btn.w && sy >= btn.y && sy <= btn.y + btn.h) {
          btn.action();
          return;
        }
      }

      // Панорамирование: средняя кнопка, зажатый Space или Alt+ЛКМ
      if (e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
        this.isPanning = true;
        return;
      }
      if (e.altKey && e.button === 0) {
        this.pickTileUnderCursor();
        return;
      }

      const world = this.screenToWorld(sx, sy);
      const { tileX, tileY } = this.worldToTile(world.x, world.y);

      // 2. Drag-and-Drop: перетаскивание спавна игрока или врагов
      if (this.level && e.button === 0 && (this.activeTool === 'move' || this.activeTool === 'select' || (!this.selectedTileId && this.activeTool === 'brush'))) {
        // Проверяем игрока
        if (tileX === this.level.player_spawn.x && tileY === this.level.player_spawn.y) {
          this.dragState = {
            type: 'player',
            index: -1,
            startX: tileX,
            startY: tileY,
            currentX: tileX,
            currentY: tileY
          };
          this.canvas.style.cursor = 'grabbing';
          this.callbacks.onStatusMessage?.('Перетаскивание спавна героя...');
          this.render();
          return;
        }

        // Проверяем врага
        const enemyIdx = this.level.enemies.findIndex(en => en.x === tileX && en.y === tileY);
        if (enemyIdx !== -1) {
          this.selectedEnemyIndex = enemyIdx;
          this.callbacks.onSelectEnemy?.(this.level.enemies[enemyIdx], enemyIdx);
          this.dragState = {
            type: 'enemy',
            index: enemyIdx,
            startX: tileX,
            startY: tileY,
            currentX: tileX,
            currentY: tileY
          };
          this.canvas.style.cursor = 'grabbing';
          this.callbacks.onStatusMessage?.(`Перетаскивание врага ${this.level.enemies[enemyIdx].enemy_id}...`);
          this.render();
          return;
        }
      }

      this.isMouseDown = true;
      this.handleDrawAction(e.button === 2);
    });

    window.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.isPanning) {
        this.panX += e.clientX - this.lastMouseX;
        this.panY += e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.render();
        return;
      }

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      const world = this.screenToWorld(sx, sy);
      const { tileX, tileY } = this.worldToTile(world.x, world.y);

      // Если идёт перетаскивание сущности
      if (this.dragState) {
        if (tileX !== this.dragState.currentX || tileY !== this.dragState.currentY) {
          this.dragState.currentX = tileX;
          this.dragState.currentY = tileY;
          this.callbacks.onHoverTile?.(tileX, tileY);
          this.render();
        }
        return;
      }

      // Курсор grab над сущностями в режиме Move или Select
      if (this.level && (this.activeTool === 'move' || this.activeTool === 'select')) {
        const isOverPlayer = tileX === this.level.player_spawn.x && tileY === this.level.player_spawn.y;
        const isOverEnemy = this.level.enemies.some(en => en.x === tileX && en.y === tileY);
        this.canvas.style.cursor = isOverPlayer || isOverEnemy ? 'grab' : 'crosshair';
      } else {
        this.canvas.style.cursor = 'default';
      }

      if (tileX !== this.hoveredTileX || tileY !== this.hoveredTileY) {
        this.hoveredTileX = tileX;
        this.hoveredTileY = tileY;
        this.callbacks.onHoverTile?.(tileX, tileY);
        if (this.isMouseDown) {
          this.handleDrawAction(e.buttons === 2);
        }
        this.render();
      }
    });

    window.addEventListener('mouseup', () => {
      // Завершение перетаскивания сущности
      if (this.dragState && this.level) {
        const cx = this.dragState.currentX;
        const cy = this.dragState.currentY;

        if (cx >= 0 && cx < this.level.width && cy >= 0 && cy < this.level.height) {
          if (this.dragState.type === 'player') {
            this.level.player_spawn = { x: cx, y: cy };
            this.callbacks.onStatusMessage?.(`Спавн героя перемещён в (${cx}, ${cy})`);
          } else if (this.dragState.type === 'enemy' && this.dragState.index >= 0) {
            this.level.enemies[this.dragState.index].x = cx;
            this.level.enemies[this.dragState.index].y = cy;
            this.callbacks.onStatusMessage?.(`Враг перемещён в (${cx}, ${cy})`);
          }
          this.saveStateToHistory();
          this.callbacks.onLevelChanged?.();
        }

        this.dragState = null;
        this.canvas.style.cursor = 'default';
        this.render();
        return;
      }

      if (this.isMouseDown) {
        this.saveStateToHistory();
      }
      this.isMouseDown = false;
      this.isPanning = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const worldBefore = this.screenToWorld(mouseX, mouseY);
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const newZoom = Math.min(Math.max(this.zoom * factor, 0.2), 10.0);

      this.panX = mouseX - worldBefore.x * newZoom;
      this.panY = mouseY - worldBefore.y * newZoom;
      this.zoom = newZoom;
      this.render();
    }, { passive: false });

    // Хоткеи
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') {
        return;
      }

      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.redo();
        return;
      }

      if (e.code === 'Space') {
        this.isSpaceDown = true;
      }

      // Стрелочки для сдвига карты (Shift + Arrows)
      if (e.shiftKey) {
        if (e.key === 'ArrowUp') { e.preventDefault(); this.shiftMap(0, -1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); this.shiftMap(0, 1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.shiftMap(-1, 0); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.shiftMap(1, 0); return; }
      }

      if (e.key === 'b' || e.key === 'B') this.setTool('brush');
      if (e.key === 'e' || e.key === 'E') this.setTool('eraser');
      if (e.key === 'g' || e.key === 'G') this.setTool('fill');
      if (e.key === 'm' || e.key === 'M') this.setTool('move');
      if (e.key === 'p' || e.key === 'P') this.setTool('player_spawn');
      if (e.key === 'o' || e.key === 'O') this.setTool('enemy_spawn');
      if (e.key === 'v' || e.key === 'V') this.setTool('select');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelectedEnemy();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpaceDown = false;
      }
    });
  }

  public setTool(tool: ToolType) {
    this.activeTool = tool;
    this.render();
  }

  // --- Логика инструментов ---
  private handleDrawAction(isRightClick: boolean) {
    if (!this.level) return;
    const x = this.hoveredTileX;
    const y = this.hoveredTileY;

    if (x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;

    if (isRightClick || this.activeTool === 'eraser') {
      this.setTile(x, y, null);
      this.render();
      return;
    }

    if (this.activeTool === 'brush') {
      if (this.selectedTileId) {
        this.setTile(x, y, this.selectedTileId);
        this.render();
      }
    } else if (this.activeTool === 'fill') {
      if (this.selectedTileId) {
        this.floodFill(x, y, this.selectedTileId);
        this.render();
      }
    } else if (this.activeTool === 'player_spawn') {
      this.level.player_spawn = { x, y };
      this.callbacks.onLevelChanged?.();
      this.callbacks.onStatusMessage?.(`Точка спавна игрока: (${x}, ${y})`);
      this.render();
    } else if (this.activeTool === 'enemy_spawn') {
      if (this.selectedEnemyId && this.selectedEnemySpriteId) {
        // Удаляем существующего врага в этой же клетке если есть
        this.level.enemies = this.level.enemies.filter(e => !(e.x === x && e.y === y));
        this.level.enemies.push({
          enemy_id: this.selectedEnemyId,
          sprite_id: this.selectedEnemySpriteId,
          x,
          y
        });
        this.callbacks.onLevelChanged?.();
        this.callbacks.onStatusMessage?.(`Добавлен враг ${this.selectedEnemyId} на (${x}, ${y})`);
        this.render();
      }
    } else if (this.activeTool === 'select') {
      const foundIdx = this.level.enemies.findIndex(e => e.x === x && e.y === y);
      if (foundIdx !== -1) {
        this.selectedEnemyIndex = foundIdx;
        this.callbacks.onSelectEnemy?.(this.level.enemies[foundIdx], foundIdx);
        this.callbacks.onStatusMessage?.(`Выбран враг: ${this.level.enemies[foundIdx].enemy_id}`);
      } else {
        this.selectedEnemyIndex = -1;
        this.callbacks.onSelectEnemy?.(null, -1);
      }
      this.render();
    }
  }

  private pickTileUnderCursor() {
    if (!this.level || this.hoveredTileX < 0 || this.hoveredTileY < 0) return;
    const x = this.hoveredTileX;
    const y = this.hoveredTileY;
    if (x >= this.level.width || y >= this.level.height) return;

    const ch = this.level.rows[y][x];
    const tileId = this.level.legend[ch];
    if (tileId) {
      this.selectedTileId = tileId;
      this.setTool('brush');
      this.callbacks.onStatusMessage?.(`Пипетка: выбран тайл "${tileId}"`);
      this.render();
    }
  }

  private setTile(x: number, y: number, tileId: string | null) {
    if (!this.level) return;

    // Находим или создаем символ для tileId в легенде
    let targetChar = '.';
    if (tileId !== null) {
      let found = Object.entries(this.level.legend).find(([_, id]) => id === tileId);
      if (found) {
        targetChar = found[0];
      } else {
        // Ищем свободный символ: #, =, %, @, A-Z, 1-9
        const candidates = '#=@%*+ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
        const used = new Set(Object.keys(this.level.legend));
        let pick = candidates.split('').find(c => !used.has(c)) || '$';
        this.level.legend[pick] = tileId;
        targetChar = pick;
      }
    } else {
      // Ищем символ для пустоты (null)
      let foundEmpty = Object.entries(this.level.legend).find(([_, id]) => id === null);
      if (foundEmpty) {
        targetChar = foundEmpty[0];
      } else {
        targetChar = '.';
        this.level.legend['.'] = null;
      }
    }

    const row = this.level.rows[y];
    if (row[x] !== targetChar) {
      this.level.rows[y] = row.substring(0, x) + targetChar + row.substring(x + 1);
      this.callbacks.onLevelChanged?.();
    }
  }

  private floodFill(startX: number, startY: number, newTileId: string) {
    if (!this.level) return;
    const originalChar = this.level.rows[startY][startX];

    // Ищем символ для newTileId
    let targetChar = '#';
    let found = Object.entries(this.level.legend).find(([_, id]) => id === newTileId);
    if (found) targetChar = found[0];
    else {
      targetChar = '#';
      this.level.legend['#'] = newTileId;
    }

    if (originalChar === targetChar) return;

    const w = this.level.width;
    const h = this.level.height;
    const visited = new Uint8Array(w * h);
    const queue: [number, number][] = [[startX, startY]];

    while (queue.length > 0) {
      const [cx, cy] = queue.pop()!;
      const idx = cy * w + cx;
      if (visited[idx]) continue;
      visited[idx] = 1;

      if (this.level.rows[cy][cx] !== originalChar) continue;

      this.level.rows[cy] = this.level.rows[cy].substring(0, cx) + targetChar + this.level.rows[cy].substring(cx + 1);

      if (cx > 0) queue.push([cx - 1, cy]);
      if (cx < w - 1) queue.push([cx + 1, cy]);
      if (cy > 0) queue.push([cx, cy - 1]);
      if (cy < h - 1) queue.push([cx, cy + 1]);
    }

    this.callbacks.onLevelChanged?.();
  }

  public deleteSelectedEnemy() {
    if (!this.level || this.selectedEnemyIndex === -1) return;
    const deleted = this.level.enemies.splice(this.selectedEnemyIndex, 1);
    this.selectedEnemyIndex = -1;
    this.callbacks.onSelectEnemy?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалён враг ${deleted[0]?.enemy_id}`);
    this.render();
  }

  // --- Главный цикл рендера ---
  public render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Фон редактора (тёмный графит с микросеткой)
    ctx.fillStyle = '#111318';
    ctx.fillRect(0, 0, w, h);

    if (!this.level) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Уровень не загружен. Выберите или создайте уровень в левой панели.', w / 2, h / 2);
      return;
    }

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Пиксель-арт без сглаживания
    ctx.imageSmoothingEnabled = false;

    const ts = this.level.tile_size;
    const levelPixelW = this.level.width * ts;
    const levelPixelH = this.level.height * ts;

    // 1. Отрисовка параллакс-фона / цвета неба уровня
    if (this.showBackground) {
      const bgDef = this.level.background_id ? this.backgroundsById.get(this.level.background_id) : undefined;
      ctx.fillStyle = bgDef?.sky_color || '#161922';
      ctx.fillRect(0, 0, levelPixelW, levelPixelH);

      if (bgDef && bgDef.layers) {
        for (const layer of bgDef.layers) {
          // Отрисовываем нижний слой фона в пределах границ уровня
          const spriteDef = this.assets.getSpriteDef(layer.sprite_id);
          if (spriteDef) {
            const img = this.assets.getImage(spriteDef.image);
            if (img) {
              const bgH = spriteDef.frame_height * (bgDef.scale || 1);
              const bgW = spriteDef.frame_width * (bgDef.scale || 1);
              const bgY = levelPixelH - bgH;
              // Заполняем по ширине уровня
              for (let bx = 0; bx < levelPixelW; bx += bgW) {
                ctx.drawImage(img, 0, 0, spriteDef.frame_width, spriteDef.frame_height, bx, bgY, bgW, bgH);
              }
            }
          }
        }
      }
    } else {
      ctx.fillStyle = '#1e232f';
      ctx.fillRect(0, 0, levelPixelW, levelPixelH);
    }

    // 2. Отрисовка тайлов
    for (let cy = 0; cy < this.level.height; cy++) {
      const row = this.level.rows[cy];
      if (!row) continue;
      for (let cx = 0; cx < this.level.width; cx++) {
        const ch = row[cx];
        const tileId = this.level.legend[ch];
        if (tileId) {
          const tile = this.tilesById.get(tileId);
          if (tile) {
            this.assets.drawSprite(ctx, tile.sprite_id, cx * ts, cy * ts, 0, ts, ts);
          } else {
            // Запасной цветной блок
            ctx.fillStyle = '#4ade80';
            ctx.fillRect(cx * ts, cy * ts, ts, ts);
          }

          // Оверлей твердости/коллизии
          if (this.showCollisions && tile?.solid) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
            ctx.fillRect(cx * ts, cy * ts, ts, ts);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx * ts + 0.5, cy * ts + 0.5, ts - 1, ts - 1);
          }
        }
      }
    }

    // 3. Отрисовка сущностей (Игрок и Враги)
    if (this.showEntities) {
      // Игрок (если не перетаскивается)
      const px = this.level.player_spawn.x;
      const py = this.level.player_spawn.y;
      const isDraggingPlayer = this.dragState?.type === 'player';

      if (!isDraggingPlayer) {
        this.assets.drawEntityAtTile(ctx, 'player', px, py, ts);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(px * ts + 2, py * ts - 8, ts - 4, 10);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('HERO', (px + 0.5) * ts, py * ts);
      }

      // Враги
      this.level.enemies.forEach((enemy, idx) => {
        const isDraggingThis = this.dragState?.type === 'enemy' && this.dragState.index === idx;
        if (isDraggingThis) return;

        const isSelected = idx === this.selectedEnemyIndex;
        this.assets.drawEntityAtTile(ctx, enemy.sprite_id, enemy.x, enemy.y, ts);

        const ey = enemy.y * ts;
        const ex = (enemy.x + 0.5) * ts;
        ctx.fillStyle = isSelected ? '#eab308' : '#ef4444';
        ctx.fillRect(enemy.x * ts + 2, ey - 7, ts - 4, 9);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 7px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(enemy.enemy_id.slice(0, 5).toUpperCase(), ex, ey);

        if (isSelected) {
          ctx.strokeStyle = '#eab308';
          ctx.lineWidth = 2;
          ctx.strokeRect(enemy.x * ts - 1, enemy.y * ts - 1, ts + 2, ts + 2);
        }
      });
    }

    // 4. Отрисовка перетаскиваемой сущности (Drag-and-Drop)
    if (this.dragState) {
      const gx = this.dragState.currentX;
      const gy = this.dragState.currentY;

      // Подсветка целевой клетки
      ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
      ctx.fillRect(gx * ts, gy * ts, ts, ts);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.strokeRect(gx * ts, gy * ts, ts, ts);

      if (this.dragState.type === 'player') {
        this.assets.drawEntityAtTile(ctx, 'player', gx, gy, ts);
        ctx.fillStyle = '#10b981';
        ctx.fillRect(gx * ts + 2, gy * ts - 10, ts - 4, 11);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('MOVE HERO', (gx + 0.5) * ts, gy * ts - 1);
      } else if (this.dragState.type === 'enemy' && this.dragState.index >= 0) {
        const enemy = this.level.enemies[this.dragState.index];
        this.assets.drawEntityAtTile(ctx, enemy.sprite_id, gx, gy, ts);
        ctx.fillStyle = '#eab308';
        ctx.fillRect(gx * ts + 2, gy * ts - 10, ts - 4, 11);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('MOVE ENEMY', (gx + 0.5) * ts, gy * ts - 1);
      }
    }

    // 5. Сетка
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1 / this.zoom;
      ctx.beginPath();
      for (let x = 0; x <= levelPixelW; x += ts) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, levelPixelH);
      }
      for (let y = 0; y <= levelPixelH; y += ts) {
        ctx.moveTo(0, y);
        ctx.lineTo(levelPixelW, y);
      }
      ctx.stroke();

      // Внешняя рамка уровня
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2 / this.zoom;
      ctx.strokeRect(0, 0, levelPixelW, levelPixelH);
    }

    // 6. Превью курсора / активного инструмента
    if (this.hoveredTileX >= 0 && this.hoveredTileX < this.level.width &&
        this.hoveredTileY >= 0 && this.hoveredTileY < this.level.height && !this.dragState) {
      const hx = this.hoveredTileX * ts;
      const hy = this.hoveredTileY * ts;

      if (this.activeTool === 'brush' && this.selectedTileId) {
        const tile = this.tilesById.get(this.selectedTileId);
        if (tile) {
          ctx.save();
          ctx.globalAlpha = 0.6;
          this.assets.drawSprite(ctx, tile.sprite_id, hx, hy, 0, ts, ts);
          ctx.restore();
        }
      } else if (this.activeTool === 'eraser') {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.fillRect(hx, hy, ts, ts);
      } else if (this.activeTool === 'player_spawn') {
        ctx.save();
        ctx.globalAlpha = 0.5;
        this.assets.drawEntityAtTile(ctx, 'player', this.hoveredTileX, this.hoveredTileY, ts);
        ctx.restore();
      } else if (this.activeTool === 'enemy_spawn' && this.selectedEnemySpriteId) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        this.assets.drawEntityAtTile(ctx, this.selectedEnemySpriteId, this.hoveredTileX, this.hoveredTileY, ts);
        ctx.restore();
      }

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2 / this.zoom;
      ctx.strokeRect(hx, hy, ts, ts);
    }

    ctx.restore();

    // 7. Экранные кнопки расширения/сжатия границ
    this.renderBoundaryControls(levelPixelW, levelPixelH);
  }

  private renderBoundaryControls(levelW: number, levelH: number) {
    const ctx = this.ctx;
    const btnH = 22;
    const pad = 8;

    const screenLeft = this.panX;
    const screenRight = this.panX + levelW * this.zoom;
    const screenTop = this.panY;
    const screenBottom = this.panY + levelH * this.zoom;
    const midX = (screenLeft + screenRight) / 2;
    const midY = (screenTop + screenBottom) / 2;

    const addBtn = (x: number, y: number, w: number, h: number, label: string, color: string, action: () => void) => {
      this.borderButtons.push({ x, y, w, h, label, color, action });

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = '#384259';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2);
    };

    // 1. Верхние кнопки (+ / - ряда сверху)
    addBtn(midX - 38, screenTop - btnH - pad, 36, btnH, '+ ▲', '#4338ca', () => this.expand('top', 1));
    addBtn(midX + 2, screenTop - btnH - pad, 36, btnH, '- ▼', '#991b1b', () => this.shrink('top', 1));

    // 2. Нижние кнопки (+ / - ряда снизу)
    addBtn(midX - 38, screenBottom + pad, 36, btnH, '+ ▼', '#4338ca', () => this.expand('bottom', 1));
    addBtn(midX + 2, screenBottom + pad, 36, btnH, '- ▲', '#991b1b', () => this.shrink('bottom', 1));

    // 3. Левые кнопки (+ / - колонки слева)
    addBtn(screenLeft - pad - 42, midY - 14, 38, btnH, '+ ◀', '#4338ca', () => this.expand('left', 1));
    addBtn(screenLeft - pad - 42, midY + 14, 38, btnH, '- ▶', '#991b1b', () => this.shrink('left', 1));

    // 4. Правые кнопки (+ / - колонки справа)
    addBtn(screenRight + pad, midY - 14, 38, btnH, '+ ▶', '#4338ca', () => this.expand('right', 1));
    addBtn(screenRight + pad, midY + 14, 38, btnH, '- ◀', '#991b1b', () => this.shrink('right', 1));
  }
}
