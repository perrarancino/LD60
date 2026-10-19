import { Assets } from 'pixi.js';
import { SoundManager } from '../audio/SoundManager.ts';
import { loadDamageFont } from '../effects/DamageNumbers.ts';

/**
 * Прогрев ассетов перед стартом: спрайты через Pixi Assets (попадают в его кеш, поэтому дальше грузятся мгновенно),
 * звуки — декодированные буферы SoundManager, плюс шрифт цифр урона. onProgress двигает полосу загрузки.
 *
 * Фазы намеренно упорядочены: спрайты -> звуки -> шрифт. Музыка (если файл появится в assets/audio/music) грузится
 * уже при входе в меню, чтобы не задерживать первую отрисовку.
 */

// Все PNG игры: тем же способом их собирает SpriteLibrary, поэтому URL совпадают и кеш Pixi переиспользуется
const PNG_URLS = import.meta.glob('../../assets/sprites/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const IMAGE_CHUNK = 12; // сколько картинок грузим разом: полоса движется ровно, сеть не захлёбывается

export interface PreloadProgress {
  /** 0..1 */
  value: number;
  label: string;
}

export async function preloadAssets(onProgress: (progress: PreloadProgress) => void): Promise<void> {
  onProgress({ value: 0.02, label: 'LOADING' });

  const urls = Object.values(PNG_URLS);
  const total = Math.max(1, urls.length);
  let loaded = 0;

  for (let i = 0; i < urls.length; i += IMAGE_CHUNK) {
    const chunk = urls.slice(i, i + IMAGE_CHUNK);
    await Promise.allSettled(chunk.map((url) => Assets.load(url)));
    loaded += chunk.length;
    onProgress({ value: 0.05 + 0.63 * (loaded / total), label: 'LOADING' });
  }

  onProgress({ value: 0.7, label: 'LOADING' });
  await SoundManager.get().preloadAll((done, count) => {
    onProgress({ value: 0.7 + 0.22 * (done / Math.max(1, count)), label: 'LOADING' });
  });

  onProgress({ value: 0.94, label: 'LOADING' });
  await loadDamageFont();

  onProgress({ value: 1, label: 'READY' });
}
