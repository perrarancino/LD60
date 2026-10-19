import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { LevelDef, LevelObjectDef } from '../data/types.ts';
import { Quest } from '../systems/Quest.ts';
import { InteractPrompt } from '../ui/InteractPrompt.ts';
import { itemDef, objectKind } from './placeables.ts';
import type { ObjectKind } from './placeables.ts';

const REACH_X = 24; // px: на таком расстоянии по горизонтали герой «у объекта»
const REACH_UP = 56; // px вверх от низа объекта
const PICK_RADIUS = 20; // px: касание предмета
const LOCKED_TINT = 0xa9b4c4;

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

interface Placed {
  def: LevelObjectDef;
  kind: ObjectKind;
  node: Container;
  sprite: Sprite;
  prompt: InteractPrompt | null;
  overlay: Sprite | null; // вставленный предмет на подставке
  t: number;
}

const prop = (o: LevelObjectDef, key: string): string => String(o.props?.[key] ?? '');

/**
 * Объекты уровня из level.objects (двери, квестовые предметы, подставки): рисуются спрайтом из каталога и работают по поведению:
 *  door — E ведёт к другой двери (запертая — пока нет предмета/флага), pickup — предмет подбирается касанием, socket — E вставляет предмет и ставит флаг,
 *  prop — только обстановка.
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
      const prompt = kind.behavior === 'door' || kind.behavior === 'socket' ? new InteractPrompt(-this.promptHeight(sprite)) : null;
      let overlay: Sprite | null = null;
      if (kind.behavior === 'socket' && kind.overlay) {
        overlay = sprites.createSprite(kind.overlay.sprite_id);
        overlay.position.set(kind.overlay.x * (def.flip_x ? -1 : 1), kind.overlay.y);
        overlay.visible = this.inserted(def);
        node.addChild(overlay);
      }
      if (prompt) node.addChild(prompt.graphics);
      this.container.addChild(node);
      this.placed.push({ def, kind, node, sprite, prompt, overlay, t: Math.random() * 6 });
    }
  }

  private promptHeight(sprite: Sprite): number {
    return Math.round(sprite.texture.height * (sprite.anchor.y || 1)) + 12;
  }

  private inserted(def: LevelObjectDef): boolean {
    return this.quest.flag(`socket:${this.level.id}:${def.id}`);
  }

  private doorOpen(def: LevelObjectDef): boolean {
    const item = prop(def, 'requires_item');
    const flag = prop(def, 'requires_flag');
    return (!item || this.quest.has(item)) && (!flag || this.quest.flag(flag));
  }

  /** Точка (низ двери, мир px) двери с id, null — такой нет. */
  public doorPoint(id: string): { x: number; y: number } | null {
    const d = this.placed.find((p) => p.def.id === id && p.kind.behavior === 'door');
    return d ? { x: d.def.x, y: d.def.y } : null;
  }

  /** hero — ноги героя (мир, px). */
  public update(dt: number, hero: { x: number; y: number }, interact: boolean, frozen: boolean): void {
    let target: Placed | null = null;
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      p.t += dt;
      const { def, kind } = p;
      if (kind.behavior === 'pickup') {
        p.sprite.y = Math.round(Math.sin(p.t * 3) * 2);
        if (!frozen && Math.hypot(hero.x - def.x, hero.y - 16 - def.y) < PICK_RADIUS) this.collect(i);
        continue;
      }
      const near = !frozen && Math.abs(hero.x - def.x) <= REACH_X && hero.y <= def.y + 6 && hero.y >= def.y - REACH_UP;
      if (kind.behavior === 'door') p.sprite.tint = this.doorOpen(def) ? 0xffffff : LOCKED_TINT;
      if (kind.behavior === 'socket') p.prompt?.update(dt, near && !this.inserted(def));
      else p.prompt?.update(dt, near);
      if (near && (kind.behavior === 'door' || (kind.behavior === 'socket' && !this.inserted(def)))) {
        if (!target || Math.abs(hero.x - def.x) < Math.abs(hero.x - target.def.x)) target = p;
      }
    }
    if (interact && target) this.use(target);
  }

  private collect(index: number): void {
    const p = this.placed[index];
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
      const toLevel = prop(def, 'to_level');
      const toDoor = prop(def, 'to_door');
      if (toLevel && toLevel !== this.level.id) {
        this.events.travel(toLevel, toDoor);
        return;
      }
      const to = this.doorPoint(toDoor);
      if (to) this.events.teleport(to.x, to.y);
      else this.events.denied(def.x, def.y - 40);
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
