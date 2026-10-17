import type { SpriteDef } from './types';

export class AssetManager {
  private sprites = new Map<string, SpriteDef>();
  private images = new Map<string, HTMLImageElement>();
  private loadPromises = new Map<string, Promise<HTMLImageElement>>();

  public setSprites(spriteDefs: SpriteDef[]) {
    this.sprites.clear();
    for (const def of spriteDefs) {
      this.sprites.set(def.id, def);
    }
  }

  public getSpriteDef(id: string): SpriteDef | undefined {
    return this.sprites.get(id);
  }

  public getAllSprites(): SpriteDef[] {
    return Array.from(this.sprites.values());
  }

  public async preloadAll(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const def of this.sprites.values()) {
      promises.push(this.loadImage(def.image));
    }
    await Promise.allSettled(promises);
  }

  public loadImage(imageRelativePath: string): Promise<HTMLImageElement> {
    const cached = this.images.get(imageRelativePath);
    if (cached) return Promise.resolve(cached);

    const pending = this.loadPromises.get(imageRelativePath);
    if (pending) return pending;

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.images.set(imageRelativePath, img);
        this.loadPromises.delete(imageRelativePath);
        resolve(img);
      };
      img.onerror = (e) => {
        console.warn(`[AssetManager] Failed to load image: /ld60-assets/${imageRelativePath}`, e);
        this.loadPromises.delete(imageRelativePath);
        reject(e);
      };
      img.src = `/ld60-assets/${imageRelativePath}`;
    });

    this.loadPromises.set(imageRelativePath, promise);
    return promise;
  }

  public getImage(imageRelativePath: string): HTMLImageElement | undefined {
    return this.images.get(imageRelativePath);
  }

  /**
   * Отрисовать спрайт по его ID в пиксельных координатах мира
   */
  public drawSprite(
    ctx: CanvasRenderingContext2D,
    spriteId: string,
    x: number,
    y: number,
    frameIndex: number = 0,
    destW?: number,
    destH?: number
  ): boolean {
    const def = this.sprites.get(spriteId);
    if (!def) {
      // Рисуем плейсхолдер с id
      ctx.fillStyle = '#ff0055';
      ctx.fillRect(x, y, destW || 32, destH || 32);
      ctx.fillStyle = '#fff';
      ctx.font = '9px monospace';
      ctx.fillText(spriteId.slice(0, 4), x + 2, y + 12);
      return false;
    }

    const img = this.images.get(def.image);
    if (!img) {
      this.loadImage(def.image).catch(() => {});
      ctx.fillStyle = 'rgba(255, 100, 100, 0.4)';
      ctx.fillRect(x, y, destW || def.frame_width, destH || def.frame_height);
      return false;
    }

    const fw = def.frame_width || img.width;
    const fh = def.frame_height || img.height;
    const targetW = destW ?? fw;
    const targetH = destH ?? fh;

    const safeFrame = def.frames > 0 ? (frameIndex % def.frames) : 0;
    const sx = safeFrame * fw;
    const sy = 0;

    ctx.drawImage(img, sx, sy, fw, fh, x, y, targetW, targetH);
    return true;
  }

  /**
   * Отрисовать сущность в координатах тайловой сетки с учетом origin ног
   */
  public drawEntityAtTile(
    ctx: CanvasRenderingContext2D,
    spriteId: string,
    tileX: number,
    tileY: number,
    tileSize: number,
    frameIndex: number = 0
  ) {
    const def = this.sprites.get(spriteId);
    if (!def) {
      this.drawSprite(ctx, spriteId, tileX * tileSize, tileY * tileSize, frameIndex, tileSize, tileSize);
      return;
    }

    // В LD60 низ сущности привязан к нижней грани клетки (tileY + 1) * tileSize
    // а горизонтальный центр к середине клетки (tileX + 0.5) * tileSize
    const originX = def.origin?.x ?? 0.5;
    const originY = def.origin?.y ?? 1.0;

    const fw = def.frame_width;
    const fh = def.frame_height;

    const groundX = (tileX + 0.5) * tileSize;
    const groundY = (tileY + 1) * tileSize;

    const drawX = Math.round(groundX - originX * fw);
    const drawY = Math.round(groundY - originY * fh);

    this.drawSprite(ctx, spriteId, drawX, drawY, frameIndex, fw, fh);
  }
}
