import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Level } from '../world/Level.ts';
import type { Player } from '../entities/Player.ts';
import type { Particles } from '../effects/Particles.ts';
import { Armor, type DropKind } from './ArmorSystem.ts';
import { SoundManager } from '../audio/SoundManager.ts';
import { getSharedOutlineFilter } from '../effects/OutlineFilter.ts';

interface DroppedItem {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounceCount: number;
  lifetime: number;
  magnetized: boolean;
}

const GRAVITY = 380;
const FRICTION = 0.85;
const RESTITUTION = 0.55;
const MAGNET_DIST = 46;
const PICKUP_DIST = 14;
const MAGNET_SPEED = 260;

export class LootSystem {
  public readonly container = new Container();
  private items: DroppedItem[] = [];

  constructor(
    private readonly sprites: SpriteLibrary,
    private readonly fx?: Particles
  ) {}

  /**
   * Выпадение лута при гибели врага: единственный ресурс — металлолом, сколько — зависит от вида моба (data/player/armor.json, scrap_drop).
   * enemyId — вид (spider, mother, worm, boss, critter) или id врага из данных.
   */
  public spawnFromEnemy(x: number, y: number, enemyId: string): void {
    let kind: DropKind = 'default';
    if (enemyId.includes('mother')) kind = 'mother';
    else if (enemyId.includes('boss')) kind = 'boss';
    else if (enemyId.includes('worm') || enemyId === 'burrower') kind = 'worm';
    else if (enemyId.includes('spider') || enemyId === 'crawler') kind = 'spider';
    else if (enemyId === 'critter') kind = 'critter';
    const n = Armor.get().dropAmount(kind);
    for (let i = 0; i < n; i++) this.spawnItem(x + (Math.random() * 12 - 6), y - 8 + (Math.random() * 8 - 4));
  }

  public spawnItem(x: number, y: number): void {
    const sprite = this.sprites.createSprite('mat_scrap');
    sprite.position.set(x, y);
    this.container.addChild(sprite);

    const angle = -Math.PI / 2 + (Math.random() * 1.2 - 0.6);
    const speed = 70 + Math.random() * 90;

    this.items.push({
      sprite,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      bounceCount: 0,
      lifetime: 0,
      magnetized: false
    });
  }

  public update(dt: number, level: Level, player: Player): void {
    const armor = Armor.get();
    const px = player.body.x;
    const py = player.body.y - 18; // центр тела игрока
    const ts = level.tileSize;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.lifetime += dt;

      const dx = px - it.x;
      const dy = py - it.y;
      const dist = Math.hypot(dx, dy);

      const effectiveMagnetDist = MAGNET_DIST;

      // Магнит к игроку
      if (dist < effectiveMagnetDist || it.magnetized) {
        it.magnetized = true;
        const magSpeed = MAGNET_SPEED * (1 + it.lifetime * 0.5);
        it.vx += (dx / Math.max(1, dist)) * magSpeed * dt * 4;
        it.vy += (dy / Math.max(1, dist)) * magSpeed * dt * 4;
        it.vx *= 0.92;
        it.vy *= 0.92;
        it.x += it.vx * dt;
        it.y += it.vy * dt;
      } else {
        // Физика гравитации и отскоков
        it.vy += GRAVITY * dt;
        const nextX = it.x + it.vx * dt;
        const nextY = it.y + it.vy * dt;

        // Коллизия с тайлами пола/стен
        const tileX = Math.floor(nextX / ts);
        const tileY = Math.floor((nextY + 3) / ts);

        if (level.isSolid(tileX, tileY)) {
          it.y = tileY * ts - 3;
          it.vy = -it.vy * RESTITUTION;
          it.vx *= FRICTION;
          it.bounceCount++;
          if (Math.abs(it.vy) < 20) it.vy = 0;
        } else {
          it.y = nextY;
        }

        const wallTileX = Math.floor((nextX + (it.vx > 0 ? 3 : -3)) / ts);
        const wallTileY = Math.floor(it.y / ts);
        if (level.isSolid(wallTileX, wallTileY)) {
          it.vx = -it.vx * RESTITUTION;
        } else {
          it.x = nextX;
        }
      }

      it.sprite.position.set(it.x, it.y);

      // Подбор игроком
      if (dist < PICKUP_DIST) {
        armor.addScrap(1);
        SoundManager.get().playScrapPickup();
        if (this.fx) {
          this.fx.burst(it.x, it.y, {
            count: 6, colors: [0x97b2c9, 0xd5ebff], speed: [30, 80], spread: Math.PI * 2, life: [0.15, 0.3], size: [1, 2]
          });
        }
        it.sprite.destroy();
        this.items.splice(i, 1);
      }
    }
  }

  /**
   * Проверка наведения курсора мыши на выпавший металлолом и клика по нему
   */
  public updateMouse(
    aim: { x: number; y: number } | null,
    mouseClicked: boolean,
    heroX: number,
    heroY: number
  ): { hovered: boolean; interacted: boolean } {
    if (!aim) return { hovered: false, interacted: false };
    let hovered = false;
    let interacted = false;

    for (const it of this.items) {
      const dist = Math.hypot(aim.x - it.x, aim.y - it.y);
      if (dist <= 16) {
        hovered = true;
        it.sprite.filters = [getSharedOutlineFilter().filter];
        if (mouseClicked && !interacted) {
          const heroDist = Math.hypot(heroX - it.x, heroY - it.y);
          if (heroDist <= 160) {
            it.magnetized = true;
            interacted = true;
            this.fx?.burst(it.x, it.y, {
              count: 6,
              colors: [0xfbc53d, 0xffffff],
              speed: [30, 80],
              spread: Math.PI * 2,
              life: [0.1, 0.25],
              size: [1, 2]
            });
          }
        }
      } else {
        if (it.sprite.filters) it.sprite.filters = null;
      }
    }

    return { hovered, interacted };
  }

  public clear(): void {
    for (const it of this.items) {
      it.sprite.filters = null;
      it.sprite.destroy();
    }
    this.items = [];
  }
}
