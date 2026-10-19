import { Container, Filter, GlProgram, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Level } from './Level.ts';
import { mulberry32 } from './autoDecor.ts';
import { pal } from '../core/Palette.ts';

const MAX_WEBS = 56;

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
 * Процедурная пиксельная паутина, три вида (uKind):
 *  0 — угловой веер: от якоря в углу расходятся 5–7 неровных нитей-спиц разной длины, между ними провисают кольца (дуги прогибаются к якорю);
 *  1 — колесо (орб) на стене: спицы по кругу, нить закручена спиралью, дуги провисают между спицами; рисуется поверх тайлов стены;
 *  2 — свисающая нить с потолка с каплей-росинкой на конце и на середине.
 * У каждого вида часть дуг и края порваны шумом, на пересечениях горят росинки. Нити — один пиксель. Шейдер рисует одну паутину в свою текстуру
 * (запекается один раз при загрузке), качает её игра уже спрайтом.
 */
const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform vec2 uSize;
uniform vec4 uParams; // size, seed, kind, 0
uniform vec3 uColor;
uniform vec3 uGlint;

const float PI = 3.14159265;

float hash(float n) {
  return fract(sin(n * 127.1 + 17.3) * 43758.5453);
}

// угловой веер: q — пиксели от якоря в четверти (x, y >= 0); x — нить, y — росинка
vec2 fan(vec2 q, float size, float seed) {
  float r = length(q);
  if (r > size || r < 1.0) return vec2(0.0);
  float ang = atan(q.y, q.x) / (PI * 0.5);

  int n = 5 + int(hash(seed) * 3.0);
  float spokeD = 99.0;
  float sPrev = 0.0;
  float sNext = 1.0;
  float kPrev = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= n) break;
    float fk = float(k);
    float edgeK = (k == 0 || k == n - 1) ? 1.0 : 0.0;
    float sk = (fk + (1.0 - edgeK) * (hash(seed + fk * 7.1) - 0.5) * 0.55) / float(n - 1);
    float len = size * mix(0.62 + 0.38 * hash(seed + fk * 3.3), 1.0, edgeK);
    if (r < len) spokeD = min(spokeD, abs(ang - sk) * r * PI * 0.5);
    if (sk <= ang && sk >= sPrev) { sPrev = sk; kPrev = fk; }
    if (sk > ang && sk < sNext) sNext = sk;
  }
  float spoke = step(spokeD, 0.6);

  float f = (ang - sPrev) / max(sNext - sPrev, 0.02);
  float segLen = r * (sNext - sPrev) * PI * 0.5;
  float rr = r + 0.2 * segLen * sin(PI * f);
  float step0 = 5.0 + 3.0 * hash(seed + 2.0);
  float j = rr / step0;
  float ringIdx = floor(j + 0.5);
  float ringD = abs(j - ringIdx) * step0;
  float ring = step(ringD, 0.62) * step(2.0, ringIdx);
  ring *= step(0.14, hash(ringIdx * 13.7 + seed + kPrev * 5.1));
  ring *= step(r, size * (0.55 + 0.45 * hash(seed + kPrev * 9.7 + 4.0)));

  float t = max(spoke, ring);
  vec2 cell = floor(q / 3.0);
  float tear = hash(cell.x * 3.1 + cell.y * 17.3 + seed);
  float edge = smoothstep(size * 0.55, size, r);
  if (tear < edge * 0.6) t = 0.0;

  float a = t * (0.95 - 0.5 * r / size);
  float dew = spoke * ring * step(0.55, hash(ringIdx * 3.7 + kPrev * 11.3 + seed));
  return vec2(a, dew);
}

// колесо на стене: q — пиксели от центра
vec2 orb(vec2 q, float size, float seed) {
  float r = length(q);
  if (r > size || r < 2.5) return vec2(0.0);
  float ang = atan(q.y, q.x) / (2.0 * PI) + 0.5; // 0..1 по кругу
  int n = 8 + int(hash(seed) * 4.0);
  float fn = float(n);
  float spokeD = 99.0;
  float segF = 0.0;
  float kk = 0.0;
  for (int k = 0; k < 11; k++) {
    if (k >= n) break;
    float fk = float(k);
    float sk = (fk + (hash(seed + fk * 5.3) - 0.5) * 0.5) / fn;
    float len = size * (0.72 + 0.28 * hash(seed + fk * 2.9));
    float dA = abs(ang - sk);
    dA = min(dA, 1.0 - dA);
    if (r < len) spokeD = min(spokeD, dA * r * 2.0 * PI);
  }
  float spoke = step(spokeD, 0.6);
  // положение между спицами для провисания дуг
  float u = fract(ang * fn);
  float segLen = r * 2.0 * PI / fn;
  float rr = r + 0.17 * segLen * sin(PI * u);
  float stp = 4.5 + 1.5 * hash(seed + 1.0);
  float j = (rr + ang * stp * 0.9) / stp; // спираль
  float ringIdx = floor(j + 0.5);
  float ringD = abs(j - ringIdx) * stp;
  float ring = step(ringD, 0.62) * step(1.0, ringIdx);
  ring *= step(0.12, hash(ringIdx * 11.1 + floor(ang * fn) * 3.7 + seed));
  float t = max(spoke, ring);
  vec2 cell = floor(q / 3.0);
  float tear = hash(cell.x * 3.1 + cell.y * 17.3 + seed);
  if (tear < smoothstep(size * 0.6, size, r) * 0.65) t = 0.0;
  float a = t * (0.95 - 0.4 * r / size);
  float dew = spoke * ring * step(0.6, hash(ringIdx * 3.1 + floor(ang * fn) * 7.7 + seed));
  return vec2(a, dew);
}

// свисающая нить: p — пиксели от верха (x от левого края текстуры шириной 10)
vec2 strand(vec2 p, float len, float seed) {
  float x = 5.0 + sin(p.y * 0.17 + seed) * 1.1;
  float onLine = step(abs(p.x - x), 0.62) * step(p.y, len) * step(0.0, p.y);
  float beadY = len - 1.0;
  float midY = len * (0.35 + 0.3 * hash(seed + 3.0));
  float d1 = length(vec2(p.x - x, p.y - beadY));
  float d2 = length(vec2(p.x - x, p.y - midY));
  float bead = max(step(d1, 1.9), step(d2, 1.3) * step(0.4, hash(seed + 8.0)));
  float a = onLine * (0.9 - 0.4 * p.y / len);
  return vec2(max(a, bead), bead);
}

void main(void) {
  vec2 uv01 = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
  vec2 p = floor(uv01 * uSize) + 0.5;
  vec2 r = vec2(0.0);
  if (uParams.z < 0.5) r = fan(p, uParams.x, uParams.y);
  else if (uParams.z < 1.5) r = orb(p - uSize * 0.5, uParams.x, uParams.y);
  else r = strand(p, uParams.x, uParams.y);
  vec3 col = mix(uColor, uGlint, r.y);
  float a = max(r.x * 0.8, r.y * 0.85);
  finalColor = vec4(col * a, a);
}
`;

export type WebKind = 'fan' | 'orb' | 'strand';

export interface Web {
  kind: WebKind;
  x: number; // fan: якорь в углу; orb: центр колеса; strand: точка на потолке (px мира)
  y: number;
  sx: 1 | -1; // fan: куда от якоря расходится веер по x и по y
  sy: 1 | -1;
  size: number; // fan, orb: радиус; strand: длина
  seed: number;
}

/**
 * Где висит паутина: угловые веера (потолочные чаще и крупнее), «подвесные» веера из двух половин под ровным потолком, колёса на стенах
 * (поверх тайлов стены) и свисающие с потолка нити с росинками.
 */
export function findWebs(level: Level, density = 1): Web[] {
  const rand = mulberry32(level.widthTiles * 131 + level.heightTiles * 7 + 5);
  const ts = level.tileSize;
  const W = level.widthTiles;
  const H = level.heightTiles;
  const solid = (x: number, y: number) => level.isSolid(x, y);
  const webs: Web[] = [];
  const far = (x: number, y: number, d: number) => !webs.some((w) => Math.hypot(w.x - x, w.y - y) < d);

  for (let cy = 1; cy < H - 1; cy++) {
    for (let cx = 1; cx < W - 1; cx++) {
      if (solid(cx, cy)) continue;
      const up = solid(cx, cy - 1);
      const down = solid(cx, cy + 1);
      const left = solid(cx - 1, cy);
      const right = solid(cx + 1, cy);
      const cand: Array<{ sx: 1 | -1; sy: 1 | -1; ax: number; ay: number; p: number }> = [];
      if (up && left && !right && !down) cand.push({ sx: 1, sy: 1, ax: cx * ts, ay: cy * ts, p: 0.9 });
      if (up && right && !left && !down) cand.push({ sx: -1, sy: 1, ax: (cx + 1) * ts, ay: cy * ts, p: 0.9 });
      if (down && left && !right && !up) cand.push({ sx: 1, sy: -1, ax: cx * ts, ay: (cy + 1) * ts, p: 0.45 });
      if (down && right && !left && !up) cand.push({ sx: -1, sy: -1, ax: (cx + 1) * ts, ay: (cy + 1) * ts, p: 0.45 });
      for (const c of cand) {
        if (rand() > c.p * density) continue;
        let runX = 0;
        while (runX < 3 && !solid(cx + c.sx * (runX + 1), cy) && solid(cx + c.sx * (runX + 1), cy + c.sy * -1)) runX++;
        let runY = 0;
        while (runY < 3 && !solid(cx, cy + c.sy * (runY + 1)) && solid(cx + c.sx * -1, cy + c.sy * (runY + 1))) runY++;
        const room = Math.min(runX, runY) + 1;
        const size = Math.min(78, (20 + room * ts * 0.62) * (0.8 + 0.4 * rand()));
        if (!far(c.ax, c.ay, 56)) continue;
        webs.push({ kind: 'fan', x: c.ax, y: c.ay, sx: c.sx, sy: c.sy, size, seed: 1 + Math.floor(rand() * 900) });
      }
    }
  }
  const corners = webs.length;

  // под ровным потолком — подвесной веер из двух половинок; рядом иногда свисают нити
  const extra: Web[] = [];
  const far2 = (x: number, y: number, d: number) => ![...webs, ...extra].some((w) => Math.hypot(w.x - x, w.y - y) < d);
  for (let cy = 1; cy < H - 1; cy++) {
    for (let cx = 3; cx < W - 3; cx++) {
      if (solid(cx, cy) || !solid(cx, cy - 1) || solid(cx, cy + 1) || solid(cx, cy + 2)) continue;
      let flat = true;
      for (let k = -2; k <= 2; k++) if (solid(cx + k, cy) || !solid(cx + k, cy - 1)) flat = false;
      if (!flat) continue;
      const ax = cx * ts + ts / 2;
      const ay = cy * ts;
      if (rand() < 0.12 * density && far2(ax, ay, 96)) {
        const size = 30 + 22 * rand();
        const seed = 1 + Math.floor(rand() * 900);
        extra.push({ kind: 'fan', x: ax, y: ay, sx: 1, sy: 1, size, seed }, { kind: 'fan', x: ax, y: ay, sx: -1, sy: 1, size, seed: seed + 3 });
      } else if (rand() < 0.1 * density && far2(ax, ay, 40)) {
        extra.push({ kind: 'strand', x: ax + (rand() - 0.5) * 16, y: ay, sx: 1, sy: 1, size: 26 + 50 * rand(), seed: 1 + Math.floor(rand() * 900) });
      }
    }
  }

  // колёса на стенах: у ровной стены (три клетки подряд), центр чуть внутри стены — паутина лежит на тайлах и свисает в воздух
  const walls: Web[] = [];
  for (let cy = 2; cy < H - 2; cy++) {
    for (let cx = 1; cx < W - 1; cx++) {
      if (solid(cx, cy)) continue;
      for (const side of [-1, 1] as const) {
        if (!solid(cx + side, cy) || solid(cx - side, cy)) continue;
        let flat = true;
        for (let k = -1; k <= 1; k++) if (!solid(cx + side, cy + k) || solid(cx, cy + k)) flat = false;
        if (!flat || rand() > 0.3 * density) continue;
        const fx = (side === 1 ? cx + 1 : cx) * ts; // грань стены
        const px = fx + side * 7;
        const py = cy * ts + ts / 2 + (rand() - 0.5) * 12;
        if (![...webs, ...extra, ...walls].some((w) => Math.hypot(w.x - px, w.y - py) < 76)) {
          walls.push({ kind: 'orb', x: px, y: py, sx: 1, sy: 1, size: 20 + 14 * rand(), seed: 1 + Math.floor(rand() * 900) });
        }
      }
    }
  }
  void corners;
  return [...webs.sort((a, b) => b.size - a.size), ...extra, ...walls].slice(0, MAX_WEBS);
}

interface Sway {
  sprite: Sprite;
  base: Web;
  phase: number;
  speed: number;
  amp: number;
  kick: number; // толчок от героя, затухает
  kickV: number;
}

/**
 * Паутина уровня: каждая запечена шейдером в свою маленькую текстуру и стоит спрайтом. Спрайты чуть покачиваются на сквозняке (поворот и перекос вокруг якоря,
 * веера и нити — от угла или потолка, колёса — вокруг центра), а когда герой проходит сквозь паутину, она качается сильнее и успокаивается.
 */
export class CobwebLayer {
  public readonly container = new Container();
  private readonly items: Sway[] = [];
  private time = Math.random() * 10;

  constructor(renderer: Renderer, level: Level, tint?: number, density = 1) {
    const webs = findWebs(level, density);
    const rgb = (c: number) => new Float32Array([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);
    // нити тёмные, холодные; у уровней с цветным светом чуть подкрашены им; росинки светлее
    let base = pal('steel', 2);
    if (tint !== undefined) {
      const mix = (a: number, b: number) => Math.round(a * 0.7 + b * 0.3);
      base = (mix((base >> 16) & 255, (tint >> 16) & 255) << 16) | (mix((base >> 8) & 255, (tint >> 8) & 255) << 8) | mix(base & 255, tint & 255);
    }
    const filter = new Filter({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'cobweb' }),
      resources: {
        u: {
          uSize: { value: new Float32Array([32, 32]), type: 'vec2<f32>' },
          uParams: { value: new Float32Array([32, 1, 0, 0]), type: 'vec4<f32>' },
          uColor: { value: rgb(base), type: 'vec3<f32>' },
          uGlint: { value: rgb(pal('steel', 5)), type: 'vec3<f32>' }
        }
      }
    });
    const quad = new Sprite(Texture.WHITE);
    quad.filters = [filter];
    const u = filter.resources.u.uniforms;
    for (const w of webs) {
      const kind = w.kind === 'fan' ? 0 : w.kind === 'orb' ? 1 : 2;
      const tw = kind === 0 ? Math.ceil(w.size) + 2 : kind === 1 ? Math.ceil(w.size * 2) + 4 : 10;
      const th = kind === 0 ? tw : kind === 1 ? tw : Math.ceil(w.size) + 6;
      u.uSize = new Float32Array([tw, th]);
      u.uParams = new Float32Array([w.size, w.seed, kind, 0]);
      quad.width = tw;
      quad.height = th;
      const rt = RenderTexture.create({ width: tw, height: th, resolution: 1 });
      rt.source.scaleMode = 'nearest';
      renderer.render({ container: quad, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
      const sprite = new Sprite(rt);
      if (kind === 0) {
        sprite.pivot.set(0, 0);
        sprite.position.set(w.x, w.y);
        sprite.scale.set(w.sx, w.sy);
      } else if (kind === 1) {
        sprite.pivot.set(tw / 2, th / 2);
        sprite.position.set(w.x, w.y);
      } else {
        sprite.pivot.set(5, 0);
        sprite.position.set(w.x, w.y);
      }
      this.container.addChild(sprite);
      this.items.push({
        sprite, base: w, phase: Math.random() * Math.PI * 2, speed: 0.7 + Math.random() * 0.8,
        amp: (kind === 2 ? 0.06 : kind === 1 ? 0.025 : 0.035) * (0.7 + Math.random() * 0.6), kick: 0, kickV: 0
      });
    }
    filter.destroy();
    quad.destroy();
  }

  public get count(): number {
    return this.items.length;
  }

  /** Качание: сквозняк (общий порыв + свой ритм у каждой) и толчок, когда герой (прямоугольник мира) проходит сквозь паутину. */
  public update(dt: number, hero?: { left: number; right: number; top: number; bottom: number; vx: number }): void {
    this.time += dt;
    const gust = 0.6 + 0.4 * Math.sin(this.time * 0.37);
    for (const it of this.items) {
      const w = it.base;
      if (hero) {
        const half = w.kind === 'orb' ? w.size : w.size * 0.7;
        const cx = w.kind === 'fan' ? w.x + w.sx * half * 0.6 : w.x;
        const cy = w.kind === 'fan' ? w.y + w.sy * half * 0.6 : w.kind === 'strand' ? w.y + w.size / 2 : w.y;
        if (hero.right > cx - half && hero.left < cx + half && hero.bottom > cy - half && hero.top < cy + half && Math.abs(hero.vx) > 20) {
          it.kickV += Math.sign(hero.vx) * 0.5 * dt * 6;
        }
      }
      // пружина толчка: возвращается к нулю с затуханием
      it.kickV += -it.kick * 60 * dt;
      it.kickV *= Math.exp(-3.2 * dt);
      it.kick += it.kickV * dt * 10;
      it.kick = Math.max(-0.35, Math.min(0.35, it.kick));
      const sway = Math.sin(this.time * it.speed + it.phase) * it.amp * gust + it.kick;
      const s = it.sprite;
      if (w.kind === 'fan') {
        // качается вокруг угла: поворот и лёгкий перекос; веер не отрывается от стен
        s.rotation = sway * 0.6 * w.sx * w.sy;
        s.skew.x = sway * 0.5 * w.sx * w.sy;
      } else if (w.kind === 'orb') {
        s.rotation = sway * 0.5;
        s.scale.set(1 + sway * 0.08, 1 - sway * 0.08);
      } else {
        s.rotation = sway;
      }
    }
  }
}
