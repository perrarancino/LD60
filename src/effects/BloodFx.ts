import { Container, Filter, GlProgram, Graphics, Sprite, Texture } from 'pixi.js';
import type { Level } from '../world/Level.ts';
import { RAMPS } from '../core/Palette.ts';
import type { Ramp } from '../core/Palette.ts';

const VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

/**
 * Всплеск крови: 20 метаболлов из центра по баллистике (гравитация), сливаются в сгустки и тают; поле считается один раз на пиксель
 * (дешёво: один квадрат 128x128 на смерть), рисуется по пикселю мира в три тона — тёмный, красный, блик.
 */
const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize; // как в вершинном шейдере (highp — иначе программа не линкуется)
uniform highp vec4 uOutputFrame;
uniform float uTime;
uniform float uSeed;
uniform float uPower;
uniform vec2 uDir;
uniform vec3 uDark;
uniform vec3 uMid;
uniform vec3 uLight;

float hash(float n) {
  return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453);
}

void main(void) {
  // входная текстура фильтра может быть больше квадрата (степень двойки): приводим координату к 0..1 по самому квадрату
  vec2 uv01 = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
  vec2 p = (uv01 - 0.5) * 128.0; // пиксели мира от центра квадрата 128x128
  p = floor(p) + 0.5; // пиксель мира
  float t = uTime;
  float field = 0.0;
  for (int i = 0; i < 20; i++) {
    float fi = float(i);
    float a = hash(fi) * 6.2831853;
    float sp = (22.0 + hash(fi + 17.0) * 60.0) * uPower;
    vec2 v = vec2(cos(a), sin(a)) * sp + uDir * 38.0 * uPower;
    vec2 pos = v * t + vec2(0.0, 150.0 * t * t);
    float r = (1.2 + hash(fi + 5.0) * 2.6 * uPower) * max(0.0, 1.0 - t * 1.25);
    vec2 d = p - pos;
    field += (r * r) / (dot(d, d) + 1.0);
  }
  float core = max(0.0, 6.0 * uPower * (1.0 - t * 3.5));
  field += (core * core) / (dot(p, p) + 1.0);

  float edge = step(0.95, field);
  // свечение: кровь цвета врага горит — яркая середина и блик (больше единицы), мягкий ореол вокруг сгустков
  vec3 col = mix(uDark, uMid * 1.25, step(1.3, field));
  col = mix(col, uLight * 1.45, step(2.6, field) * 0.9);
  float halo = smoothstep(0.3, 0.95, field) * 0.55;
  float life = 1.0 - smoothstep(0.55, 0.95, t);
  float a = max(edge, halo) * life;
  vec3 rgb = edge > 0.5 ? col : uLight;
  finalColor = vec4(rgb * a, a);
}
`;

const SPLASH_SIZE = 128; // px мира: квадрат всплеска
const SPLASH_TIME = 0.8; // с
const POOL = 12; // сколько всплесков одновременно
const GRAVITY = 560; // px/с²: капли
const CHUNK = 256; // px: кусок слоя пятен (обновляется по отдельности — дёшево)
const hex6 = (c: number) => '#' + c.toString(16).padStart(6, '0');
const rgb = (c: number): Float32Array => new Float32Array([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);

interface Splash {
  sprite: Sprite;
  filter: Filter;
  age: number;
  active: boolean;
  ramp: Ramp;
  power: number;
}

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: number;
  ramp: Ramp;
}

interface Chunk {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
  sprite: Sprite;
  glowCtx: CanvasRenderingContext2D; // ореол пятен: рисуется аддитивно — пятна светятся в темноте
  glowTexture: Texture;
  glowSprite: Sprite;
  dirty: boolean;
}

/**
 * Кровь. На гибель врага каждая его часть взрывается всплеском (шейдер), летят капли с физикой; капля, коснувшись тайла, оставляет пятно на этой поверхности —
 * на полу, стене или потолке. Пятна остаются до конца уровня: они рисуются в слой из кусков-холстов 256x256 по пикселю, обновляется только тот кусок,
 * где добавилось пятно, поэтому сколько бы ни было крови, кадр почти не дорожает.
 */
export class BloodFx {
  /** Слой пятен: ставится в мир над тайлами. */
  public readonly stains = new Container();
  /** Всплески и летящие капли: ставятся в мир поверх существ. */
  public readonly container = new Container();

  private readonly splashes: Splash[] = [];
  private readonly drops: Drop[] = [];
  private readonly dropGfx = new Graphics();
  private readonly chunks = new Map<number, Chunk>();
  private time = 0;
  private readonly program = GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'blood-splash' });

  constructor(private readonly level: Level) {
    this.container.addChild(this.dropGfx);
    for (let i = 0; i < POOL; i++) {
      const sprite = new Sprite(Texture.WHITE);
      sprite.width = SPLASH_SIZE;
      sprite.height = SPLASH_SIZE;
      sprite.visible = false;
      const filter = new Filter({
        glProgram: this.program,
        resources: {
          u: {
            uTime: { value: 0, type: 'f32' },
            uSeed: { value: 0, type: 'f32' },
            uPower: { value: 1, type: 'f32' },
            uDir: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
            uDark: { value: rgb(RAMPS.ember[2]), type: 'vec3<f32>' },
            uMid: { value: rgb(RAMPS.ember[4]), type: 'vec3<f32>' },
            uLight: { value: rgb(RAMPS.ember[6]), type: 'vec3<f32>' }
          }
        }
      });
      sprite.filters = [filter];
      this.container.addChild(sprite);
      this.splashes.push({ sprite, filter, age: 0, active: false, ramp: 'ember', power: 1 });
    }
  }

  /** Взрыв крови в точке (мир): power — размер (0.4 мелкий … 1.6 крупный), dirX/dirY — куда бил удар (капли чуть летят туда). */
  public burst(x: number, y: number, power = 1, dirX = 0, dirY = 0, ramp: Ramp = 'ember'): void {
    const sp = this.splashes.find((s) => !s.active) ?? this.splashes.reduce((a, b) => (a.age > b.age ? a : b));
    sp.active = true;
    sp.age = 0;
    sp.sprite.position.set(Math.round(x) - SPLASH_SIZE / 2, Math.round(y) - SPLASH_SIZE / 2); // левый верхний угол квадрата (с anchor фильтр смещался)
    sp.sprite.visible = true;
    const u = sp.filter.resources.u.uniforms;
    u.uSeed = Math.random() * 100;
    u.uPower = Math.max(0.3, Math.min(1.8, power));
    u.uDir = new Float32Array([dirX, dirY]);
    u.uTime = 0;
    u.uDark = rgb(RAMPS[ramp][2]);
    u.uMid = rgb(RAMPS[ramp][4]);
    u.uLight = rgb(RAMPS[ramp][6]);
    sp.ramp = ramp;
    sp.power = power;

    const n = Math.min(34, Math.round(8 + 14 * power));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (40 + Math.random() * 190) * Math.sqrt(power);
      this.drops.push({
        x, y,
        vx: Math.cos(a) * v + dirX * 60,
        vy: Math.sin(a) * v - 50 + dirY * 40,
        life: 1.6,
        size: Math.random() < 0.3 ? 2 : 1,
        color: RAMPS[ramp][4 + Math.floor(Math.random() * 3)],
        ramp
      });
    }
    // лужа под телом: если пол близко — сразу пятно на нём
    const floor = this.floorBelow(x, y, 26);
    if (floor !== null) this.stamp(x, floor, 0, -1, 4 + Math.round(power * 5), ramp);
  }

  /** Расстояние до пола под точкой: y пола (верхняя грань тайла) или null. */
  private floorBelow(x: number, y: number, maxDist: number): number | null {
    const ts = this.level.tileSize;
    const cx = Math.floor(x / ts);
    for (let d = 0; d <= maxDist; d += 2) {
      if (this.level.isSolid(cx, Math.floor((y + d) / ts))) return Math.floor((y + d) / ts) * ts;
    }
    return null;
  }

  public update(dt: number): void {
    for (const s of this.splashes) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= SPLASH_TIME) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      s.filter.resources.u.uniforms.uTime = s.age;
    }
    this.updateDrops(dt);
    for (const c of this.chunks.values()) {
      if (!c.dirty) continue;
      c.dirty = false;
      c.texture.source.update();
      c.glowTexture.source.update();
    }
    this.time += dt;
    const pulse = 0.78 + 0.22 * Math.sin(this.time * 2.2); // ореол пятен лениво пульсирует
    for (const c of this.chunks.values()) c.glowSprite.alpha = pulse;
  }

  /** Свет от свежей крови: короткие вспышки цвета крови вокруг всплесков (для освещения игры). */
  public lights(): { x: number; y: number; r: number; i: number; c: [number, number, number] }[] {
    const out: { x: number; y: number; r: number; i: number; c: [number, number, number] }[] = [];
    for (const s of this.splashes) {
      if (!s.active) continue;
      const k = 1 - s.age / SPLASH_TIME;
      const col = RAMPS[s.ramp][6];
      out.push({ x: s.sprite.x + SPLASH_SIZE / 2, y: s.sprite.y + SPLASH_SIZE / 2, r: 60 + 50 * s.power, i: 0.9 * k * k, c: [((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255] });
    }
    return out;
  }

  private updateDrops(dt: number): void {
    const ts = this.level.tileSize;
    const g = this.dropGfx;
    g.clear();
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.drops.splice(i, 1);
        continue;
      }
      d.vy += GRAVITY * dt;
      const steps = Math.max(1, Math.ceil((Math.hypot(d.vx, d.vy) * dt) / 2));
      const sx = (d.vx * dt) / steps;
      const sy = (d.vy * dt) / steps;
      let landed = false;
      for (let k = 0; k < steps; k++) {
        if (this.level.isSolid(Math.floor((d.x + sx) / ts), Math.floor(d.y / ts))) {
          this.stamp(d.x, d.y, -Math.sign(sx) || 1, 0, 1 + Math.floor(Math.random() * 3), d.ramp); // стена
          landed = true;
          break;
        }
        d.x += sx;
        if (this.level.isSolid(Math.floor(d.x / ts), Math.floor((d.y + sy) / ts))) {
          this.stamp(d.x, d.y, 0, -Math.sign(sy) || -1, 1 + Math.floor(Math.random() * 4), d.ramp); // пол или потолок
          landed = true;
          break;
        }
        d.y += sy;
      }
      if (landed) {
        this.drops.splice(i, 1);
        continue;
      }
      g.rect(Math.round(d.x), Math.round(d.y), d.size, d.size).fill({ color: d.color });
    }
  }

  /** Пятно на поверхности: (x, y) — свободная точка у самой поверхности, (nx, ny) — нормаль от неё, len — половина длины пятна. */
  private stamp(x: number, y: number, nx: number, ny: number, len: number, ramp: Ramp): void {
    const tx = -ny;
    const ty = nx;
    const thick = Math.max(1, Math.round(len * 0.4));
    // точку прижимаем к поверхности: от (x, y) против нормали, пока не упрёмся в твёрдое
    const ts = this.level.tileSize;
    let sx = x;
    let sy = y;
    for (let i = 0; i < 4; i++) {
      if (this.level.isSolid(Math.floor((sx - nx) / ts), Math.floor((sy - ny) / ts))) break;
      sx -= nx;
      sy -= ny;
    }
    for (let i = -len; i <= len; i++) {
      const h = Math.max(1, Math.round(thick * (1 - Math.abs(i) / (len + 1)) + (Math.random() - 0.3)));
      for (let k = -1; k < h; k++) {
        // k = -1 — пиксель внутри поверхности (кровь «въедается» в край тайла)
        this.px(Math.floor(sx + tx * i + nx * k), Math.floor(sy + ty * i + ny * k), RAMPS[ramp][2 + Math.floor(Math.random() * 4)]);
      }
    }
  }

  private px(x: number, y: number, rgbColor: number): void {
    const color = hex6(rgbColor);
    if (x < 0 || y < 0 || x >= this.level.pixelWidth || y >= this.level.pixelHeight) return;
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    const key = cy * 1000 + cx;
    let c = this.chunks.get(key);
    if (!c) {
      const canvas = document.createElement('canvas');
      canvas.width = CHUNK;
      canvas.height = CHUNK;
      const texture = Texture.from(canvas);
      texture.source.scaleMode = 'nearest';
      const sprite = new Sprite(texture);
      sprite.position.set(cx * CHUNK, cy * CHUNK);
      this.stains.addChild(sprite);
      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = CHUNK;
      glowCanvas.height = CHUNK;
      const glowTexture = Texture.from(glowCanvas);
      glowTexture.source.scaleMode = 'nearest';
      const glowSprite = new Sprite(glowTexture);
      glowSprite.position.set(cx * CHUNK, cy * CHUNK);
      glowSprite.blendMode = 'add';
      this.stains.addChild(glowSprite);
      c = { canvas, ctx: canvas.getContext('2d')!, texture, sprite, glowCtx: glowCanvas.getContext('2d')!, glowTexture, glowSprite, dirty: false };
      this.chunks.set(key, c);
    }
    c.ctx.fillStyle = color;
    c.ctx.fillRect(x - cx * CHUNK, y - cy * CHUNK, 1, 1);
    c.glowCtx.globalAlpha = 0.16;
    c.glowCtx.fillStyle = color;
    c.glowCtx.fillRect(x - cx * CHUNK - 1, y - cy * CHUNK - 1, 3, 3); // ореол в клетку вокруг пикселя
    c.glowCtx.globalAlpha = 0.5;
    c.glowCtx.fillRect(x - cx * CHUNK, y - cy * CHUNK, 1, 1);
    c.dirty = true;
  }
}
