import placeablesJson from '../../data/objects/placeables.json';
import type { LevelObjectDef } from '../data/types.ts';

/**
 * Каталог расставляемого (data/objects/placeables.json): декор с его свойствами, нитки и объекты (двери, квестовые предметы).
 * Тот же файл читает редактор уровней: свойства (привязка к полу, шаг по пикселям, отражение, поля) описаны один раз.
 */

/** Куда привязывается при установке: free — куда ткнули, floor — на твёрдую поверхность под курсором, ceiling — под потолок. */
export type PlaceAnchor = 'free' | 'floor' | 'ceiling';
/** Шаг позиции по x: pixel — на любой пиксель, half — через пол-клетки, tile — на середину клетки. */
export type PlaceSnap = 'pixel' | 'half' | 'tile';

export interface PropDef {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'bool' | 'select' | 'level' | 'door' | 'item';
  default?: string | number | boolean;
  options?: string[];
}

export interface DecorKind {
  sprite_id: string;
  label: string;
  group?: string;
  anchor: PlaceAnchor;
  snap: PlaceSnap;
  layer?: 'back' | 'front';
  flip?: boolean;
}

export interface ThreadKind {
  kind: 'vine' | 'sky';
  label: string;
  sprite_id: string;
  hint?: string;
  defaults?: { pieces?: number; length?: number; swing?: number; bead?: boolean };
}

export type ObjectBehavior = 'door' | 'pickup' | 'socket' | 'terminal' | 'prop';

export interface ObjectKind {
  type: string;
  label: string;
  group?: string;
  behavior: ObjectBehavior;
  store?: 'objects' | 'terminals'; // где лежит в JSON уровня (по умолчанию objects)
  sprite_id: string;
  anchor: PlaceAnchor;
  snap: PlaceSnap;
  flip?: boolean;
  hint?: string;
  overlay?: { sprite_id: string; x: number; y: number }; // спрайт поверх (вставленная батарейка)
  props?: PropDef[];
}

export interface ItemDef {
  id: string;
  label: string;
  sprite_id: string;
}

export interface PlaceablesDef {
  version: string;
  items: ItemDef[];
  decor: DecorKind[];
  threads: ThreadKind[];
  objects: ObjectKind[];
}

export const PLACEABLES = placeablesJson as unknown as PlaceablesDef;

export function objectKind(type: string, catalog: PlaceablesDef = PLACEABLES): ObjectKind | undefined {
  return catalog.objects.find((o) => o.type === type);
}

export function itemDef(id: string, catalog: PlaceablesDef = PLACEABLES): ItemDef | undefined {
  return catalog.items.find((i) => i.id === id);
}

/** Спрайты, нужные объекту: сам объект, его наложение и предмет, который он выдаёт. */
export function objectSpriteIds(o: LevelObjectDef): string[] {
  const kind = objectKind(o.type);
  if (!kind) return [];
  const ids = [kind.sprite_id];
  if (kind.overlay) ids.push(kind.overlay.sprite_id);
  const item = o.props?.item;
  if (kind.behavior === 'pickup' && typeof item === 'string') {
    const def = itemDef(item);
    if (def) ids.push(def.sprite_id);
  }
  return ids;
}
