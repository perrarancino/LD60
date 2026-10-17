import { AnimatedSprite, Assets, Rectangle, Sprite, Texture } from 'pixi.js';
import spritesJson from '../../data/sprites/sprites.json';
import type { SpriteDef } from '../data/types.ts';

// Vite собирает все PNG из assets/sprites и отдаёт их URL; в коде используются только id спрайтов
const PNG_URLS = import.meta.glob('../../assets/sprites/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const DEFAULT_FRAME_MS = 100;

/**
 * Реестр спрайтов: грузит PNG-листы, нарезает на кадры и создаёт Sprite / AnimatedSprite по id
 * из data/sprites/sprites.json.
 */
export class SpriteLibrary {
  private defs = new Map<string, SpriteDef>();
  private frames = new Map<string, Texture[]>();
  private sheets = new Map<string, Texture>();

  constructor() {
    for (const def of (spritesJson as { sprites: SpriteDef[] }).sprites) {
      this.defs.set(def.id, def);
    }
  }

  /** Загружает и нарезает листы указанных спрайтов (повторные вызовы безопасны). */
  public async load(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.loadOne(id)));
  }

  private async loadOne(id: string): Promise<void> {
    if (this.frames.has(id)) return;
    const def = this.def(id);
    const url = PNG_URLS[`../../assets/sprites/${def.image}`];
    if (!url) throw new Error(`[SpriteLibrary] нет PNG для спрайта "${id}": ${def.image}`);

    const sheet: Texture = await Assets.load(url);
    sheet.source.scaleMode = 'nearest'; // чёткий пиксель-арт
    this.sheets.set(id, sheet);

    const cols = def.columns ?? def.frames;
    const textures: Texture[] = [];
    for (let i = 0; i < def.frames; i++) {
      const frame = new Rectangle(
        (i % cols) * def.frame_width,
        Math.floor(i / cols) * def.frame_height,
        def.frame_width,
        def.frame_height
      );
      textures.push(new Texture({ source: sheet.source, frame }));
    }
    this.frames.set(id, textures);
  }

  /** Пиксели загруженного PNG (для нарезки на части кодом, например рук-канатов). */
  public imageData(id: string): ImageData {
    const sheet = this.sheets.get(id);
    if (!sheet) throw new Error(`[SpriteLibrary] спрайт "${id}" не загружен (вызови load)`);
    const { width, height } = sheet.source;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(sheet.source.resource as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  }

  public def(id: string): SpriteDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`[SpriteLibrary] неизвестный спрайт "${id}"`);
    return def;
  }

  /** Статичный спрайт (кадр 0) с точкой привязки из реестра. */
  public createSprite(id: string): Sprite {
    const sprite = new Sprite(this.textures(id)[0]);
    sprite.anchor.set(this.def(id).origin.x, this.def(id).origin.y);
    return sprite;
  }

  /** Анимированный спрайт по имени анимации (по умолчанию "idle"). */
  public createAnimated(id: string, animation = 'idle'): AnimatedSprite {
    const def = this.def(id);
    const anim = def.animations[animation];
    if (!anim) throw new Error(`[SpriteLibrary] у "${id}" нет анимации "${animation}"`);

    const textures = this.textures(id);
    const time = anim.frame_duration_ms ?? DEFAULT_FRAME_MS;
    const sprite = new AnimatedSprite(anim.frames.map((f) => ({ texture: textures[f], time })));
    sprite.anchor.set(def.origin.x, def.origin.y);
    sprite.loop = anim.loop;
    if (anim.frames.length > 1) sprite.play();
    return sprite;
  }

  private textures(id: string): Texture[] {
    const t = this.frames.get(id);
    if (!t) throw new Error(`[SpriteLibrary] спрайт "${id}" не загружен (вызови load)`);
    return t;
  }
}
