import type { SpriteDef } from '../data/types.ts';
import type { CanonXf } from './model.ts';

/** Картинки спрайтов из assets/sprites (отдаёт сервер редактора по /ld60-assets/…): кадры листа рисуются на canvas с точкой привязки. */
export class SpriteAtlas {
  private readonly defs = new Map<string, SpriteDef>();
  private readonly images = new Map<string, HTMLImageElement | 'loading' | 'error'>();
  private readonly thumbs = new Map<string, string>();
  /** Вызывается, когда дозагрузилась очередная картинка (перерисовать холст). */
  public onLoad: () => void = () => {};

  constructor(sprites: SpriteDef[]) {
    for (const s of sprites) this.defs.set(s.id, s);
  }

  public def(id: string): SpriteDef | undefined {
    return this.defs.get(id);
  }

  public all(): SpriteDef[] {
    return [...this.defs.values()];
  }

  private image(def: SpriteDef): HTMLImageElement | null {
    const cur = this.images.get(def.image);
    if (cur instanceof HTMLImageElement) return cur;
    if (cur === undefined) {
      this.images.set(def.image, 'loading');
      const img = new Image();
      img.onload = () => {
        this.images.set(def.image, img);
        this.onLoad();
      };
      img.onerror = () => this.images.set(def.image, 'error');
      img.src = `/ld60-assets/${def.image}`;
    }
    return null;
  }

  /** Размер кадра спрайта (пиксели арта). */
  public size(id: string): { w: number; h: number } {
    const d = this.defs.get(id);
    return d ? { w: d.frame_width, h: d.frame_height } : { w: 32, h: 32 };
  }

  /**
   * Рисует кадр спрайта так, что его точка привязки (origin) ставится в (x, y). flipX/flipY отражают вокруг этой точки.
   * Нет картинки или спрайта — рисует метку-заглушку и возвращает false.
   */
  public draw(ctx: CanvasRenderingContext2D, id: string, frame: number, x: number, y: number, opts: { flipX?: boolean; flipY?: boolean; alpha?: number } = {}): boolean {
    const def = this.defs.get(id);
    if (!def) return this.placeholder(ctx, x, y, 24, 24, id);
    const img = this.image(def);
    if (!img) return false;
    const cols = def.columns ?? def.frames;
    const fi = Math.max(0, Math.min(def.frames - 1, frame));
    const sx = (fi % cols) * def.frame_width;
    const sy = Math.floor(fi / cols) * def.frame_height;
    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha *= opts.alpha;
    ctx.translate(x, y);
    ctx.scale(opts.flipX ? -1 : 1, opts.flipY ? -1 : 1);
    ctx.drawImage(img, sx, sy, def.frame_width, def.frame_height, -def.frame_width * def.origin.x, -def.frame_height * def.origin.y, def.frame_width, def.frame_height);
    ctx.restore();
    return true;
  }

  /** Тайл (кадр) в клетке с левым верхним углом (x, y): отражение и поворот вокруг центра клетки. */
  public drawTile(ctx: CanvasRenderingContext2D, id: string, frame: number, x: number, y: number, size: number, xf?: CanonXf, alpha = 1): boolean {
    const def = this.defs.get(id);
    if (!def) return this.placeholder(ctx, x + size / 2, y + size / 2, size, size, id);
    const img = this.image(def);
    if (!img) return false;
    const cols = def.columns ?? def.frames;
    const fi = Math.max(0, Math.min(def.frames - 1, frame));
    ctx.save();
    if (alpha !== 1) ctx.globalAlpha *= alpha;
    ctx.translate(x + size / 2, y + size / 2);
    if (xf) {
      ctx.rotate((xf.rot * Math.PI) / 180);
      if (xf.flip_x) ctx.scale(-1, 1);
    }
    ctx.drawImage(img, (fi % cols) * def.frame_width, Math.floor(fi / cols) * def.frame_height, def.frame_width, def.frame_height, -size / 2, -size / 2, size, size);
    ctx.restore();
    return true;
  }

  private placeholder(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, label: string): boolean {
    ctx.save();
    ctx.fillStyle = 'rgba(244, 63, 94, 0.25)';
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.strokeRect(cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#fecdd3';
    ctx.font = '8px monospace';
    ctx.fillText(label.slice(0, 8), cx - w / 2 + 2, cy);
    ctx.restore();
    return false;
  }

  /** Картинка-миниатюра (data URL) кадра: для палитр. Пока картинка не загрузилась — null. */
  public thumb(id: string, frame = 0): string | null {
    const key = `${id}#${frame}`;
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    const def = this.defs.get(id);
    if (!def) return null;
    const img = this.image(def);
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = def.frame_width;
    c.height = def.frame_height;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const cols = def.columns ?? def.frames;
    g.drawImage(img, (frame % cols) * def.frame_width, Math.floor(frame / cols) * def.frame_height, def.frame_width, def.frame_height, 0, 0, def.frame_width, def.frame_height);
    const url = c.toDataURL();
    this.thumbs.set(key, url);
    return url;
  }
}
