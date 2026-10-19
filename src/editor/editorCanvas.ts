import { GAME_CONFIG } from '../core/Constants';
import type { AssetManager } from './assetManager';
import type { BackgroundDef, CableDef, DecorDef, EnemyDef, EnemySpawnDef, EntityDragState, LevelDef, LevelTransitionDef, MobSpawnZoneDef, PlaytestState, ResizeDirection, RoomDef, TileDef, ToolType } from './types';

export interface EditorCallbacks {
  onHoverTile?: (x: number, y: number) => void;
  onSelectEnemy?: (enemy: EnemySpawnDef | null, index: number) => void;
  onSelectTransition?: (transition: LevelTransitionDef | null, index: number) => void;
  onSelectCable?: (cable: CableDef | null, index: number) => void;
  onSelectRoom?: (room: RoomDef | null, index: number) => void;
  onSelectMobZone?: (zone: MobSpawnZoneDef | null, index: number) => void;
  onSelectDecor?: (decor: DecorDef | null, index: number) => void;
  onToolChange?: (tool: ToolType) => void;
  onPlaytestToggle?: (active: boolean) => void;
  onLevelChanged?: () => void;
  onStatusMessage?: (msg: string) => void;
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
  public showWalkability: boolean = false; // Кубики проходимости
  public walkabilityMode: 'passable' | 'solid' = 'passable';

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
  public selectedDecorSpriteId: string = 'deco_door_loc1';
  public selectedDecorLayer: 'back' | 'front' = 'front';
  public selectedDecorIndex: number = -1;

  // Комнаты (Room Tool)
  public roomStart: { x: number; y: number } | null = null;
  public roomBevelCorners: boolean = false;
  public selectedRoomIndex: number = -1;

  // Проходы (Passage Tool)
  public passageWidth: number = 3;
  public passageAutoWalls: boolean = true;
  public passageBevel: boolean = false;

  // Зоны спавна мобов (Mob Spawn Zone Tool)
  public mobZoneStart: { x: number; y: number } | null = null;
  public selectedMobZoneIndex: number = -1;
  public selectedMobZoneEnemyId: string = 'spider';
  public selectedMobZoneCount: number = 3;

  // Спавн боссов (Boss Spawn Tool)
  public selectedBossId: string | null = null;
  public selectedBossDisplayName: string = '';
  public selectedBossSpriteId: string = 'boss_textalite';

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
    if (this.level && !this.level.decor) this.level.decor = [];
    this.selectedDecorIndex = -1;
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
      rooms: this.level.rooms || [],
      spawn_zones: this.level.spawn_zones || [],
      decor: this.level.decor || [],
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
      this.level.rooms = snapshot.rooms || [];
      this.level.spawn_zones = snapshot.spawn_zones || [];
      this.level.decor = snapshot.decor || [];
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
      this.level.rooms = snapshot.rooms || [];
      this.level.spawn_zones = snapshot.spawn_zones || [];
      this.level.decor = snapshot.decor || [];
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

  // --- Автоматическое расширение границ карты под новые комнаты и коридоры ---
  public ensureBounds(minX: number, minY: number, maxX: number, maxY: number, margin = 2): { shiftX: number; shiftY: number } {
    if (!this.level) return { shiftX: 0, shiftY: 0 };
    const w = this.level.width;
    const h = this.level.height;
    const ts = this.level.tile_size;

    const padLeft = minX < 0 ? Math.abs(minX) + margin : 0;
    const padTop = minY < 0 ? Math.abs(minY) + margin : 0;
    const padRight = maxX >= w ? (maxX - w + 1) + margin : 0;
    const padBottom = maxY >= h ? (maxY - h + 1) + margin : 0;

    if (padLeft === 0 && padTop === 0 && padRight === 0 && padBottom === 0) {
      return { shiftX: 0, shiftY: 0 };
    }

    const newW = w + padLeft + padRight;
    const newH = h + padTop + padBottom;

    const newRows: string[] = [];
    const emptyRow = '.'.repeat(newW);

    for (let y = 0; y < padTop; y++) {
      newRows.push(emptyRow);
    }

    const prefix = '.'.repeat(padLeft);
    const suffix = '.'.repeat(padRight);
    for (let y = 0; y < h; y++) {
      newRows.push(prefix + this.level.rows[y] + suffix);
    }

    for (let y = 0; y < padBottom; y++) {
      newRows.push(emptyRow);
    }

    this.level.rows = newRows;
    this.level.width = newW;
    this.level.height = newH;

    const shiftX = padLeft;
    const shiftY = padTop;

    if (shiftX > 0 || shiftY > 0) {
      this.level.player_spawn.x += shiftX;
      this.level.player_spawn.y += shiftY;
      this.level.enemies.forEach(e => { e.x += shiftX; e.y += shiftY; });
      if (this.level.transitions) this.level.transitions.forEach(t => { t.x += shiftX; t.y += shiftY; });
      if (this.level.cables) this.level.cables.forEach(c => { c.x1 += shiftX * ts; c.y1 += shiftY * ts; c.x2 += shiftX * ts; c.y2 += shiftY * ts; });
      if (this.level.rooms) this.level.rooms.forEach(r => { r.x += shiftX; r.y += shiftY; });
      if (this.level.spawn_zones) this.level.spawn_zones.forEach(z => { z.x += shiftX; z.y += shiftY; });

      this.panX -= shiftX * ts * this.zoom;
      this.panY -= shiftY * ts * this.zoom;
    }

    this.callbacks.onLevelChanged?.();
    return { shiftX, shiftY };
  }

  // --- Умная авто-подгонка границ карты под все комнаты, проходы и сущности ---
  public autoFitBounds(margin = 3) {
    if (!this.level) return;
    const w = this.level.width;
    const h = this.level.height;
    const ts = this.level.tile_size;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // 1. Поиск занятых непустых тайлов
    for (let y = 0; y < h; y++) {
      const row = this.level.rows[y];
      if (!row) continue;
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        const tileId = this.level.legend[ch];
        if (tileId !== null && ch !== '.') {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // 2. Учет комнат
    if (this.level.rooms) {
      for (const r of this.level.rooms) {
        if (r.x < minX) minX = r.x;
        if (r.x + r.width - 1 > maxX) maxX = r.x + r.width - 1;
        if (r.y < minY) minY = r.y;
        if (r.y + r.height - 1 > maxY) maxY = r.y + r.height - 1;
      }
    }

    // 3. Учет зон спавна
    if (this.level.spawn_zones) {
      for (const z of this.level.spawn_zones) {
        if (z.x < minX) minX = z.x;
        if (z.x + z.width - 1 > maxX) maxX = z.x + z.width - 1;
        if (z.y < minY) minY = z.y;
        if (z.y + z.height - 1 > maxY) maxY = z.y + z.height - 1;
      }
    }

    // 4. Учет игрока и врагов
    if (this.level.player_spawn) {
      minX = Math.min(minX, this.level.player_spawn.x);
      maxX = Math.max(maxX, this.level.player_spawn.x);
      minY = Math.min(minY, this.level.player_spawn.y);
      maxY = Math.max(maxY, this.level.player_spawn.y);
    }
    if (this.level.enemies) {
      for (const e of this.level.enemies) {
        minX = Math.min(minX, e.x);
        maxX = Math.max(maxX, e.x);
        minY = Math.min(minY, e.y);
        maxY = Math.max(maxY, e.y);
      }
    }

    // 5. Учет шлюзов
    if (this.level.transitions) {
      for (const t of this.level.transitions) {
        minX = Math.min(minX, t.x);
        maxX = Math.max(maxX, t.x + t.width - 1);
        minY = Math.min(minY, t.y);
        maxY = Math.max(maxY, t.y + t.height - 1);
      }
    }

    // 6. Учет кабелей
    if (this.level.cables) {
      for (const c of this.level.cables) {
        const cx1 = Math.floor(Math.min(c.x1, c.x2) / ts);
        const cx2 = Math.ceil(Math.max(c.x1, c.x2) / ts);
        const cy1 = Math.floor(Math.min(c.y1, c.y2) / ts);
        const cy2 = Math.ceil((Math.max(c.y1, c.y2) + c.sag) / ts);
        minX = Math.min(minX, cx1);
        maxX = Math.max(maxX, cx2);
        minY = Math.min(minY, cy1);
        maxY = Math.max(maxY, cy2);
      }
    }

    if (minX === Infinity) {
      minX = 0;
      maxX = 29;
      minY = 0;
      maxY = 19;
    }

    const targetMinX = minX - margin;
    const targetMinY = minY - margin;
    const targetMaxX = maxX + margin;
    const targetMaxY = maxY + margin;

    const newW = targetMaxX - targetMinX + 1;
    const newH = targetMaxY - targetMinY + 1;

    const newRows: string[] = [];
    for (let ny = 0; ny < newH; ny++) {
      const srcY = targetMinY + ny;
      let rowStr = '';
      if (srcY >= 0 && srcY < h) {
        const oldRow = this.level.rows[srcY];
        for (let nx = 0; nx < newW; nx++) {
          const srcX = targetMinX + nx;
          if (srcX >= 0 && srcX < w) {
            rowStr += oldRow[srcX];
          } else {
            rowStr += '.';
          }
        }
      } else {
        rowStr = '.'.repeat(newW);
      }
      newRows.push(rowStr);
    }

    const dx = -targetMinX;
    const dy = -targetMinY;

    this.level.rows = newRows;
    this.level.width = newW;
    this.level.height = newH;

    this.level.player_spawn.x += dx;
    this.level.player_spawn.y += dy;
    this.level.enemies.forEach(e => { e.x += dx; e.y += dy; });
    if (this.level.transitions) this.level.transitions.forEach(t => { t.x += dx; t.y += dy; });
    if (this.level.cables) this.level.cables.forEach(c => { c.x1 += dx * ts; c.y1 += dy * ts; c.x2 += dx * ts; c.y2 += dy * ts; });
    if (this.level.rooms) this.level.rooms.forEach(r => { r.x += dx; r.y += dy; });
    if (this.level.spawn_zones) this.level.spawn_zones.forEach(z => { z.x += dx; z.y += dy; });

    this.panX -= dx * ts * this.zoom;
    this.panY -= dy * ts * this.zoom;

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`📐 Границы подогнаны под комнаты: ${newW}×${newH}`);
    this.render();
  }

  // --- Быстрое соединение комнат проходом (Corridor tool) ---
  public connectRooms(roomA: RoomDef, roomB: RoomDef, width = 3) {
    if (!this.level) return;
    const cx1 = Math.floor(roomA.x + roomA.width / 2);
    const cy1 = Math.floor(roomA.y + roomA.height / 2);
    const cx2 = Math.floor(roomB.x + roomB.width / 2);
    const cy2 = Math.floor(roomB.y + roomB.height / 2);

    const minX = Math.min(cx1, cx2) - Math.floor(width / 2) - 1;
    const maxX = Math.max(cx1, cx2) + Math.floor(width / 2) + 1;
    const minY = Math.min(cy1, cy2) - Math.floor(width / 2) - 1;
    const maxY = Math.max(cy1, cy2) + Math.floor(width / 2) + 1;

    const { shiftX, shiftY } = this.ensureBounds(minX, minY, maxX, maxY, 3);
    const acx1 = cx1 + shiftX;
    const acy1 = cy1 + shiftY;
    const acx2 = cx2 + shiftX;
    const acy2 = cy2 + shiftY;

    const startX = Math.min(acx1, acx2);
    const endX = Math.max(acx1, acx2);
    for (let x = startX; x <= endX; x++) {
      this.applyPassage(x, acy1);
    }

    const startY = Math.min(acy1, acy2);
    const endY = Math.max(acy1, acy2);
    const half = Math.floor(width / 2);
    const wallTile = this.selectedTileId || 'platform_block';

    for (let y = startY; y <= endY; y++) {
      for (let w = -half; w <= half; w++) {
        this.setTile(acx2 + w, y, null);
      }
      if (this.passageAutoWalls) {
        this.setTile(acx2 - half - 1, y, wallTile);
        this.setTile(acx2 + half + 1, y, wallTile);
      }
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Комнаты "${roomA.name}" и "${roomB.name}" соединены проходом`);
    this.render();
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
      if (this.level.rooms) this.level.rooms.forEach(r => (r.y += count));
      if (this.level.spawn_zones) this.level.spawn_zones.forEach(z => (z.y += count));
      if (this.level.decor) this.level.decor.forEach(d => (d.y += count));
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
      if (this.level.rooms) this.level.rooms.forEach(r => (r.x += count));
      if (this.level.spawn_zones) this.level.spawn_zones.forEach(z => (z.x += count));
      if (this.level.decor) this.level.decor.forEach(d => (d.x += count));
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
      if (this.level.rooms) {
        this.level.rooms.forEach(r => (r.y -= count));
      }
      if (this.level.spawn_zones) {
        this.level.spawn_zones.forEach(z => (z.y -= count));
      }
      if (this.level.decor) {
        this.level.decor.forEach(d => (d.y -= count));
        this.level.decor = this.level.decor.filter(d => d.y >= 0);
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
      if (this.level.decor) {
        this.level.decor = this.level.decor.filter(d => d.y < this.level!.height);
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
      if (this.level.rooms) {
        this.level.rooms.forEach(r => (r.x -= count));
      }
      if (this.level.spawn_zones) {
        this.level.spawn_zones.forEach(z => (z.x -= count));
      }
      if (this.level.decor) {
        this.level.decor.forEach(d => (d.x -= count));
        this.level.decor = this.level.decor.filter(d => d.x >= 0);
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
      if (this.level.decor) {
        this.level.decor = this.level.decor.filter(d => d.x < this.level!.width);
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

    if (this.level.rooms) {
      this.level.rooms.forEach(r => {
        r.x += dx;
        r.y += dy;
      });
    }

    if (this.level.spawn_zones) {
      this.level.spawn_zones.forEach(z => {
        z.x += dx;
        z.y += dy;
      });
    }

    if (this.level.decor) {
      this.level.decor.forEach(d => {
        d.x += dx;
        d.y += dy;
      });
      this.level.decor = this.level.decor.filter(d => d.x >= 0 && d.x < w && d.y >= 0 && d.y < h);
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Сдвиг карты на dx=${dx}, dy=${dy}`);
    this.render();
  }
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

      // Панорамирование: ПКМ (e.button === 2), средняя кнопка (e.button === 1), зажатый Space или Alt+ЛКМ
      if (e.button === 2 || e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
        if (this.activeTool === 'cable' && this.currentCableStart && e.button === 2) {
          this.currentCableStart = null;
          this.callbacks.onStatusMessage?.('Протягивание кабеля отменено');
          this.render();
        }
        this.isPanning = true;
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      if (e.altKey && e.button === 0) {
        this.pickTileUnderCursor();
        return;
      }

      // Все остальные действия (выделение, рисование, перемещение) — строго по левой кнопке мыши (ЛКМ)
      if (e.button !== 0) {
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

      // 4. Инструмент комнат (Room Tool)
      if (this.activeTool === 'room') {
        if (e.button === 0 && this.level) {
          this.roomStart = { x: tileX, y: tileY };
          this.callbacks.onStatusMessage?.(`Создание комнаты от [${tileX}, ${tileY}]... Тяните мышь.`);
          this.render();
          return;
        }
      }

      // 5. Инструмент зон спавна мобов (Mob Spawn Zone Tool)
      if (this.activeTool === 'mob_zone') {
        if (e.button === 0 && this.level) {
          this.mobZoneStart = { x: tileX, y: tileY };
          this.callbacks.onStatusMessage?.(`Задание области спавна от [${tileX}, ${tileY}]... Тяните мышь.`);
          this.render();
          return;
        }
      }

      // 6. Инструмент спавна боссов (Boss Spawn Tool)
      if (this.activeTool === 'boss_spawn') {
        if (e.button === 0 && this.level && tileX >= 0 && tileX < this.level.width && tileY >= 0 && tileY < this.level.height) {
          this.placeBossAt(tileX, tileY);
          return;
        }
      }

      // 7. Инструмент среза углов (Bevel Tool)
      if (this.activeTool === 'bevel') {
        if (e.button === 0 && this.level && tileX >= 0 && tileX < this.level.width && tileY >= 0 && tileY < this.level.height) {
          this.applyBevelAt(tileX, tileY);
          return;
        }
      }

      // 7.5. Инструмент декора и объектов (Decor Tool)
      if (this.activeTool === 'decor') {
        if (e.button === 0 && this.level) {
          this.level.decor = this.level.decor || [];
          const ts = this.level.tile_size;

          const hitIdx = this.level.decor.findIndex(d => {
            const def = this.assets.getSpriteDef(d.sprite_id);
            const fw = def?.frame_width ?? ts;
            const fh = def?.frame_height ?? ts;
            const ox = def?.origin?.x ?? 0.5;
            const oy = def?.origin?.y ?? 1.0;
            const left = d.x * ts - ox * fw;
            const top = d.y * ts - oy * fh;
            return world.x >= left && world.x <= left + fw && world.y >= top && world.y <= top + fh;
          });

          if (hitIdx !== -1) {
            this.selectedDecorIndex = hitIdx;
            this.callbacks.onSelectDecor?.(this.level.decor[hitIdx], hitIdx);
            this.callbacks.onStatusMessage?.(`Выбран декор: ${this.level.decor[hitIdx].sprite_id}`);
            this.render();
            return;
          }

          const def = this.assets.getSpriteDef(this.selectedDecorSpriteId);
          const ox = def?.origin?.x ?? 0.5;
          const oy = def?.origin?.y ?? 1.0;
          const posX = e.shiftKey ? Math.round((world.x / ts) * 10) / 10 : (tileX + (ox === 0.5 ? 0.5 : 0));
          const posY = e.shiftKey ? Math.round((world.y / ts) * 10) / 10 : (tileY + (oy === 1.0 ? 1.0 : (oy === 0.5 ? 0.5 : 0)));

          const newDecor: DecorDef = {
            sprite_id: this.selectedDecorSpriteId,
            x: posX,
            y: posY,
            layer: this.selectedDecorLayer
          };
          this.level.decor.push(newDecor);
          this.selectedDecorIndex = this.level.decor.length - 1;
          this.callbacks.onSelectDecor?.(newDecor, this.selectedDecorIndex);
          this.saveStateToHistory();
          this.callbacks.onLevelChanged?.();
          this.callbacks.onStatusMessage?.(`Размещён декор: ${newDecor.sprite_id} (${posX}, ${posY})`);
          this.render();
          return;
        }
      }

      // 8. Инструмент проходов (Passage Tool)
      if (this.activeTool === 'passage') {
        if (e.button === 0 && this.level) {
          this.isMouseDown = true;
          this.applyPassage(tileX, tileY);
          return;
        }
      }

      // 9. Инструмент кубиков проходимости (Walkability Brush)
      if (this.activeTool === 'walkability') {
        if (e.button === 0 && this.level && tileX >= 0 && tileX < this.level.width && tileY >= 0 && tileY < this.level.height) {
          this.isMouseDown = true;
          this.applyWalkability(tileX, tileY);
          return;
        }
      }

      // 10. Drag-and-Drop и Выбор (Move / Select)
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

        // Проверяем комнату
        if (this.level.rooms && this.activeTool === 'select') {
          const roomIdx = this.level.rooms.findIndex(r =>
            tileX >= r.x && tileX < r.x + r.width && tileY >= r.y && tileY < r.y + r.height
          );
          if (roomIdx !== -1) {
            this.selectedRoomIndex = roomIdx;
            this.callbacks.onSelectRoom?.(this.level.rooms[roomIdx], roomIdx);
            this.callbacks.onStatusMessage?.(`Выбрана комната: ${this.level.rooms[roomIdx].name}`);
            this.render();
            return;
          }
        }

        // Проверяем зону спавна
        if (this.level.spawn_zones && this.activeTool === 'select') {
          const zoneIdx = this.level.spawn_zones.findIndex(z =>
            tileX >= z.x && tileX < z.x + z.width && tileY >= z.y && tileY < z.y + z.height
          );
          if (zoneIdx !== -1) {
            this.selectedMobZoneIndex = zoneIdx;
            this.callbacks.onSelectMobZone?.(this.level.spawn_zones[zoneIdx], zoneIdx);
            this.callbacks.onStatusMessage?.(`Выбрана зона спавна: ${this.level.spawn_zones[zoneIdx].name || this.level.spawn_zones[zoneIdx].enemy_id}`);
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

        // Проверяем декор
        if (this.level.decor) {
          const ts = this.level.tile_size;
          const decorIdx = this.level.decor.findIndex(d => {
            const def = this.assets.getSpriteDef(d.sprite_id);
            const fw = def?.frame_width ?? ts;
            const fh = def?.frame_height ?? ts;
            const ox = def?.origin?.x ?? 0.5;
            const oy = def?.origin?.y ?? 1.0;
            const left = d.x * ts - ox * fw;
            const top = d.y * ts - oy * fh;
            return world.x >= left && world.x <= left + fw && world.y >= top && world.y <= top + fh;
          });
          if (decorIdx !== -1) {
            this.selectedDecorIndex = decorIdx;
            this.callbacks.onSelectDecor?.(this.level.decor[decorIdx], decorIdx);
            this.dragState = {
              type: 'decor',
              index: decorIdx,
              startX: this.level.decor[decorIdx].x,
              startY: this.level.decor[decorIdx].y,
              currentX: this.level.decor[decorIdx].x,
              currentY: this.level.decor[decorIdx].y
            };
            this.canvas.style.cursor = 'grabbing';
            this.callbacks.onStatusMessage?.(`Выбран декор: ${this.level.decor[decorIdx].sprite_id}`);
            this.render();
            return;
          }
        }
      }

      this.isMouseDown = true;
      this.handleDrawAction();
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

      // Превью создания комнаты
      if (this.activeTool === 'room' && this.roomStart) {
        this.hoveredTileX = tileX;
        this.hoveredTileY = tileY;
        this.render();
        return;
      }

      // Превью зоны спавна мобов
      if (this.activeTool === 'mob_zone' && this.mobZoneStart) {
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
          if (this.activeTool === 'passage') {
            this.applyPassage(tileX, tileY);
          } else if (this.activeTool === 'walkability') {
            this.applyWalkability(tileX, tileY);
          } else {
            this.handleDrawAction();
          }
        }
        this.render();
      }
    });

    window.addEventListener('mouseup', () => {
      // Завершение создания комнаты
      if (this.roomStart && this.level) {
        this.applyRoom(this.roomStart.x, this.roomStart.y, this.hoveredTileX, this.hoveredTileY);
        this.roomStart = null;
        this.render();
      }

      // Завершение создания зоны спавна мобов
      if (this.mobZoneStart && this.level) {
        this.applyMobZone(this.mobZoneStart.x, this.mobZoneStart.y, this.hoveredTileX, this.hoveredTileY);
        this.mobZoneStart = null;
        this.render();
      }

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
          } else if (this.dragState.type === 'decor' && this.dragState.index >= 0 && this.level.decor) {
            const dec = this.level.decor[this.dragState.index];
            const def = this.assets.getSpriteDef(dec.sprite_id);
            const ox = def?.origin?.x ?? 0.5;
            const oy = def?.origin?.y ?? 1.0;
            dec.x = cx + (ox === 0.5 ? 0.5 : 0);
            dec.y = cy + (oy === 1.0 ? 1.0 : (oy === 0.5 ? 0.5 : 0));
            this.callbacks.onSelectDecor?.(dec, this.dragState.index);
            this.callbacks.onStatusMessage?.(`Декор перемещён в (${dec.x}, ${dec.y})`);
          }
          this.saveStateToHistory();
          this.callbacks.onLevelChanged?.();
        }

        this.dragState = null;
        this.canvas.style.cursor = 'default';
        this.render();
        return;
      }

      if (this.isPanning) {
        this.isPanning = false;
        this.canvas.style.cursor = 'default';
        this.render();
      }

      if (this.isMouseDown) {
        this.saveStateToHistory();
      }
      this.isMouseDown = false;
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
      if (e.key === 'y' || e.key === 'Y') this.setTool('decor');
      if (e.key === 'r' || e.key === 'R') this.setTool('room');
      if (e.key === 'w' || e.key === 'W') this.setTool('passage');
      if (e.key === 'q' || e.key === 'Q') this.setTool('walkability');
      if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey) this.setTool('mob_zone');
      if (e.key === 'f' || e.key === 'F') this.setTool('boss_spawn');
      if (e.key === 'x' || e.key === 'X') this.setTool('bevel');
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
    this.callbacks.onToolChange?.(tool);
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
    const tile = this.tilesById.get(tileId);
    if (!tile?.solid) return false;

    if (tile.slope) {
      const lx = (px - tx * ts) / ts;
      const ly = (py - ty * ts) / ts;
      if (tile.slope === 'up_right') return ly >= 1 - lx;
      if (tile.slope === 'up_left') return ly >= lx;
      if (tile.slope === 'ceil_right') return ly <= lx;
      if (tile.slope === 'ceil_left') return ly <= 1 - lx;
    }
    return true;
  }

  public getSlope(cx: number, cy: number): 'up_right' | 'up_left' | 'ceil_right' | 'ceil_left' | null {
    if (!this.level || cx < 0 || cx >= this.level.width || cy < 0 || cy >= this.level.height) return null;
    const row = this.level.rows[cy];
    if (!row) return null;
    const ch = row[cx];
    const tileId = this.level.legend[ch];
    if (!tileId) return null;
    const tile = this.tilesById.get(tileId);
    return tile?.slope || null;
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
  public handleDrawAction() {
    if (!this.level) return;
    const x = this.hoveredTileX;
    const y = this.hoveredTileY;

    if (x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;

    if (this.activeTool === 'eraser') {
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

    if (x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) {
      const { shiftX, shiftY } = this.ensureBounds(x, y, x, y, 2);
      x += shiftX;
      y += shiftY;
    }

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
    } else if (this.selectedRoomIndex !== -1) {
      this.deleteSelectedRoom();
    } else if (this.selectedMobZoneIndex !== -1) {
      this.deleteSelectedMobZone();
    } else if (this.selectedDecorIndex !== -1) {
      this.deleteSelectedDecor();
    }
  }

  public deleteSelectedDecor() {
    if (!this.level?.decor || this.selectedDecorIndex === -1) return;
    const deleted = this.level.decor.splice(this.selectedDecorIndex, 1);
    this.selectedDecorIndex = -1;
    this.callbacks.onSelectDecor?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалён декор ${deleted[0]?.sprite_id || ''}`);
    this.render();
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

  public deleteSelectedRoom() {
    if (!this.level || !this.level.rooms || this.selectedRoomIndex === -1) return;
    const deleted = this.level.rooms.splice(this.selectedRoomIndex, 1);
    this.selectedRoomIndex = -1;
    this.callbacks.onSelectRoom?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалена комната "${deleted[0]?.name || ''}"`);
    this.render();
  }

  public deleteSelectedMobZone() {
    if (!this.level || !this.level.spawn_zones || this.selectedMobZoneIndex === -1) return;
    const deleted = this.level.spawn_zones.splice(this.selectedMobZoneIndex, 1);
    this.selectedMobZoneIndex = -1;
    this.callbacks.onSelectMobZone?.(null, -1);
    this.callbacks.onLevelChanged?.();
    this.saveStateToHistory();
    this.callbacks.onStatusMessage?.(`Удалена зона спавна "${deleted[0]?.name || ''}"`);
    this.render();
  }

  // --- Создание комнат (Room Tool) ---
  public applyRoom(x0: number, y0: number, x1: number, y1: number) {
    if (!this.level) return;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);

    if (maxX - minX < 2 || maxY - minY < 2) {
      this.callbacks.onStatusMessage?.('Комната слишком мала (минимум 3x3 тайла)');
      return;
    }

    // Автоматическое расширение мира, если комната выходит за текущие границы
    const { shiftX, shiftY } = this.ensureBounds(minX, minY, maxX, maxY, 3);
    const adjMinX = minX + shiftX;
    const adjMaxX = maxX + shiftX;
    const adjMinY = minY + shiftY;
    const adjMaxY = maxY + shiftY;

    const wallTile = this.selectedTileId || 'platform_block';

    for (let y = adjMinY; y <= adjMaxY; y++) {
      for (let x = adjMinX; x <= adjMaxX; x++) {
        const isBorder = (x === adjMinX || x === adjMaxX || y === adjMinY || y === adjMaxY);
        if (isBorder) {
          // Углы со срезом, если включена опция
          if (this.roomBevelCorners) {
            if (x === adjMinX && y === adjMinY) {
              this.setTile(x, y, 'platform_slope_ur');
              continue;
            } else if (x === adjMaxX && y === adjMinY) {
              this.setTile(x, y, 'platform_slope_ul');
              continue;
            } else if (x === adjMinX && y === adjMaxY) {
              this.setTile(x, y, 'platform_slope_cr');
              continue;
            } else if (x === adjMaxX && y === adjMaxY) {
              this.setTile(x, y, 'platform_slope_cl');
              continue;
            }
          }
          this.setTile(x, y, wallTile);
        } else {
          // Внутреннее пространство комнаты — пустое (проходимое)
          this.setTile(x, y, null);
        }
      }
    }

    this.level.rooms = this.level.rooms || [];
    const newRoom: RoomDef = {
      id: `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: `Комната ${this.level.rooms.length + 1}`,
      x: adjMinX,
      y: adjMinY,
      width: adjMaxX - adjMinX + 1,
      height: adjMaxY - adjMinY + 1,
      beveled: this.roomBevelCorners
    };

    this.level.rooms.push(newRoom);
    this.selectedRoomIndex = this.level.rooms.length - 1;
    this.callbacks.onSelectRoom?.(newRoom, this.selectedRoomIndex);
    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Создана комната "${newRoom.name}" [${newRoom.width}×${newRoom.height}]${this.roomBevelCorners ? ' (со скосами)' : ''}`);
    this.render();
  }

  // --- Рисование проходов (Passage Tool) ---
  public applyPassage(centerX: number, centerY: number) {
    if (!this.level) return;
    const half = Math.floor(this.passageWidth / 2);

    // Авто-расширение границ мира, если рисуем проход за пределами
    const { shiftX, shiftY } = this.ensureBounds(
      centerX - 1,
      centerY - half - 1,
      centerX + 1,
      centerY + half + 1,
      2
    );
    const cx = centerX + shiftX;
    const cy = centerY + shiftY;

    const startY = Math.max(0, cy - half);
    const endY = Math.min(this.level.height - 1, startY + this.passageWidth - 1);

    // Очищаем проход
    for (let y = startY; y <= endY; y++) {
      this.setTile(cx, y, null);
    }

    // Авто-стены снизу и сверху
    if (this.passageAutoWalls) {
      const wallTile = this.selectedTileId || 'platform_block';
      if (startY > 0) {
        this.setTile(cx, startY - 1, wallTile);
      }
      if (endY < this.level.height - 1) {
        this.setTile(cx, endY + 1, wallTile);
      }
    }

    this.callbacks.onLevelChanged?.();
    this.render();
  }

  // --- Кисть проходимости (Walkability Brush) ---
  public applyWalkability(x: number, y: number) {
    if (!this.level || x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;
    if (this.walkabilityMode === 'passable') {
      this.setTile(x, y, null);
    } else {
      const wallTile = this.selectedTileId || 'platform_block';
      this.setTile(x, y, wallTile);
    }
    this.callbacks.onLevelChanged?.();
    this.render();
  }

  // --- Зоны спавна мобов на полу (Mob Spawn Zone Tool) ---
  public getValidFloorTilesInZone(zone: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> {
    if (!this.level) return [];
    const floors: Array<{ x: number; y: number }> = [];
    const minX = Math.max(0, zone.x);
    const maxX = Math.min(this.level.width - 1, zone.x + zone.width - 1);
    const minY = Math.max(0, zone.y);
    const maxY = Math.min(this.level.height - 1, zone.y + zone.height - 1);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        // Твёрдый блок пола, над которым воздух
        const isCurrentSolid = this.isSolidAtPixel((cx + 0.5) * this.level.tile_size, (cy + 0.5) * this.level.tile_size);
        if (isCurrentSolid) {
          const aboveSolid = cy > 0 && this.isSolidAtPixel((cx + 0.5) * this.level.tile_size, (cy - 0.5) * this.level.tile_size);
          if (!aboveSolid) {
            floors.push({ x: cx, y: cy - 1 });
          }
        }
      }
    }
    return floors;
  }

  public applyMobZone(x0: number, y0: number, x1: number, y1: number) {
    if (!this.level) return;
    const minX = Math.max(0, Math.min(x0, x1));
    const maxX = Math.min(this.level.width - 1, Math.max(x0, x1));
    const minY = Math.max(0, Math.min(y0, y1));
    const maxY = Math.min(this.level.height - 1, Math.max(y0, y1));

    if (maxX - minX < 1 || maxY - minY < 1) {
      this.callbacks.onStatusMessage?.('Область спавна слишком мала');
      return;
    }

    this.level.spawn_zones = this.level.spawn_zones || [];
    const newZone: MobSpawnZoneDef = {
      id: `zone_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: `Зона ${this.level.spawn_zones.length + 1}`,
      enemy_id: this.selectedMobZoneEnemyId || 'spider',
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      count: this.selectedMobZoneCount || 3,
      surface: 'floor'
    };

    this.level.spawn_zones.push(newZone);
    this.selectedMobZoneIndex = this.level.spawn_zones.length - 1;
    this.callbacks.onSelectMobZone?.(newZone, this.selectedMobZoneIndex);
    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();

    const validFloors = this.getValidFloorTilesInZone(newZone);
    this.callbacks.onStatusMessage?.(`Создана зона спавна "${newZone.name}" (${newZone.enemy_id} x${newZone.count}). Найдено мест на полу: ${validFloors.length}`);
    this.render();
  }

  public generateZoneMobs(zoneIdx: number) {
    if (!this.level || !this.level.spawn_zones || !this.level.spawn_zones[zoneIdx]) return;
    const zone = this.level.spawn_zones[zoneIdx];
    const floors = this.getValidFloorTilesInZone(zone);
    if (floors.length === 0) {
      this.callbacks.onStatusMessage?.('В этой зоне нет твердого пола для спавна мобов!');
      return;
    }

    // Удаляем предыдущих мобов из этой зоны
    this.level.enemies = this.level.enemies.filter(e =>
      !(e.x >= zone.x && e.x < zone.x + zone.width && e.y >= zone.y && e.y < zone.y + zone.height)
    );

    const enemyDef = this.enemiesById.get(zone.enemy_id);
    const spriteId = zone.sprite_id || enemyDef?.sprite_variants[0] || 'enemy_spider';
    const count = Math.min(zone.count, floors.length);

    for (let i = 0; i < count; i++) {
      const pickIdx = Math.floor(Math.random() * floors.length);
      const pt = floors.splice(pickIdx, 1)[0];
      this.level.enemies.push({
        enemy_id: zone.enemy_id,
        sprite_id: spriteId,
        x: pt.x,
        y: pt.y,
        surface: 'floor'
      });
    }

    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Сгенерировано ${count} мобов [${zone.enemy_id}] строго на полу!`);
    this.render();
  }

  // --- Срез углов и диагональные границы (Bevel Tool) ---
  public applyBevelAt(x: number, y: number) {
    if (!this.level || x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;
    const ch = this.level.rows[y][x];
    const tileId = this.level.legend[ch];
    const tile = tileId ? this.tilesById.get(tileId) : null;

    if (tileId === 'platform_slope_ur') {
      this.setTile(x, y, 'platform_slope_ul');
    } else if (tileId === 'platform_slope_ul') {
      this.setTile(x, y, 'platform_slope_cr');
    } else if (tileId === 'platform_slope_cr') {
      this.setTile(x, y, 'platform_slope_cl');
    } else if (tileId === 'platform_slope_cl') {
      this.setTile(x, y, this.selectedTileId || 'platform_block');
    } else if (tile?.solid) {
      const up = y > 0 ? this.isSolidAtPixel((x + 0.5) * this.level.tile_size, (y - 0.5) * this.level.tile_size) : false;
      const down = y < this.level.height - 1 ? this.isSolidAtPixel((x + 0.5) * this.level.tile_size, (y + 1.5) * this.level.tile_size) : true;
      const left = x > 0 ? this.isSolidAtPixel((x - 0.5) * this.level.tile_size, (y + 0.5) * this.level.tile_size) : false;
      const right = x < this.level.width - 1 ? this.isSolidAtPixel((x + 1.5) * this.level.tile_size, (y + 0.5) * this.level.tile_size) : false;

      if (!up && !left) {
        this.setTile(x, y, 'platform_slope_ur');
      } else if (!up && !right) {
        this.setTile(x, y, 'platform_slope_ul');
      } else if (!down && !left) {
        this.setTile(x, y, 'platform_slope_cr');
      } else if (!down && !right) {
        this.setTile(x, y, 'platform_slope_cl');
      } else {
        this.setTile(x, y, 'platform_slope_ur');
      }
    } else {
      this.setTile(x, y, 'platform_slope_ur');
    }
    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`Диагональный скос на клетке [${x}, ${y}]`);
    this.render();
  }

  // --- Фиксированный спавн боссов (Boss Spawn Tool) ---
  public placeBossAt(x: number, y: number) {
    if (!this.level || x < 0 || x >= this.level.width || y < 0 || y >= this.level.height) return;
    const bossId = this.selectedBossId || 'worm_boss';
    const bossName = this.selectedBossDisplayName || bossId;

    const bossDef = this.enemiesById.get(bossId);
    const spriteId = this.selectedBossSpriteId || bossDef?.sprite_variants[0] || 'boss_textalite';

    this.level.enemies = this.level.enemies.filter(e => !(e.x === x && e.y === y));

    const newBoss: EnemySpawnDef = {
      enemy_id: bossId,
      sprite_id: spriteId,
      x,
      y,
      surface: 'floor',
      is_boss: true,
      boss_id: bossId
    };

    this.level.enemies.push(newBoss);
    this.selectedEnemyIndex = this.level.enemies.length - 1;
    this.callbacks.onSelectEnemy?.(newBoss, this.selectedEnemyIndex);
    this.saveStateToHistory();
    this.callbacks.onLevelChanged?.();
    this.callbacks.onStatusMessage?.(`👑 Фиксированный спавн босса: ${bossName} на [${x}, ${y}]`);
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
        const groundOffset = bgDef.ground_offset ?? 0;
        const scale = bgDef.scale || 1;

        // Слои параллакса (от дальнего к ближнему)
        for (const layer of bgDef.layers) {
          if (layer.visible === false) continue;
          const spriteDef = this.assets.getSpriteDef(layer.sprite_id);
          if (spriteDef) {
            const img = this.assets.getImage(spriteDef.image);
            if (img) {
              const cropLeft = layer.crop_left ?? 0;
              const srcW = Math.max(1, spriteDef.frame_width - cropLeft);
              const srcH = spriteDef.frame_height;
              const bgW = srcW * scale;
              const bgH = srcH * scale;
              const bgY = levelPixelH - groundOffset - bgH;

              let step = 0;
              for (let bx = 0; bx < levelPixelW; bx += bgW, step++) {
                const isFlipped = Boolean(layer.mirror && (step % 2 === 1));
                if (isFlipped) {
                  ctx.save();
                  ctx.translate(bx + bgW, 0);
                  ctx.scale(-1, 1);
                  ctx.drawImage(img, cropLeft, 0, srcW, srcH, 0, bgY, bgW, bgH);
                  ctx.restore();
                } else {
                  ctx.drawImage(img, cropLeft, 0, srcW, srcH, bx, bgY, bgW, bgH);
                }
              }
            }
          }
        }

        // Заливка под нижним краем слоев фона до самого низа уровня
        if (groundOffset > 0 && bgDef.ground_color) {
          ctx.fillStyle = bgDef.ground_color;
          ctx.fillRect(0, levelPixelH - groundOffset, levelPixelW, groundOffset);
        }
      }
    } else {
      ctx.fillStyle = '#1a1e28';
      ctx.fillRect(0, 0, levelPixelW, levelPixelH);
    }

    // 1.5. Декор заднего плана (layer: 'back')
    this.renderDecor(ctx, 'back');

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
            if (tile.slope) {
              const ox = cx * ts;
              const oy = cy * ts;
              ctx.save();
              ctx.beginPath();
              if (tile.slope === 'up_right') {
                ctx.moveTo(ox, oy + ts);
                ctx.lineTo(ox + ts, oy + ts);
                ctx.lineTo(ox + ts, oy);
              } else if (tile.slope === 'up_left') {
                ctx.moveTo(ox, oy);
                ctx.lineTo(ox, oy + ts);
                ctx.lineTo(ox + ts, oy + ts);
              } else if (tile.slope === 'ceil_right') {
                ctx.moveTo(ox, oy);
                ctx.lineTo(ox + ts, oy);
                ctx.lineTo(ox + ts, oy + ts);
              } else if (tile.slope === 'ceil_left') {
                ctx.moveTo(ox, oy);
                ctx.lineTo(ox + ts, oy);
                ctx.lineTo(ox, oy + ts);
              }
              ctx.closePath();
              ctx.clip();
              this.assets.drawSprite(ctx, tile.sprite_id, ox, oy, 0, ts, ts);
              ctx.restore();

              // Зеленая дорожка на скосе
              if (!tile.id.includes('step')) {
                ctx.strokeStyle = '#4ade80';
                ctx.lineWidth = 2 / this.zoom;
                ctx.beginPath();
                if (tile.slope === 'up_right') {
                  ctx.moveTo(ox, oy + ts); ctx.lineTo(ox + ts, oy);
                } else if (tile.slope === 'up_left') {
                  ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy + ts);
                } else if (tile.slope === 'ceil_right') {
                  ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy + ts);
                } else if (tile.slope === 'ceil_left') {
                  ctx.moveTo(ox + ts, oy); ctx.lineTo(ox, oy + ts);
                }
                ctx.stroke();
              }
            } else {
              this.assets.drawSprite(ctx, tile.sprite_id, cx * ts, cy * ts, 0, ts, ts);
            }
          } else {
            ctx.fillStyle = '#4ade80';
            ctx.fillRect(cx * ts, cy * ts, ts, ts);
          }

          // Оверлей твердости/коллизии
          if (this.showCollisions && tile?.solid) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
            if (tile.slope) {
              const ox = cx * ts;
              const oy = cy * ts;
              ctx.beginPath();
              if (tile.slope === 'up_right') {
                ctx.moveTo(ox, oy + ts); ctx.lineTo(ox + ts, oy + ts); ctx.lineTo(ox + ts, oy);
              } else if (tile.slope === 'up_left') {
                ctx.moveTo(ox, oy); ctx.lineTo(ox, oy + ts); ctx.lineTo(ox + ts, oy + ts);
              } else if (tile.slope === 'ceil_right') {
                ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy); ctx.lineTo(ox + ts, oy + ts);
              } else if (tile.slope === 'ceil_left') {
                ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy); ctx.lineTo(ox, oy + ts);
              }
              ctx.closePath();
              ctx.fill();
            } else {
              ctx.fillRect(cx * ts, cy * ts, ts, ts);
              ctx.strokeStyle = '#ef4444';
              ctx.lineWidth = 1;
              ctx.strokeRect(cx * ts + 0.5, cy * ts + 0.5, ts - 1, ts - 1);
            }
          }
        }
      }
    }

    // 2.5. Декор переднего плана (layer: 'front')
    this.renderDecor(ctx, 'front');

    // 3. Переходы и шлюзы (Transitions)
    this.renderTransitions(ctx);

    // 4. Провода и кабели (Cables)
    this.renderCables(ctx);

    // 4.5. Комнаты (Rooms)
    this.renderRooms(ctx);

    // 4.6. Зоны спавна мобов на полу (Mob Spawn Zones)
    this.renderMobZones(ctx);

    // 4.7. Оверлей кубиков проходимости (Walkability Grid)
    if (this.showWalkability) {
      this.renderWalkabilityGrid(ctx);
    }

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
        const isBoss = enemy.is_boss || enemy.enemy_id.startsWith('boss_') || enemy.enemy_id === 'worm_boss';

        if (isBoss) {
          // Корона и статус босса
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(ex, ey - 10, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('👑', ex, ey - 6);

          ctx.fillStyle = isSelected ? '#f59e0b' : '#d97706';
          ctx.fillRect(enemy.x * ts - 4, ey - 22, ts + 8, 11);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'center';
          const bossLabel = enemy.boss_id || enemy.enemy_id;
          ctx.fillText(`👑 ${bossLabel.slice(0, 12)}`, ex, ey - 14);
        } else {
          ctx.fillStyle = isSelected ? '#eab308' : '#ef4444';
          ctx.fillRect(enemy.x * ts + 2, ey - 7, ts - 4, 9);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(enemy.enemy_id.slice(0, 5).toUpperCase(), ex, ey);
        }

        if (isSelected) {
          ctx.strokeStyle = isBoss ? '#f59e0b' : '#eab308';
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
      } else if (this.dragState.type === 'decor' && this.dragState.index >= 0 && this.level.decor) {
        const dec = this.level.decor[this.dragState.index];
        const def = this.assets.getSpriteDef(dec.sprite_id);
        const fw = def?.frame_width ?? ts;
        const fh = def?.frame_height ?? ts;
        const ox = def?.origin?.x ?? 0.5;
        const oy = def?.origin?.y ?? 1.0;
        const drawX = Math.round((gx + (ox === 0.5 ? 0.5 : 0)) * ts - ox * fw);
        const drawY = Math.round((gy + (oy === 1.0 ? 1.0 : (oy === 0.5 ? 0.5 : 0))) * ts - oy * fh);
        this.assets.drawSprite(ctx, dec.sprite_id, drawX, drawY, 0, fw, fh);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(drawX, drawY - 12, Math.max(64, dec.sprite_id.length * 6), 11);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`MOVE ${dec.sprite_id}`, drawX + 2, drawY - 3);
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

    // 10. Превью курсора / активного инструмента и протягивания
    if (!this.playtest.active && !this.dragState) {
      // Превью протягивания комнаты
      if (this.roomStart && this.hoveredTileX >= 0) {
        const x0 = Math.min(this.roomStart.x, this.hoveredTileX);
        const x1 = Math.max(this.roomStart.x, this.hoveredTileX);
        const y0 = Math.min(this.roomStart.y, this.hoveredTileY);
        const y1 = Math.max(this.roomStart.y, this.hoveredTileY);
        const rw = (x1 - x0 + 1) * ts;
        const rh = (y1 - y0 + 1) * ts;
        const rx = x0 * ts;
        const ry = y0 * ts;

        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2 / this.zoom;
        ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(rx + rw / 2 - 38, ry + rh / 2 - 12, 76, 24);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + rw / 2 - 38, ry + rh / 2 - 12, 76, 24);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`🏛️ ${x1 - x0 + 1}×${y1 - y0 + 1}`, rx + rw / 2, ry + rh / 2);
      }

      // Превью протягивания зоны спавна
      if (this.mobZoneStart && this.hoveredTileX >= 0) {
        const x0 = Math.min(this.mobZoneStart.x, this.hoveredTileX);
        const x1 = Math.max(this.mobZoneStart.x, this.hoveredTileX);
        const y0 = Math.min(this.mobZoneStart.y, this.hoveredTileY);
        const y1 = Math.max(this.mobZoneStart.y, this.hoveredTileY);
        const zw = (x1 - x0 + 1) * ts;
        const zh = (y1 - y0 + 1) * ts;
        const zx = x0 * ts;
        const zy = y0 * ts;

        ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
        ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 2 / this.zoom;
        ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
        ctx.strokeRect(zx, zy, zw, zh);
        ctx.setLineDash([]);

        const tempZone = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
        const floors = this.getValidFloorTilesInZone(tempZone);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(zx + zw / 2 - 50, zy + zh / 2 - 12, 100, 24);
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1;
        ctx.strokeRect(zx + zw / 2 - 50, zy + zh / 2 - 12, 100, 24);
        ctx.fillStyle = '#f0abfc';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`👾 Пол: ${floors.length} мест`, zx + zw / 2, zy + zh / 2);
      }

      // Превью курсора на клетке
      if (this.hoveredTileX >= 0 && this.hoveredTileX < this.level.width &&
          this.hoveredTileY >= 0 && this.hoveredTileY < this.level.height) {
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
        } else if (this.activeTool === 'boss_spawn') {
          const bossId = this.selectedBossId || 'worm_boss';
          const bossDef = this.enemiesById.get(bossId);
          const spriteId = this.selectedBossSpriteId || bossDef?.sprite_variants[0] || 'boss_textalite';
          ctx.save();
          ctx.globalAlpha = 0.7;
          this.assets.drawSprite(ctx, spriteId, hx, hy, 0, ts, ts);
          ctx.restore();

          // Золотая корона превью
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(hx + ts / 2, hy - 6, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('👑', hx + ts / 2, hy - 5);
        } else if (this.activeTool === 'bevel') {
          ctx.fillStyle = 'rgba(74, 222, 128, 0.4)';
          ctx.beginPath();
          ctx.moveTo(hx, hy + ts);
          ctx.lineTo(hx + ts, hy + ts);
          ctx.lineTo(hx + ts, hy);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#4ade80';
          ctx.lineWidth = 2 / this.zoom;
          ctx.stroke();
        } else if (this.activeTool === 'passage') {
          const half = Math.floor(this.passageWidth / 2);
          const startY = Math.max(0, this.hoveredTileY - half);
          const endY = Math.min(this.level.height - 1, startY + this.passageWidth - 1);
          const pwH = (endY - startY + 1) * ts;

          ctx.fillStyle = 'rgba(234, 179, 8, 0.25)';
          ctx.fillRect(hx, startY * ts, ts, pwH);
          ctx.strokeStyle = '#eab308';
          ctx.lineWidth = 2 / this.zoom;
          ctx.strokeRect(hx, startY * ts, ts, pwH);

          if (this.passageAutoWalls) {
            ctx.fillStyle = 'rgba(56, 189, 248, 0.3)';
            if (startY > 0) ctx.fillRect(hx, (startY - 1) * ts, ts, ts);
            if (endY < this.level.height - 1) ctx.fillRect(hx, (endY + 1) * ts, ts, ts);
          }
        } else if (this.activeTool === 'walkability') {
          if (this.walkabilityMode === 'passable') {
            ctx.fillStyle = 'rgba(34, 197, 94, 0.4)';
            ctx.fillRect(hx, hy, ts, ts);
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 2 / this.zoom;
            ctx.strokeRect(hx, hy, ts, ts);
          } else {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
            ctx.fillRect(hx, hy, ts, ts);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2 / this.zoom;
            ctx.strokeRect(hx, hy, ts, ts);
          }
        } else if (this.activeTool === 'room') {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
          ctx.fillRect(hx, hy, ts, ts);
        } else if (this.activeTool === 'mob_zone') {
          ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
          ctx.fillRect(hx, hy, ts, ts);
        } else if (this.activeTool === 'transition') {
          ctx.fillStyle = 'rgba(14, 165, 233, 0.3)';
          ctx.fillRect(hx, hy, ts, ts * 2);
          ctx.strokeStyle = '#38bdf8';
          ctx.strokeRect(hx, hy, ts, ts * 2);
        } else if (this.activeTool === 'decor' && this.selectedDecorSpriteId) {
          const def = this.assets.getSpriteDef(this.selectedDecorSpriteId);
          const fw = def?.frame_width ?? ts;
          const fh = def?.frame_height ?? ts;
          const ox = def?.origin?.x ?? 0.5;
          const oy = def?.origin?.y ?? 1.0;
          const posX = this.hoveredTileX + (ox === 0.5 ? 0.5 : 0);
          const posY = this.hoveredTileY + (oy === 1.0 ? 1.0 : (oy === 0.5 ? 0.5 : 0));
          const drawX = Math.round(posX * ts - ox * fw);
          const drawY = Math.round(posY * ts - oy * fh);
          ctx.save();
          ctx.globalAlpha = 0.6;
          this.assets.drawSprite(ctx, this.selectedDecorSpriteId, drawX, drawY, 0, fw, fh);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX, drawY, fw, fh);
          ctx.restore();
        }

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2 / this.zoom;
        ctx.strokeRect(hx, hy, ts, ts);
      }
    }

    ctx.restore();

    // 11. Экранные элементы управления и HUD Playtest
    if (this.playtest.active) {
      this.renderPlaytestHUD();
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

  // --- Отрисовка декора и интерактивных объектов (Decor) ---
  private renderDecor(ctx: CanvasRenderingContext2D, targetLayer: 'back' | 'front') {
    if (!this.level?.decor || this.level.decor.length === 0) return;
    const ts = this.level.tile_size;

    this.level.decor.forEach((d, idx) => {
      const isBack = d.layer === 'back';
      if ((targetLayer === 'back' && !isBack) || (targetLayer === 'front' && isBack)) return;

      const def = this.assets.getSpriteDef(d.sprite_id);
      const fw = def?.frame_width ?? ts;
      const fh = def?.frame_height ?? ts;
      const ox = def?.origin?.x ?? 0.5;
      const oy = def?.origin?.y ?? 1.0;

      const drawX = Math.round(d.x * ts - ox * fw);
      const drawY = Math.round(d.y * ts - oy * fh);

      this.assets.drawSprite(ctx, d.sprite_id, drawX, drawY, 0, fw, fh);

      if (this.selectedDecorIndex === idx) {
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2 / this.zoom;
        ctx.setLineDash([4 / this.zoom, 2 / this.zoom]);
        ctx.strokeRect(drawX - 2, drawY - 2, fw + 4, fh + 4);

        ctx.setLineDash([]);
        ctx.fillStyle = '#0284c7';
        const labelText = `${d.sprite_id} (${d.layer || 'front'})`;
        const badgeW = Math.max(64, labelText.length * 6);
        ctx.fillRect(drawX - 2, drawY - 14, badgeW, 12);
        ctx.fillStyle = '#ffffff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(labelText, drawX, drawY - 5);
        ctx.restore();
      }
    });
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

  // --- Отрисовка комнат (Rooms) ---
  private renderRooms(ctx: CanvasRenderingContext2D) {
    if (!this.level || !this.level.rooms || this.level.rooms.length === 0) return;
    const ts = this.level.tile_size;

    this.level.rooms.forEach((room, idx) => {
      const isSelected = idx === this.selectedRoomIndex;
      const rx = room.x * ts;
      const ry = room.y * ts;
      const rw = room.width * ts;
      const rh = room.height * ts;

      // Полупрозрачный фон комнаты
      ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.16)' : 'rgba(56, 189, 248, 0.06)';
      ctx.fillRect(rx, ry, rw, rh);

      // Контур комнаты
      ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = isSelected ? 2.5 / this.zoom : 1.5 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      // Угловые скосы, если включены
      if (room.beveled) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
        // 4 скошенных треугольника по углам
        ctx.beginPath(); ctx.moveTo(rx, ry + ts); ctx.lineTo(rx + ts, ry); ctx.lineTo(rx, ry); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(rx + rw - ts, ry); ctx.lineTo(rx + rw, ry + ts); ctx.lineTo(rx + rw, ry); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(rx, ry + rh - ts); ctx.lineTo(rx + ts, ry + rh); ctx.lineTo(rx, ry + rh); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(rx + rw - ts, ry + rh); ctx.lineTo(rx + rw, ry + rh - ts); ctx.lineTo(rx + rw, ry + rh); ctx.closePath(); ctx.fill();
      }

      // Бейдж комнаты
      const label = `🏛️ ${room.name} [${room.width}×${room.height}]`;
      const badgeW = Math.min(rw - 8, 140);
      if (badgeW > 20) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(rx + 4, ry + 4, badgeW, 16);
        ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(56, 189, 248, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 4, ry + 4, badgeW, 16);

        ctx.fillStyle = isSelected ? '#7dd3fc' : '#94a3b8';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 18), rx + 8, ry + 12);
      }
    });
  }

  // --- Отрисовка зон спавна мобов на полу (Mob Spawn Zones) ---
  private renderMobZones(ctx: CanvasRenderingContext2D) {
    if (!this.level || !this.level.spawn_zones || this.level.spawn_zones.length === 0) return;
    const ts = this.level.tile_size;

    this.level.spawn_zones.forEach((zone, idx) => {
      const isSelected = idx === this.selectedMobZoneIndex;
      const zx = zone.x * ts;
      const zy = zone.y * ts;
      const zw = zone.width * ts;
      const zh = zone.height * ts;

      // Полупрозрачная заливка
      ctx.fillStyle = isSelected ? 'rgba(168, 85, 247, 0.22)' : 'rgba(168, 85, 247, 0.08)';
      ctx.fillRect(zx, zy, zw, zh);

      // Пунктирный контур
      ctx.strokeStyle = isSelected ? '#c084fc' : 'rgba(168, 85, 247, 0.5)';
      ctx.lineWidth = isSelected ? 2.5 / this.zoom : 1.5 / this.zoom;
      ctx.setLineDash([5 / this.zoom, 3 / this.zoom]);
      ctx.strokeRect(zx, zy, zw, zh);
      ctx.setLineDash([]);

      // Подсветка доступных точек пола внутри этой зоны
      const floors = this.getValidFloorTilesInZone(zone);
      ctx.fillStyle = 'rgba(74, 222, 128, 0.6)';
      for (const f of floors) {
        // Зеленая полоса пола и маркер спавна
        ctx.fillRect(f.x * ts + 2, (f.y + 1) * ts - 4, ts - 4, 4);
        ctx.beginPath();
        ctx.arc((f.x + 0.5) * ts, (f.y + 0.7) * ts, 2.5 / this.zoom, 0, Math.PI * 2);
        ctx.fill();
      }

      // Бейдж зоны спавна
      const label = `👾 ${zone.name || zone.enemy_id} (×${zone.count}, пол: ${floors.length})`;
      const badgeW = Math.min(zw - 8, 160);
      if (badgeW > 20) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(zx + 4, zy + 4, badgeW, 16);
        ctx.strokeStyle = isSelected ? '#c084fc' : 'rgba(168, 85, 247, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(zx + 4, zy + 4, badgeW, 16);

        ctx.fillStyle = isSelected ? '#f0abfc' : '#d8b4fe';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 22), zx + 8, zy + 12);
      }
    });
  }

  // --- Оверлей кубиков проходимости (Walkability Grid) ---
  private renderWalkabilityGrid(ctx: CanvasRenderingContext2D) {
    if (!this.level) return;
    const ts = this.level.tile_size;

    for (let cy = 0; cy < this.level.height; cy++) {
      for (let cx = 0; cx < this.level.width; cx++) {
        const ox = cx * ts;
        const oy = cy * ts;
        const isSolid = this.isSolidAtPixel((cx + 0.5) * ts, (cy + 0.5) * ts);
        const slope = this.getSlope(cx, cy);

        if (isSolid) {
          if (slope) {
            // Диагональный скос
            ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
            ctx.beginPath();
            if (slope === 'up_right') {
              ctx.moveTo(ox, oy + ts); ctx.lineTo(ox + ts, oy + ts); ctx.lineTo(ox + ts, oy);
            } else if (slope === 'up_left') {
              ctx.moveTo(ox, oy); ctx.lineTo(ox, oy + ts); ctx.lineTo(ox + ts, oy + ts);
            } else if (slope === 'ceil_right') {
              ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy); ctx.lineTo(ox + ts, oy + ts);
            } else if (slope === 'ceil_left') {
              ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy); ctx.lineTo(ox, oy + ts);
            }
            ctx.closePath();
            ctx.fill();

            // Линия проходимого подъема
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2 / this.zoom;
            ctx.beginPath();
            if (slope === 'up_right') {
              ctx.moveTo(ox, oy + ts); ctx.lineTo(ox + ts, oy);
            } else if (slope === 'up_left') {
              ctx.moveTo(ox, oy); ctx.lineTo(ox + ts, oy + ts);
            }
            ctx.stroke();
          } else {
            // Непроходимый блок (Стена / Потолок)
            ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
            ctx.fillRect(ox, oy, ts, ts);

            ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
            ctx.lineWidth = 1 / this.zoom;
            ctx.strokeRect(ox, oy, ts, ts);

            // Маленький красный значок блокировки
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.arc(ox + ts / 2, oy + ts / 2, 2.5 / this.zoom, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // Проходимая область (Воздух или Пол)
          const isFloorBelow = cy < this.level.height - 1 && this.isSolidAtPixel((cx + 0.5) * ts, (cy + 1.5) * ts);
          if (isFloorBelow) {
            // ЗЕЛЕНЫЙ КУБИК: Поверхность пола, по которой игрок ходит
            ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
            ctx.fillRect(ox, oy, ts, ts);

            // Зеленый индикатор пола
            ctx.fillStyle = '#22c55e';
            ctx.fillRect(ox, oy + ts - 3, ts, 3);

            ctx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
            ctx.lineWidth = 1 / this.zoom;
            ctx.strokeRect(ox, oy, ts, ts);

            // Иконка шага/проходимости
            ctx.fillStyle = '#4ade80';
            ctx.beginPath();
            ctx.arc(ox + ts / 2, oy + ts * 0.7, 2.5 / this.zoom, 0, Math.PI * 2);
            ctx.fill();
          } else {
            // Проходимый воздух (для прыжков и маневров)
            ctx.fillStyle = 'rgba(14, 165, 233, 0.06)';
            ctx.fillRect(ox, oy, ts, ts);

            ctx.strokeStyle = 'rgba(14, 165, 233, 0.18)';
            ctx.lineWidth = 1 / this.zoom;
            ctx.strokeRect(ox, oy, ts, ts);
          }
        }
      }
    }
  }

  public toggleWalkability(): boolean {
    this.showWalkability = !this.showWalkability;
    this.render();
    return this.showWalkability;
  }


}
