import { Container, Sprite } from 'pixi.js';
import type { SpriteLibrary } from '../assets/SpriteLibrary.ts';
import type { Level } from '../world/Level.ts';
import type { Player } from '../entities/Player.ts';
import type { Particles } from '../effects/Particles.ts';
import { CraftingSystem, type MaterialType } from './CraftingSystem.ts';
import type { DamageNumbers } from '../effects/DamageNumbers.ts';

interface DroppedItem {
  type: MaterialType;
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
    private readonly fx?: Particles,
    private readonly numbers?: DamageNumbers
  ) {}

  /**
   * Выпадение лута при гибели врага
   */
  public spawnFromEnemy(x: number, y: number, enemyId: string): void {
    let drops: MaterialType[] = [];

    if (enemyId.includes('spider') || enemyId === 'crawler') {
      // С пауков: мусор и провода
      drops.push('scrap');
      if (Math.random() < 0.7) drops.push('wires');
      if (Math.random() < 0.25) drops.push('scrap');
    } else if (enemyId.includes('mother')) {
      // С матки: щедрый дроп всех 3 материалов
      drops.push('scrap', 'wires', 'discParts');
      if (Math.random() < 0.5) drops.push('wires');
      if (Math.random() < 0.5) drops.push('discParts');
    } else if (enemyId.includes('worm') || enemyId === 'burrower') {
      // С червя: мусор и дисковые детали
      drops.push('scrap');
      if (Math.random() < 0.75) drops.push('discParts');
      if (Math.random() < 0.3) drops.push('discParts');
    } else if (enemyId.includes('boss')) {
      // С босса: много деталей всех типов
      drops.push('scrap', 'scrap', 'wires', 'wires', 'discParts', 'discParts');
    } else {
      // Обычные противники
      const roll = Math.random();
      if (roll < 0.45) drops.push('scrap');
      else if (roll < 0.75) drops.push('wires');
      else drops.push('discParts');
    }

    // Бонусный дроп материалов при дисковой голове
    const head = CraftingSystem.get().activeParts.head;
    if (head.type === 'disc' && Math.random() < head.level * 0.2) {
      drops.push(Math.random() < 0.5 ? 'discParts' : 'scrap');
    }

    for (const mat of drops) {
      this.spawnItem(x + (Math.random() * 12 - 6), y - 8 + (Math.random() * 8 - 4), mat);
    }
  }

  public spawnItem(x: number, y: number, type: MaterialType): void {
    const spriteId = type === 'scrap' ? 'mat_scrap' : type === 'wires' ? 'mat_wire' : 'mat_disc';
    const sprite = this.sprites.createSprite(spriteId);
    sprite.position.set(x, y);
    this.container.addChild(sprite);

    const angle = -Math.PI / 2 + (Math.random() * 1.2 - 0.6);
    const speed = 70 + Math.random() * 90;

    this.items.push({
      type,
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
    const crafting = CraftingSystem.get();
    const px = player.body.x;
    const py = player.body.y - 18; // центр тела игрока
    const ts = level.tileSize;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.lifetime += dt;

      const dx = px - it.x;
      const dy = py - it.y;
      const dist = Math.hypot(dx, dy);

      const head = crafting.activeParts.head;
      const effectiveMagnetDist = head.type === 'disc' ? MAGNET_DIST * (1 + head.level * 0.8) : MAGNET_DIST;

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
        crafting.addMaterial(it.type, 1);
        if (this.fx) {
          const fxColors = it.type === 'scrap' ? [0xa0aec0, 0xedf2f7] : it.type === 'wires' ? [0x38bdf8, 0xf59e0b] : [0xc084fc, 0x06b6d4];
          this.fx.burst(it.x, it.y, {
            count: 6, colors: fxColors, speed: [30, 80], spread: Math.PI * 2, life: [0.15, 0.3], size: [1, 2]
          });
        }
        if (this.numbers) {
          // Всплывающее уведомление о подборе
          this.numbers.spawn(it.x, it.y - 10, 1, false, 0);
        }
        it.sprite.destroy();
        this.items.splice(i, 1);
      }
    }
  }

  public clear(): void {
    for (const it of this.items) it.sprite.destroy();
    this.items = [];
  }
}
