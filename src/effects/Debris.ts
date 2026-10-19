import { Container, Sprite, type Texture } from 'pixi.js';
import type { Level } from '../world/Level.ts';

/** Часть, которая отвалилась от героя при смене брони. */
export interface PieceSnapshot {
  texture: Texture;
  x: number; // положение точки привязки части в мире
  y: number;
  rotation: number;
  flip: 1 | -1;
  pivot: { x: number; y: number };
}

interface Piece {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  vr: number;
  age: number;
  rest: boolean;
}

const GRAVITY = 720;
const BOUNCE = 0.38;
const FRICTION = 0.72;
const RADIUS = 7; // px: на таком расстоянии от точки привязки обломок касается пола
const FADE = 1.2; // с: затухание в конце жизни

/**
 * Отвалившиеся части брони: физические обломки — падают, подпрыгивают на тайлах, крутятся и катятся, лежат и со временем гаснут (life секунд).
 */
export class Debris {
  public readonly container = new Container();
  private pieces: Piece[] = [];

  /** Отвалить части: разлетаются в стороны и вверх (dirX — откуда «сорвало»: обломки уходят от него). */
  public spawn(snaps: PieceSnapshot[], dirX: number): void {
    for (const s of snaps) {
      const sprite = new Sprite(s.texture);
      sprite.pivot.set(s.pivot.x, s.pivot.y);
      sprite.position.set(s.x, s.y);
      sprite.scale.x = s.flip;
      sprite.rotation = s.rotation;
      this.container.addChild(sprite);
      this.pieces.push({
        sprite, x: s.x, y: s.y,
        vx: dirX * (40 + Math.random() * 70) + (Math.random() * 2 - 1) * 50,
        vy: -(110 + Math.random() * 110),
        vr: (Math.random() * 2 - 1) * 9,
        age: 0, rest: false
      });
    }
  }

  public update(dt: number, level: Level, life: number): void {
    const ts = level.tileSize;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      if (p.age >= life) {
        p.sprite.destroy();
        this.pieces.splice(i, 1);
        continue;
      }
      if (p.age > life - FADE) p.sprite.alpha = Math.max(0, (life - p.age) / FADE);
      if (!p.rest) {
        p.vy += GRAVITY * dt;
        let nx = p.x + p.vx * dt;
        let ny = p.y + p.vy * dt;
        // пол: нижняя точка обломка
        if (level.isSolid(Math.floor(nx / ts), Math.floor((ny + RADIUS) / ts))) {
          const floorY = Math.floor((ny + RADIUS) / ts) * ts - RADIUS;
          ny = floorY;
          if (Math.abs(p.vy) < 60) {
            p.vy = 0;
            p.vx *= FRICTION;
            p.vr *= FRICTION;
            if (Math.abs(p.vx) < 6) { p.vx = 0; p.vr = 0; p.rest = true; }
          } else {
            p.vy = -p.vy * BOUNCE;
            p.vx *= FRICTION;
            p.vr *= -0.5;
          }
        }
        // потолок и стены
        if (level.isSolid(Math.floor(nx / ts), Math.floor((ny - RADIUS) / ts))) { p.vy = Math.abs(p.vy) * 0.3; ny = p.y; }
        if (level.isSolid(Math.floor((nx + Math.sign(p.vx) * RADIUS) / ts), Math.floor(ny / ts))) { p.vx = -p.vx * 0.4; nx = p.x; }
        p.x = nx;
        p.y = ny;
        p.sprite.rotation += p.vr * dt;
        p.sprite.position.set(p.x, p.y);
      }
    }
  }

  public clear(): void {
    for (const p of this.pieces) p.sprite.destroy();
    this.pieces = [];
  }
}
