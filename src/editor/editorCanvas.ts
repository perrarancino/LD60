import { GAME_CONFIG } from '../core/Constants';
import type { AssetManager } from './assetManager';
import type { BackgroundDef, CableDef, EnemyDef, EnemySpawnDef, EntityDragState, LevelDef, LevelTransitionDef, PlaytestState, ResizeDirection, TileDef, ToolType } from './types';

export interface EditorCallbacks {
  onHoverTile?: (x: number, y: number) => void;
  onSelectEnemy?: (enemy: EnemySpawnDef | null, index: number) => void;
  onSelectTransition?: (transition: LevelTransitionDef | null, index: number) => void;
  onSelectCable?: (cable: CableDef | null, index: number) => void;
  onPlaytestToggle?: (active: boolean) => void;
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
  public showJumpArc: boolean = true;
  public autotileEnabled: boolean = false;

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
  public selectedTransitionIndex: number = -1;
  public selectedCableIndex: number = -1;

  // Провода (Cable Tool)
  public currentCableStart: { x: number; y: number } | null = null;
  public cableSag: number = 35;
  public cableColor: string = '#ef4444';
  public cableThickness: number = 3;
  public cableType: 'sata' | 'power' | 'ide' | 'ground' = 'sata';

  // Instant Playtest
  public playtest: PlaytestState = {
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    grounded: false,
    facing: 1,
    coyoteTimer: 0,
    jumpBufferTimer: 0
  };
  private playtestKeys = new Set<string>();
  private playtestAnimFrame: number | null = null;
  private lastPlaytestTime: number = 0;
  private savedPanBeforePlaytest: { x: number; y: number; zoom: number } | null = null;

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
      transitions: this.level.transitions || [],
      cables: this.level.cables || [],
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
      this.level.transitions = snapshot.transitions || [];
      this.level.cables = snapshot.cables || [];
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
      this.level.transitions = snapshot.transitions || [];
      this.level.cables = snapshot.cables || [];
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
    const ts = this.level.tile_size;

    if (direction === 'top') {
      const newRows: string[] = [];
      for (let i = 0; i < count; i++) newRows.push('.'.repeat(w));
      this.level.rows = [...newRows, ...this.level.rows];
      this.level.height += count;
      this.level.player_spawn.y += count;
      this.level.enemies.forEach(e => (e.y += count));
      if (this.level.transitions) this.level.transitions.forEach(t => (t.y += count));
      if (this.level.cables) this.level.cables.forEach(c => { c.y1 += count * ts; c.y2 += count * ts; });
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
      if (this.level.transitions) this.level.transitions.forEach(t => (t.x += count));
      if (this.level.cables) this.level.cables.forEach(c => { c.x1 += count * ts; c.x2 += count * ts; });
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
    const ts = this.level.tile_size;

    if (direction === 'top') {
      if (h <= count) return;
      this.level.rows = this.level.rows.slice(count);
      this.level.height -= count;
      this.level.player_spawn.y = Math.max(0, this.level.player_spawn.y - count);
      this.level.enemies.forEach(e => (e.y -= count));
      this.level.enemies = this.level.enemies.filter(e => e.y >= 0);
      if (this.level.transitions) {
        this.level.transitions.forEach(t => (t.y -= count));
        this.level.transitions = this.level.transitions.filter(t => t.y >= 0);
      }
      if (this.level.cables) {
        this.level.cables.forEach(c => { c.y1 -= count * ts; c.y2 -= count * ts; });
      }
      this.panY += count * this.level.tile_size * this.zoom;
    } else if (direction === 'bottom') {
      if (h <= count) return;
      this.level.rows = this.level.rows.slice(0, h - count);
      this.level.height -= count;
      this.level.player_spawn.y = Math.min(this.level.height - 1, this.level.player_spawn.y);
      this.level.enemies = this.level.enemies.filter(e => e.y < this.level!.height);
      if (this.level.transitions) {
        this.level.transitions = this.level.transitions.filter(t => t.y < this.level!.height);
      }
    } else if (direction === 'left') {
      if (w <= count) return;
      this.level.rows = this.level.rows.map(r => r.slice(count));
      this.level.width -= count;
      this.level.player_spawn.x = Math.max(0, this.level.player_spawn.x - count);
      this.level.enemies.forEach(e => (e.x -= count));
      this.level.enemies = this.level.enemies.filter(e => e.x >= 0);
      if (this.level.transitions) {
        this.level.transitions.forEach(t => (t.x -= count));
        this.level.transitions = this.level.transitions.filter(t => t.x >= 0);
      }
      if (this.level.cables) {
        this.level.cables.forEach(c => { c.x1 -= count * ts; c.x2 -= count * ts; });
      }
      this.panX += count * this.level.tile_size * this.zoom;
    } else if (direction === 'right') {
      if (w <= count) return;
      this.level.rows = this.level.rows.map(r => r.slice(0, w - count));
      this.level.width -= count;
      this.level.player_spawn.x = Math.min(this.level.width - 1, this.level.player_spawn.x);
      this.level.enemies = this.level.enemies.filter(e => e.x < this.level!.width);
      if (this.level.transitions) {
        this.level.transitions = this.level.transitions.filter(t => t.x < this.level!.width);
      }
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
    const ts = this.level.tile_size;
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

    if (this.level.transitions) {
      this.level.transitions.forEach(t => {
        t.x += dx;
        t.y += dy;
      });
      this.level.transitions = this.level.transitions.filter(t => t.x >= 0 && t.x < w && t.y >= 0 && t.y < h);
    }

    if (this.level.cables) {
      this.level.cables.forEach(c => {
        c.x1 += dx * ts;
        c.y1 += dy * ts;
        c.x2 += dx * ts;
        c.y2 += dy * ts;
      });
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Сдвиг карты на dx=${dx}, dy=${dy}`);
    this.render();
  }

  // --- События мыши и клавиатуры ---
  private setupEvents() {
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      if (this.playtest.active) {
        // Клик в режиме теста не изменяет карту
        return;
      }

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

      // 2. Инструмент кабелей (Cable Tool)
      if (this.activeTool === 'cable') {
        if (e.button === 0) {
          if (!this.currentCableStart) {
            this.currentCableStart = { x: world.x, y: world.y };
            this.callbacks.onStatusMessage?.('Кликните вторую точку для закрепления провода (ПКМ для отмены)');
            this.render();
            return;
          } else {
            const newCable: CableDef = {
              id: `cable_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
              x1: Math.round(this.currentCableStart.x),
              y1: Math.round(this.currentCableStart.y),
              x2: Math.round(world.x),
              y2: Math.round(world.y),
              sag: this.cableSag,
              color: this.cableColor,
              thickness: this.cableThickness,
              type: this.cableType
            };
            this.level = this.level || null;
            if (this.level) {
              this.level.cables = this.level.cables || [];
              this.level.cables.push(newCable);
              this.selectedCableIndex = this.level.cables.length - 1;
              this.callbacks.onSelectCable?.(newCable, this.selectedCableIndex);
            }
            this.currentCableStart = null;
            this.saveStateToHistory();
            this.callbacks.onLevelChanged?.();
            this.callbacks.onStatusMessage?.(`Кабель протянут (${newCable.type || 'обычный'})`);
            this.render();
            return;
          }
        } else if (e.button === 2) {
          if (this.currentCableStart) {
            this.currentCableStart = null;
            this.callbacks.onStatusMessage?.('Создание кабеля отменено');
            this.render();
            return;
          }
        }
      }

      // 3. Инструмент переходов / дверей (Transition Tool)
      if (this.activeTool === 'transition') {
        if (e.button === 0 && this.level && tileX >= 0 && tileX < this.level.width && tileY >= 0 && tileY < this.level.height) {
          const transitions = this.level.transitions || [];
          const existingIdx = transitions.findIndex(t =>
            tileX >= t.x && tileX < t.x + t.width && tileY >= t.y && tileY < t.y + t.height
          );
          if (existingIdx !== -1) {
            this.selectedTransitionIndex = existingIdx;
            this.callbacks.onSelectTransition?.(transitions[existingIdx], existingIdx);
            this.callbacks.onStatusMessage?.(`Выбран шлюз: ${transitions[existingIdx].id}`);
            this.render();
            return;
          }

          const newTrans: LevelTransitionDef = {
            id: `trans_${tileX}_${tileY}`,
            x: tileX,
            y: tileY,
            width: 1,
            height: 2,
            target_level: 'loc_motherboard',
            target_spawn: { x: 2, y: 14 },
            label: 'Шлюз'
          };
          this.level.transitions = this.level.transitions || [];
          this.level.transitions.push(newTrans);
          this.selectedTransitionIndex = this.level.transitions.length - 1;
          this.callbacks.onSelectTransition?.(newTrans, this.selectedTransitionIndex);
          this.saveStateToHistory();
          this.callbacks.onLevelChanged?.();
          this.callbacks.onStatusMessage?.(`Создан переход на клетке (${tileX}, ${tileY})`);
          this.render();
          return;
        }
      }

      // 4. Drag-and-Drop и Выбор (Move / Select)
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

        // Проверяем переход
        if (this.level.transitions) {
          const transIdx = this.level.transitions.findIndex(t =>
            tileX >= t.x && tileX < t.x + t.width && tileY >= t.y && tileY < t.y + t.height
          );
          if (transIdx !== -1) {
            this.selectedTransitionIndex = transIdx;
            this.callbacks.onSelectTransition?.(this.level.transitions[transIdx], transIdx);
            this.render();
            return;
          }
        }

        // Проверяем клик рядом с кабелем
        if (this.level.cables) {
          for (let i = 0; i < this.level.cables.length; i++) {
            const c = this.level.cables[i];
            const midX = (c.x1 + c.x2) / 2;
            const midY = (c.y1 + c.y2) / 2 + c.sag;
            // Проверка расстояния до кривой Безье
            let minDist = 999;
            for (let t = 0; t <= 1; t += 0.1) {
              const bx = (1 - t) * (1 - t) * c.x1 + 2 * (1 - t) * t * midX + t * t * c.x2;
              const by = (1 - t) * (1 - t) * c.y1 + 2 * (1 - t) * t * midY + t * t * c.y2;
              const dist = Math.hypot(world.x - bx, world.y - by);
              if (dist < minDist) minDist = dist;
            }
            if (minDist < 12) {
              this.selectedCableIndex = i;
              this.callbacks.onSelectCable?.(c, i);
              this.callbacks.onStatusMessage?.(`Выбран кабель: ${c.type || 'standard'}`);
              this.render();
              return;
            }
          }
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

      if (this.playtest.active) {
        return;
      }

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

      // Превью протягивания кабеля
      if (this.activeTool === 'cable' && this.currentCableStart) {
        this.hoveredTileX = tileX;
        this.hoveredTileY = tileY;
        this.render();
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

      // Управление во время Instant Playtest
      if (this.playtest.active) {
        if (e.key === 'Escape' || e.code === 'KeyP') {
          e.preventDefault();
          this.stopPlaytest();
          return;
        }
        this.playtestKeys.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
          e.preventDefault();
        }
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

      if (e.code === 'KeyP') { e.preventDefault(); this.togglePlaytest(); return; }
      if (e.key === 'b' || e.key === 'B') this.setTool('brush');
      if (e.key === 'e' || e.key === 'E') this.setTool('eraser');
      if (e.key === 'g' || e.key === 'G') this.setTool('fill');
      if (e.key === 'm' || e.key === 'M') this.setTool('move');
      if (e.key === 'h' || e.key === 'H') this.setTool('player_spawn');
      if (e.key === 'o' || e.key === 'O') this.setTool('enemy_spawn');
      if (e.key === 'v' || e.key === 'V') this.setTool('select');
      if (e.key === 'd' || e.key === 'D') this.setTool('transition');
      if (e.key === 'c' || e.key === 'C') this.setTool('cable');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelected();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.playtest.active) {
        this.playtestKeys.delete(e.code);
        return;
      }
      if (e.code === 'Space') {
        this.isSpaceDown = false;
      }
    });
  }

  public setTool(tool: ToolType) {
    this.activeTool = tool;
    this.render();
  }

  // --- Instant Playtest (Встроенное тестирование уровня) ---
  public togglePlaytest() {
    if (this.playtest.active) {
      this.stopPlaytest();
    } else {
      this.startPlaytest();
    }
  }

  public startPlaytest() {
    if (!this.level || this.playtest.active) return;
    this.savedPanBeforePlaytest = { x: this.panX, y: this.panY, zoom: this.zoom };
    this.playtest.active = true;
    const ts = this.level.tile_size;
    this.playtest.x = (this.level.player_spawn.x + 0.5) * ts;
    this.playtest.y = (this.level.player_spawn.y + 1) * ts;
    this.playtest.vx = 0;
    this.playtest.vy = 0;
    this.playtest.grounded = true;
    this.playtest.facing = 1;
    this.playtest.coyoteTimer = 0;
    this.playtest.jumpBufferTimer = 0;
    this.playtestKeys.clear();
    this.lastPlaytestTime = performance.now();

    const loop = (time: number) => {
      if (!this.playtest.active) return;
      this.updatePlaytest(time);
      this.render();
      this.playtestAnimFrame = requestAnimationFrame(loop);
    };
    this.playtestAnimFrame = requestAnimationFrame(loop);
    this.callbacks.onPlaytestToggle?.(true);
    this.callbacks.onStatusMessage?.('▶️ ТЕСТ: [A][D]/Стрелки — бег | [Пробел]/[W] — прыжок | [Esc]/[P] — выход в редактор');
  }

  public stopPlaytest() {
    if (!this.playtest.active) return;
    this.playtest.active = false;
    if (this.playtestAnimFrame !== null) {
      cancelAnimationFrame(this.playtestAnimFrame);
      this.playtestAnimFrame = null;
    }
    this.playtestKeys.clear();
    if (this.savedPanBeforePlaytest) {
      this.panX = this.savedPanBeforePlaytest.x;
      this.panY = this.savedPanBeforePlaytest.y;
      this.zoom = this.savedPanBeforePlaytest.zoom;
    }
    this.callbacks.onPlaytestToggle?.(false);
    this.callbacks.onStatusMessage?.('Режим тестирования завершён');
    this.render();
  }

  public isSolidAtPixel(px: number, py: number): boolean {
    if (!this.level) return false;
    const ts = this.level.tile_size;
    const tx = Math.floor(px / ts);
    const ty = Math.floor(py / ts);
    if (ty >= this.level.height) return true; // пол
    if (tx < 0 || tx >= this.level.width || ty < 0) return true; // границы
    const row = this.level.rows[ty];
    if (!row) return false;
    const ch = row[tx];
    const tileId = this.level.legend[ch];
    if (!tileId) return false;
    return !!this.tilesById.get(tileId)?.solid;
  }

  private updatePlaytest(time: number) {
    if (!this.level) return;
    const dt = Math.min((time - this.lastPlaytestTime) / 1000, 0.05);
    this.lastPlaytestTime = time;

    const left = this.playtestKeys.has('KeyA') || this.playtestKeys.has('ArrowLeft');
    const right = this.playtestKeys.has('KeyD') || this.playtestKeys.has('ArrowRight');
    const jump = this.playtestKeys.has('Space') || this.playtestKeys.has('KeyW') || this.playtestKeys.has('ArrowUp');

    // Горизонтальный ввод
    if (left && !right) {
      this.playtest.vx = -GAME_CONFIG.PLAYER_SPEED;
      this.playtest.facing = -1;
    } else if (right && !left) {
      this.playtest.vx = GAME_CONFIG.PLAYER_SPEED;
      this.playtest.facing = 1;
    } else {
      this.playtest.vx = 0;
    }

    // Буфер прыжка
    if (jump) {
      this.playtest.jumpBufferTimer = GAME_CONFIG.JUMP_BUFFER_SEC;
    } else if (this.playtest.jumpBufferTimer > 0) {
      this.playtest.jumpBufferTimer -= dt;
    }

    // Таймер койот-тайма
    if (this.playtest.grounded) {
      this.playtest.coyoteTimer = GAME_CONFIG.COYOTE_TIME_SEC;
    } else if (this.playtest.coyoteTimer > 0) {
      this.playtest.coyoteTimer -= dt;
    }

    // Прыжок
    if (this.playtest.jumpBufferTimer > 0 && this.playtest.coyoteTimer > 0) {
      this.playtest.vy = GAME_CONFIG.JUMP_FORCE;
      this.playtest.grounded = false;
      this.playtest.coyoteTimer = 0;
      this.playtest.jumpBufferTimer = 0;
    }

    // Гравитация
    this.playtest.vy += GAME_CONFIG.GRAVITY * dt;

    // Разрешение AABB коллизий (хитбокс игрока: ширина 18px, высота 28px)
    const halfW = 9;
    const pHeight = 28;

    // 1. Горизонтальное перемещение
    const newX = this.playtest.x + this.playtest.vx * dt;
    const testPointsY = [this.playtest.y - pHeight + 2, this.playtest.y - pHeight / 2, this.playtest.y - 2];
    let colX = false;

    if (this.playtest.vx > 0) {
      const rightX = newX + halfW;
      for (const py of testPointsY) {
        if (this.isSolidAtPixel(rightX, py)) {
          colX = true;
          const ts = this.level.tile_size;
          this.playtest.x = Math.floor(rightX / ts) * ts - halfW - 0.05;
          this.playtest.vx = 0;
          break;
        }
      }
    } else if (this.playtest.vx < 0) {
      const leftX = newX - halfW;
      for (const py of testPointsY) {
        if (this.isSolidAtPixel(leftX, py)) {
          colX = true;
          const ts = this.level.tile_size;
          this.playtest.x = Math.floor(leftX / ts + 1) * ts + halfW + 0.05;
          this.playtest.vx = 0;
          break;
        }
      }
    }
    if (!colX) {
      this.playtest.x = newX;
    }

    // 2. Вертикальное перемещение
    const newY = this.playtest.y + this.playtest.vy * dt;
    const testPointsX = [this.playtest.x - halfW + 2, this.playtest.x, this.playtest.x + halfW - 2];
    let colY = false;

    if (this.playtest.vy > 0) {
      for (const px of testPointsX) {
        if (this.isSolidAtPixel(px, newY)) {
          colY = true;
          const ts = this.level.tile_size;
          this.playtest.y = Math.floor(newY / ts) * ts;
          this.playtest.vy = 0;
          this.playtest.grounded = true;
          break;
        }
      }
    } else if (this.playtest.vy < 0) {
      const topY = newY - pHeight;
      for (const px of testPointsX) {
        if (this.isSolidAtPixel(px, topY)) {
          colY = true;
          const ts = this.level.tile_size;
          this.playtest.y = Math.floor(topY / ts + 1) * ts + pHeight + 0.05;
          this.playtest.vy = 0;
          break;
        }
      }
    }

    if (!colY) {
      this.playtest.y = newY;
      this.playtest.grounded = false;
    }

    // Плавное слежение камеры за игроком
    const targetPanX = this.canvas.width / 2 - this.playtest.x * this.zoom;
    const targetPanY = this.canvas.height / 2 - (this.playtest.y - pHeight / 2) * this.zoom;
    this.panX += (targetPanX - this.panX) * 0.15;
    this.panY += (targetPanY - this.panY) * 0.15;
  }

  // --- Логика инструментов ---
  public handleDrawAction(isRightClick: boolean) {
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

  public pickTileUnderCursor() {
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

    if (this.autotileEnabled && tileId) {
      this.setTileRaw(x, y, tileId);
      this.applyAutotileAround(x, y);
    } else {
      this.setTileRaw(x, y, tileId);
      if (this.autotileEnabled) {
        this.applyAutotileAround(x, y);
      }
    }
  }

  // --- Автотайлинг (9-slice / Wang rules) ---
  private applyAutotileAround(x: number, y: number) {
    if (!this.level) return;
    const targets = [
      [x, y],
      [x, y - 1],
      [x, y + 1],
      [x - 1, y],
      [x + 1, y]
    ];
    for (const [tx, ty] of targets) {
      this.updateAutotileCell(tx, ty);
    }
  }

  private isPlatformSolid(x: number, y: number): boolean {
    if (!this.level || x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return false;
    const ch = this.level.rows[y][x];
    const tileId = this.level.legend[ch];
    if (!tileId) return false;
    const tile = this.tilesById.get(tileId);
    return !!tile?.solid;
  }

  private updateAutotileCell(x: number, y: number) {
    if (!this.level || x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;
    if (!this.isPlatformSolid(x, y)) return;

    const up = this.isPlatformSolid(x, y - 1);
    const down = this.isPlatformSolid(x, y + 1);
    const left = this.isPlatformSolid(x - 1, y);
    const right = this.isPlatformSolid(x + 1, y);

    let chosenTileId = 'platform_block';

    if (!up && down) {
      chosenTileId = this.tilesById.has('tileset1') ? 'tileset1' : 'platform_block';
    } else if (up && down && left && right) {
      chosenTileId = this.tilesById.has('tileset2') ? 'tileset2' : 'platform_block';
    } else if (up && !down) {
      chosenTileId = this.tilesById.has('tileset3') ? 'tileset3' : 'platform_block';
    } else if (!up && !down) {
      chosenTileId = this.tilesById.has('tileset4') ? 'tileset4' : 'platform_block';
    }

    this.setTileRaw(x, y, chosenTileId);
  }

  private setTileRaw(x: number, y: number, tileId: string | null) {
    if (!this.level) return;

    let targetChar = '.';
    if (tileId !== null) {
      let found = Object.entries(this.level.legend).find(([_, id]) => id === tileId);
      if (found) {
        targetChar = found[0];
      } else {
        const candidates = '#=@%*+ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
        const used = new Set(Object.keys(this.level.legend));
        let pick = candidates.split('').find(c => !used.has(c)) || '$';
        this.level.legend[pick] = tileId;
        targetChar = pick;
      }
    } else {
      let foundEmpty = Object.entries(this.level.legend).find(([_, id]) => id === null);
      if (foundEmpty) {
        targetChar = foundEmpty[0];
      } else {
        targetChar = '.';
        this.level.legend['.'] = null;
      }
    }

    const row = this.level.rows[y];
    if (row && row[x] !== targetChar) {
      this.level.rows[y] = row.substring(0, x) + targetChar + row.substring(x + 1);
      this.callbacks.onLevelChanged?.();
    }
  }

  private floodFill(startX: number, startY: number, newTileId: string) {
    if (!this.level) return;
    const originalChar = this.level.rows[startY][startX];

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

  public deleteSelected() {
    if (this.selectedEnemyIndex !== -1) {
      this.deleteSelectedEnemy();
    } else if (this.selectedTransitionIndex !== -1) {
      this.deleteSelectedTransition();
    } else if (this.selectedCableIndex !== -1) {
      this.deleteSelectedCable();
    }
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

  public deleteSelectedTransition() {
    if (!this.level || !this.level.transitions || this.selectedTransitionIndex === -1) return;
    const deleted = this.level.transitions.splice(this.selectedTransitionIndex, 1);
    this.selectedTransitionIndex = -1;
    this.callbacks.onSelectTransition?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалён переход ${deleted[0]?.id || ''}`);
    this.render();
  }

  public deleteSelectedCable() {
    if (!this.level || !this.level.cables || this.selectedCableIndex === -1) return;
    const deleted = this.level.cables.splice(this.selectedCableIndex, 1);
    this.selectedCableIndex = -1;
    this.callbacks.onSelectCable?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалён кабель ${deleted[0]?.id || ''}`);
    this.render();
  }

  // --- Главный цикл рендера ---
  public render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Фон редактора (тёмный графит)
    ctx.fillStyle = '#0f1117';
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
          const spriteDef = this.assets.getSpriteDef(layer.sprite_id);
          if (spriteDef) {
            const img = this.assets.getImage(spriteDef.image);
            if (img) {
              const bgH = spriteDef.frame_height * (bgDef.scale || 1);
              const bgW = spriteDef.frame_width * (bgDef.scale || 1);
              const bgY = levelPixelH - bgH;
              for (let bx = 0; bx < levelPixelW; bx += bgW) {
                ctx.drawImage(img, 0, 0, spriteDef.frame_width, spriteDef.frame_height, bx, bgY, bgW, bgH);
              }
            }
          }
        }
      }
    } else {
      ctx.fillStyle = '#1a1e28';
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

    // 3. Переходы и шлюзы (Transitions)
    this.renderTransitions(ctx);

    // 4. Провода и кабели (Cables)
    this.renderCables(ctx);

    // 5. Отрисовка сущностей (Игрок и Враги)
    if (this.showEntities) {
      if (!this.playtest.active) {
        // Игрок в режиме редактирования
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

    // 6. Траектория прыжка (Jump Arc Visualizer)
    if (this.showJumpArc && !this.playtest.active) {
      this.renderJumpArcs(ctx);
    }

    // 7. Игрок в режиме Playtest (физическая модель)
    if (this.playtest.active) {
      ctx.save();
      const hx = this.playtest.x;
      const hy = this.playtest.y;

      // Энергетическая аура вокруг робота
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.beginPath();
      ctx.arc(hx, hy - 14, 18, 0, Math.PI * 2);
      ctx.fill();

      // Отрисовываем героя с отражением по горизонтали (facing)
      ctx.translate(hx, hy - 32);
      if (this.playtest.facing === -1) {
        ctx.scale(-1, 1);
      }
      this.assets.drawSprite(ctx, 'player_idle', -16, 0, 0, 32, 32);
      ctx.restore();
    }

    // 8. Перетаскиваемая сущность (Drag-and-Drop)
    if (this.dragState && !this.playtest.active) {
      const gx = this.dragState.currentX;
      const gy = this.dragState.currentY;

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

    // 9. Сетка уровня
    if (this.showGrid && !this.playtest.active) {
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

      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2 / this.zoom;
      ctx.strokeRect(0, 0, levelPixelW, levelPixelH);
    }

    // 10. Превью курсора / активного инструмента
    if (!this.playtest.active && this.hoveredTileX >= 0 && this.hoveredTileX < this.level.width &&
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
      } else if (this.activeTool === 'transition') {
        ctx.fillStyle = 'rgba(14, 165, 233, 0.3)';
        ctx.fillRect(hx, hy, ts, ts * 2);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(hx, hy, ts, ts * 2);
      }

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2 / this.zoom;
      ctx.strokeRect(hx, hy, ts, ts);
    }

    ctx.restore();

    // 11. Экранные элементы управления и HUD Playtest
    if (this.playtest.active) {
      this.renderPlaytestHUD();
    } else {
      this.renderBoundaryControls(levelPixelW, levelPixelH);
    }
  }

  // --- HUD тестирования ---
  private renderPlaytestHUD() {
    const ctx = this.ctx;
    const w = this.canvas.width;

    ctx.save();
    // Верхняя панель управления
    const hudGradient = ctx.createLinearGradient(0, 0, 0, 48);
    hudGradient.addColorStop(0, 'rgba(15, 23, 42, 0.95)');
    hudGradient.addColorStop(1, 'rgba(15, 23, 42, 0.7)');
    ctx.fillStyle = hudGradient;
    ctx.fillRect(0, 0, w, 48);
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 48);
    ctx.lineTo(w, 48);
    ctx.stroke();

    // Индикатор активного теста
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(24, 24, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('РЕЖИМ ТЕСТИРОВАНИЯ (PLAYTEST)', 38, 24);

    // Подсказка управления
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('WASD / Стрелки — бег  |  ПРОБЕЛ — прыжок  |  [Esc] или [P] — выход в редактор', w / 2, 24);

    // Кинематическая телеметрия
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    const statusText = `Vx: ${this.playtest.vx.toFixed(0)} | Vy: ${this.playtest.vy.toFixed(0)} | ${this.playtest.grounded ? 'ЗЕМЛЯ' : 'ВОЗДУХ'}`;
    ctx.fillText(statusText, w - 24, 24);

    ctx.restore();
  }

  // --- Отрисовка траектории прыжка (Jump Arc Visualizer) ---
  private renderJumpArcs(ctx: CanvasRenderingContext2D) {
    if (!this.level || !this.showJumpArc || this.playtest.active) return;
    const ts = this.level.tile_size;
    const startX = (this.level.player_spawn.x + 0.5) * ts;
    const startY = (this.level.player_spawn.y + 1) * ts;

    const arcs = [
      { vx: 0, color: '#38bdf8', label: 'Вверх' },
      { vx: GAME_CONFIG.PLAYER_SPEED, color: '#00f0ff', label: 'Вправо' },
      { vx: -GAME_CONFIG.PLAYER_SPEED, color: '#f43f5e', label: 'Влево' }
    ];

    const dt = 0.016;
    const maxTime = 1.4;

    for (const arc of arcs) {
      ctx.save();
      ctx.strokeStyle = arc.color;
      ctx.fillStyle = arc.color;
      ctx.lineWidth = 2 / this.zoom;
      ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);

      ctx.beginPath();
      ctx.moveTo(startX, startY);

      let curX = startX;
      let curY = startY;
      let vy = GAME_CONFIG.JUMP_FORCE;
      let landed = false;
      let apexPoint: { x: number; y: number } | null = null;
      let minApexY = startY;

      for (let t = 0; t < maxTime; t += dt) {
        vy += GAME_CONFIG.GRAVITY * dt;
        curX += arc.vx * dt;
        curY += vy * dt;

        if (curY < minApexY) {
          minApexY = curY;
          apexPoint = { x: curX, y: curY };
        }

        ctx.lineTo(curX, curY);

        if (t > 0.05 && this.isSolidAtPixel(curX, curY)) {
          landed = true;
          break;
        }
      }

      ctx.stroke();
      ctx.setLineDash([]);

      // Точка приземления
      ctx.beginPath();
      ctx.arc(curX, curY, 3.5 / this.zoom, 0, Math.PI * 2);
      ctx.fill();

      // Отображение высоты в верхней точке
      if (apexPoint && arc.vx === 0) {
        const heightPx = Math.round(startY - apexPoint.y);
        const tilesHigh = (heightPx / ts).toFixed(1);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(9, 10 / this.zoom)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(`▲ H: ${heightPx}px (~${tilesHigh} т.)`, apexPoint.x, apexPoint.y - 6 / this.zoom);
      } else if (landed && arc.vx > 0) {
        const distPx = Math.round(curX - startX);
        const tilesDist = (distPx / ts).toFixed(1);
        ctx.fillStyle = '#00f0ff';
        ctx.font = `bold ${Math.max(8, 9 / this.zoom)}px monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(`▶ D: ${distPx}px (~${tilesDist} т.)`, curX + 6 / this.zoom, curY);
      }

      ctx.restore();
    }
  }

  // --- Отрисовка кабелей и проводов (Cable Tool) ---
  private renderCables(ctx: CanvasRenderingContext2D) {
    if (!this.level || (!this.level.cables?.length && !this.currentCableStart)) return;

    const cables = this.level.cables || [];
    cables.forEach((c, idx) => {
      const isSelected = idx === this.selectedCableIndex;
      const midX = (c.x1 + c.x2) / 2;
      const midY = (c.y1 + c.y2) / 2 + c.sag;

      // Тень
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = c.thickness + 2;
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1 + 3);
      ctx.quadraticCurveTo(midX, midY + 4, c.x2, c.y2 + 3);
      ctx.stroke();

      if (c.type === 'ide') {
        // Серый плоский ленточный шлейф IDE
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1);
        ctx.quadraticCurveTo(midX, midY, c.x2, c.y2);
        ctx.stroke();

        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1 - 3);
        ctx.quadraticCurveTo(midX, midY - 3, c.x2, c.y2 - 3);
        ctx.moveTo(c.x1, c.y1 + 3);
        ctx.quadraticCurveTo(midX, midY + 3, c.x2, c.y2 + 3);
        ctx.stroke();
      } else {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.thickness;
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1);
        ctx.quadraticCurveTo(midX, midY, c.x2, c.y2);
        ctx.stroke();
      }

      // Коннекторы на концах
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(c.x1 - 3, c.y1 - 3, 6, 6);
      ctx.fillRect(c.x2 - 3, c.y2 - 3, 6, 6);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(c.x1 - 3, c.y1 - 3, 6, 6);
      ctx.strokeRect(c.x2 - 3, c.y2 - 3, 6, 6);

      if (isSelected) {
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1);
        ctx.quadraticCurveTo(midX, midY, c.x2, c.y2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#eab308';
        ctx.beginPath();
        ctx.arc(midX, midY, 5 / this.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Превью провода при протягивании
    if (this.currentCableStart && this.hoveredTileX >= 0) {
      const ts = this.level.tile_size;
      const targetX = (this.hoveredTileX + 0.5) * ts;
      const targetY = (this.hoveredTileY + 0.5) * ts;
      const midX = (this.currentCableStart.x + targetX) / 2;
      const midY = (this.currentCableStart.y + targetY) / 2 + this.cableSag;

      ctx.save();
      ctx.strokeStyle = this.cableColor;
      ctx.lineWidth = this.cableThickness;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.currentCableStart.x, this.currentCableStart.y);
      ctx.quadraticCurveTo(midX, midY, targetX, targetY);
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- Отрисовка переходов между уровнями (Transitions) ---
  private renderTransitions(ctx: CanvasRenderingContext2D) {
    if (!this.level || !this.level.transitions?.length) return;
    const ts = this.level.tile_size;

    this.level.transitions.forEach((t, idx) => {
      const isSelected = idx === this.selectedTransitionIndex;
      const gx = t.x * ts;
      const gy = t.y * ts;
      const gw = t.width * ts;
      const gh = t.height * ts;

      // Полупрозрачный кибер-портал
      ctx.fillStyle = isSelected ? 'rgba(234, 179, 8, 0.25)' : 'rgba(14, 165, 233, 0.2)';
      ctx.fillRect(gx, gy, gw, gh);

      ctx.strokeStyle = isSelected ? '#eab308' : '#0284c7';
      ctx.lineWidth = isSelected ? 3 / this.zoom : 2 / this.zoom;
      ctx.strokeRect(gx, gy, gw, gh);

      // Предупредительные полосы
      ctx.fillStyle = isSelected ? '#eab308' : '#0284c7';
      ctx.fillRect(gx, gy, gw, 3);
      ctx.fillRect(gx, gy + gh - 3, gw, 3);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🚪', gx + gw / 2, gy + gh / 2);

      // Голографический бейдж с целевым уровнем
      const labelText = t.label || t.target_level;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(gx - 8, gy - 16, gw + 16, 14);
      ctx.strokeStyle = isSelected ? '#eab308' : '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx - 8, gy - 16, gw + 16, 14);

      ctx.fillStyle = isSelected ? '#fef08a' : '#38bdf8';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`➔ ${labelText.slice(0, 16)}`, gx + gw / 2, gy - 6);
    });
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
