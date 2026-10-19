import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { LevelDef, LevelObjectDef } from '../data/types.ts';
import { Quest } from '../systems/Quest.ts';
import { getSharedOutlineFilter } from '../effects/OutlineFilter.ts';
import { itemDef, objectKind } from './placeables.ts';
import type { ObjectKind } from './placeables.ts';

const PICK_REACH = 24; // px: на таком расстоянии по горизонтали предмет подбирается
const HERO_HEIGHT = 58; // px: рост героя — предмет выше головы не берётся
const LOCKED_TINT = 0xa9b4c4;
const DOOR_OPEN_R = 52; // px по горизонтали: ближе — дверь открывается сама
const DOOR_CLOSE_R = 110; // дальше — закрывается

export interface ObjectEvents {
  /** Дверь ведёт на другой уровень. */
  travel(levelId: string, doorId: string): void;
  /** Дверь ведёт к другой двери этого же уровня: герой переносится в точку (мир, px). */
  teleport(x: number, y: number): void;
  /** Заперто / нечего вставить: подсказка героя (мир, px). */
  denied(x: number, y: number): void;
  /** Предмет подобран / вставлен в подставку. */
  collected(x: number, y: number, item: string): void;
}

import { WorldProgression } from '../systems/WorldProgression.ts';

interface Placed {
  def: LevelObjectDef;
  kind: ObjectKind;
  node: Container;
  sprite: Sprite;
  overlay: Sprite | null; // вставленный предмет на подставке
  t: number;
  isOpen: boolean;
  openProgress: number; // 0..1
}

const prop = (o: LevelObjectDef, key: string): string => String(o.props?.[key] ?? '');

/**
 * Объекты уровня из level.objects (двери, квестовые предметы, подставки): рисуются спрайтом из каталога и работают по поведению:
 *  door — клик мыши ведёт к другой двери (запертая — пока нет предмета/флага), pickup — предмет подбирается касанием или кликом,
 *  socket — клик вставляет предмет и ставит флаг, prop — только обстановка.
 */
export class LevelObjects {
  public readonly container = new Container();
  private readonly placed: Placed[] = [];

  constructor(private readonly level: LevelDef, sprites: SpriteLibrary, private readonly events: ObjectEvents, private readonly quest = Quest.get()) {
    for (const def of level.objects ?? []) {
      const kind = objectKind(def.type);
      if (!kind) {
        console.warn(`[Objects] неизвестный тип объекта "${def.type}" (${def.id}) — пропущен`);
        continue;
      }
      if (kind.behavior === 'pickup' && quest.wasTaken(level.id, def.id)) continue; // уже подобран
      const node = new Container();
      node.position.set(def.x, def.y);
      const sprite = sprites.createSprite(kind.behavior === 'pickup' ? itemDef(prop(def, 'item'))?.sprite_id ?? kind.sprite_id : kind.sprite_id);
      if (def.flip_x) sprite.scale.x = -1;
      node.addChild(sprite);

      let overlay: Sprite | null = null;
      if (kind.behavior === 'socket' && kind.overlay) {
        overlay = sprites.createSprite(kind.overlay.sprite_id);
        overlay.position.set(kind.overlay.x * (def.flip_x ? -1 : 1), kind.overlay.y);
        overlay.visible = this.inserted(def);
        node.addChild(overlay);
      }
      this.container.addChild(node);
      this.placed.push({ def, kind, node, sprite, overlay, t: Math.random() * 6, isOpen: false, openProgress: 0 });
    }
  }

  private inserted(def: LevelObjectDef): boolean {
    return this.quest.flag(`socket:${this.level.id}:${def.id}`);
  }

  public doorOpen(def: LevelObjectDef): boolean {
    if (this.level.id === 'world_prototype') {
      if (!WorldProgression.get().canOpenDoor(def.id)) return false;
    }
    const item = prop(def, 'requires_item');
    const flag = prop(def, 'requires_flag');
    return (!item || this.quest.has(item)) && (!flag || this.quest.flag(flag));
  }

  /** Проверяет, блокирует ли какая-либо закрытая дверь клетку (cx, cy) */
  public isDoorBlocking(cx: number, cy: number): boolean {
    const ts = this.level.tile_size;
    for (const p of this.placed) {
      if (p.kind.behavior !== 'door') continue;
      if (p.isOpen && p.openProgress > 0.6) continue; // открытая дверь не блокирует проход
      const dcx = Math.floor(p.def.x / ts);
      const dcyBottom = Math.floor((p.def.y - 1) / ts);
      const dcyTop = dcyBottom - 1;
      if (cx === dcx && (cy === dcyBottom || cy === dcyTop)) {
        return true;
      }
    }
    return false;
  }

  /** Точка (низ двери, мир px) двери с id, null — такой нет. */
  public doorPoint(id: string): { x: number; y: number } | null {
    const d = this.placed.find((p) => p.def.id === id && p.kind.behavior === 'door');
    return d ? { x: d.def.x, y: d.def.y } : null;
  }

  /** hero — ноги героя (мир, px). */
  public update(
    dt: number,
    hero: { x: number; y: number },
    frozen: boolean,
    aim: { x: number; y: number } | null = null,
    mouseClick = false
  ): { hovered: boolean; interacted: boolean } {
    let anyHovered = false;
    let mouseInteracted = false;

    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      p.t += dt;
      const { def, kind } = p;

      const w = p.sprite.texture.width || 32;
      const h = p.sprite.texture.height || 32;
      const ax = p.sprite.anchor.x;
      const ay = p.sprite.anchor.y;
      const flip = def.flip_x;
      const minX = def.x + (flip ? -(1 - ax) * w : -ax * w) - 6;
      const maxX = def.x + (flip ? ax * w : (1 - ax) * w) + 6;
      const minY = def.y - ay * h - 6;
      const maxY = def.y + (1 - ay) * h + 6;

      const isInteractive = kind.behavior === 'door' || kind.behavior === 'socket' || kind.behavior === 'pickup';
      const hovered = !frozen && isInteractive && aim !== null &&
        aim.x >= minX && aim.x <= maxX && aim.y >= minY && aim.y <= maxY;

      if (hovered) anyHovered = true;

      // Контурная обводка спрайта при наведении
      if (hovered) {
        const outline = getSharedOutlineFilter().filter;
        p.sprite.filters = [outline];
        if (p.overlay && p.overlay.visible) p.overlay.filters = [outline];
      } else {
        if (p.sprite.filters) p.sprite.filters = null;
        if (p.overlay?.filters) p.overlay.filters = null;
      }

      // Клик мыши по подсвеченному объекту
      if (mouseClick && hovered && !mouseInteracted) {
        mouseInteracted = true;
        const heroDist = Math.hypot(hero.x - def.x, hero.y - (def.y - h * ay));
        const MOUSE_REACH = 96;
        if (heroDist <= MOUSE_REACH) {
          if (kind.behavior === 'pickup') {
            this.collect(i);
            continue;
          } else {
            this.use(p);
          }
        } else {
          this.events.denied(def.x, def.y - 20);
        }
      }

      if (kind.behavior === 'pickup') {
        p.sprite.y = Math.round(Math.sin(p.t * 3) * 2);
        // касание телом героя: предмет в полосе его роста и в пределах PICK_REACH по горизонтали
        if (!frozen && Math.abs(hero.x - def.x) < PICK_REACH && def.y > hero.y - HERO_HEIGHT && def.y < hero.y + 10) this.collect(i);
        continue;
      }

      if (kind.behavior === 'door') {
        // Дверь открывается, когда герой подходит (если ей можно: прогрессия карты, предмет/флаг, бой в комнате), и закрывается, когда он отходит
        // или ей снова нельзя (начался бой). Гистерезис: открывается ближе DOOR_OPEN_R, закрывается дальше DOOR_CLOSE_R.
        const dx = Math.abs(hero.x - def.x);
        const dyHero = def.y - hero.y; // ноги героя выше низа двери — по высоте двери
        const near = !frozen && dx <= DOOR_OPEN_R && dyHero >= -16 && dyHero <= 90;
        const away = dx > DOOR_CLOSE_R || dyHero < -40 || dyHero > 140;
        const allowed = this.doorOpen(def);
        if (!allowed || away) p.isOpen = false;
        else if (near) p.isOpen = true;

        // Плавное открытие/закрытие шторки двери вверх
        const targetProgress = p.isOpen ? 1 : 0;
        p.openProgress += (targetProgress - p.openProgress) * Math.min(1, dt * 10);
        p.sprite.y = Math.round(-p.openProgress * 52);
        p.sprite.tint = this.doorOpen(def) ? 0xffffff : LOCKED_TINT;
      }
    }

    return { hovered: anyHovered, interacted: mouseInteracted };
  }

  private collect(index: number): void {
    const p = this.placed[index];
    p.sprite.filters = null;
    if (p.overlay) p.overlay.filters = null;
    const item = prop(p.def, 'item') || 'item';
    this.quest.add(item);
    this.quest.markTaken(this.level.id, p.def.id);
    this.events.collected(p.def.x, p.def.y, item);
    p.node.destroy({ children: true });
    this.placed.splice(index, 1);
  }

  private use(p: Placed): void {
    const { def, kind } = p;
    if (kind.behavior === 'door') {
      if (!this.doorOpen(def)) {
        this.events.denied(def.x, def.y - 40);
        return;
      }

      // Если дверь была закрыта — поднимаем шторку
      if (!p.isOpen) {
        p.isOpen = true;
        this.events.collected(def.x, def.y - 30, 'door');
        return;
      }

      // Если дверь уже открыта и ведет на другой уровень или дверь — переход
      const toLevel = prop(def, 'to_level');
      const toDoor = prop(def, 'to_door');
      if (toLevel && toLevel !== this.level.id) {
        this.events.travel(toLevel, toDoor);
        return;
      }
      if (toDoor) {
        const to = this.doorPoint(toDoor);
        if (to) this.events.teleport(to.x, to.y);
      }
      return;
    }
    if (kind.behavior === 'socket') {
      const need = prop(def, 'needs_item');
      if (need && !this.quest.take(need)) {
        this.events.denied(def.x, def.y - 40);
        return;
      }
      this.quest.setFlag(`socket:${this.level.id}:${def.id}`);
      const flag = prop(def, 'sets_flag');
      if (flag) this.quest.setFlag(flag);
      if (p.overlay) p.overlay.visible = true;
      this.events.collected(def.x, def.y - 30, need);
    }
  }
}
