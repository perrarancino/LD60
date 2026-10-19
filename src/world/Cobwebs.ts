import { Filter, GlProgram, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Level } from './Level.ts';
import { mulberry32 } from './autoDecor.ts';
import { pal } from '../core/Palette.ts';

const MAX_WEBS = 48;
const MAX_TEX = 4096; // px: больше холст не делаем (уровни рогалика гораздо меньше)

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
 * Процедурная паутина в углах. Каждая паутина — угловой веер: от якоря в углу расходятся нити-«спицы» (5–7, неровно, разной длины), между ними провисают
 * кольца (дуги прогибаются к якорю), часть колец и концов нитей порвана шумом, на пересечениях горят росинки. Всё считается на пиксель мира
 * (нити в один пиксель, как у остального арта). Шейдер перебирает все паутины уровня (до 48) и запекается один раз в текстуру на весь уровень.
 */
const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform vec2 uSize;
uniform vec4 uWebA[${MAX_WEBS}];
uniform vec2 uWebD[${MAX_WEBS}];
uniform int uCount;
uniform vec3 uColor;
uniform vec3 uGlint;

float hash(float n) {
  return fract(sin(n * 127.1 + 17.3) * 43758.5453);
}

// нить паутины в точке q (локальные пиксели в четверти: x, y >= 0 от якоря); x — сама нить 0..1, y — росинка 0..1
vec2 web(vec2 q, float size, float seed) {
  float r = length(q);
  if (r > size || r < 1.0) return vec2(0.0);
  float ang = atan(q.y, q.x) / 1.5707963; // 0..1 от одной стенки к другой

  int n = 5 + int(hash(seed) * 3.0); // спиц
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
    if (r < len) spokeD = min(spokeD, abs(ang - sk) * r * 1.5707963);
    if (sk <= ang && sk >= sPrev) { sPrev = sk; kPrev = fk; }
    if (sk > ang && sk < sNext) sNext = sk;
  }
  float spoke = step(spokeD, 0.6);

  // кольца: между спицами дуга провисает к якорю
  float f = (ang - sPrev) / max(sNext - sPrev, 0.02);
  float segLen = r * (sNext - sPrev) * 1.5707963;
  float rr = r + 0.2 * segLen * sin(3.14159265 * f);
  float step0 = 5.0 + 3.0 * hash(seed + 2.0);
  float j = rr / step0;
  float ringIdx = floor(j + 0.5);
  float ringD = abs(j - ringIdx) * step0;
  float ring = step(ringD, 0.62) * step(2.0, ringIdx);
  ring *= step(0.14, hash(ringIdx * 13.7 + seed + kPrev * 5.1)); // часть дуг порвана
  ring *= step(r, size * (0.55 + 0.45 * hash(seed + kPrev * 9.7 + 4.0)));

  float t = max(spoke, ring);
  // рваные края у внешней границы
  vec2 cell = floor(q / 3.0);
  float tear = hash(cell.x * 3.1 + cell.y * 17.3 + seed);
  float edge = smoothstep(size * 0.55, size, r);
  if (tear < edge * 0.6) t = 0.0;

  float a = t * (0.95 - 0.5 * r / size);
  // росинки на пересечениях спиц и колец
  float dew = spoke * ring * step(0.55, hash(ringIdx * 3.7 + kPrev * 11.3 + seed));
  return vec2(a, dew);
}

void main(void) {
  vec2 uv01 = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
  vec2 p = floor(uv01 * uSize) + 0.5; // пиксель мира
  float a = 0.0;
  float dew = 0.0;
  for (int i = 0; i < ${MAX_WEBS}; i++) {
    if (i >= uCount) break;
    vec4 w = uWebA[i];
    vec2 d = uWebD[i];
    vec2 q = vec2((p.x - w.x) * d.x, (p.y - w.y) * d.y);
    if (q.x < 0.0 || q.y < 0.0 || q.x > w.z || q.y > w.z) continue;
    vec2 r = web(q, w.z, w.w);
    a = max(a, r.x);
    dew = max(dew, r.y);
  }
  vec3 col = mix(uColor, uGlint, dew);
  a = max(a, dew * 0.9);
  finalColor = vec4(col * a, a);
}
`;

export interface Web {
  x: number; // якорь, px мира
  y: number;
  sx: 1 | -1; // куда от якоря расходится веер по x и по y
  sy: 1 | -1;
  size: number; // радиус веера, px
  seed: number;
}

/** Углы уровня: воздух, у которого с двух перпендикулярных сторон твёрдое; потолочные чаще и крупнее, у пола меньше. */
export function findWebs(level: Level, density = 1): Web[] {
  const rand = mulberry32(level.widthTiles * 131 + level.heightTiles * 7 + 5);
  const ts = level.tileSize;
  const W = level.widthTiles;
  const H = level.heightTiles;
  const solid = (x: number, y: number) => level.isSolid(x, y);
  const webs: Web[] = [];
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
        // сколько клеток свободно вдоль обеих стенок угла — по ним размер веера
        let runX = 0;
        while (runX < 3 && !solid(cx + c.sx * (runX + 1), cy) && solid(cx + c.sx * (runX + 1), cy + c.sy * -1)) runX++;
        let runY = 0;
        while (runY < 3 && !solid(cx, cy + c.sy * (runY + 1)) && solid(cx + c.sx * -1, cy + c.sy * (runY + 1))) runY++;
        const room = Math.min(runX, runY) + 1;
        const size = Math.min(78, (20 + room * ts * 0.62) * (0.8 + 0.4 * rand()));
        if (webs.some((w) => Math.hypot(w.x - c.ax, w.y - c.ay) < 56)) continue;
        webs.push({ x: c.ax, y: c.ay, sx: c.sx, sy: c.sy, size, seed: 1 + Math.floor(rand() * 900) });
      }
    }
  }
  // под ровным потолком и низом платформ — «подвесные» паутины: две половинки веера от одной точки на потолке (получается широкий веер вниз)
  const ceiling: Web[] = [];
  for (let cy = 1; cy < H - 1; cy++) {
    for (let cx = 3; cx < W - 3; cx++) {
      if (solid(cx, cy) || !solid(cx, cy - 1) || solid(cx, cy + 1) || solid(cx, cy + 2)) continue;
      let flat = true;
      for (let k = -2; k <= 2; k++) if (solid(cx + k, cy) || !solid(cx + k, cy - 1)) flat = false;
      if (!flat || rand() > 0.12 * density) continue;
      const ax = cx * ts + ts / 2;
      const ay = cy * ts;
      if ([...webs, ...ceiling].some((w) => Math.hypot(w.x - ax, w.y - ay) < 96)) continue;
      const size = 30 + 22 * rand();
      const seed = 1 + Math.floor(rand() * 900);
      ceiling.push({ x: ax, y: ay, sx: 1, sy: 1, size, seed }, { x: ax, y: ay, sx: -1, sy: 1, size, seed: seed + 3 });
    }
  }
  return [...webs.sort((a, b) => b.size - a.size), ...ceiling].slice(0, MAX_WEBS);
}

/**
 * Запекает паутину уровня в текстуру (один раз при загрузке) и возвращает спрайт на весь уровень — кладётся в мир над тайлами. tint — цвет паутины
 * (по умолчанию холодный белый из палитры). null — паутины нет (мало углов или уровень слишком велик для текстуры).
 */
export function buildCobwebs(renderer: Renderer, level: Level, tint?: number, density = 1): Sprite | null {
  const W = Math.ceil(level.pixelWidth);
  const H = Math.ceil(level.pixelHeight);
  if (W > MAX_TEX || H > MAX_TEX) return null;
  const webs = findWebs(level, density);
  if (webs.length === 0) return null;

  const a = new Float32Array(MAX_WEBS * 4);
  const d = new Float32Array(MAX_WEBS * 2);
  webs.forEach((w, i) => {
    a.set([w.x, w.y, w.size, w.seed], i * 4);
    d.set([w.sx, w.sy], i * 2);
  });
  const rgb = (c: number) => new Float32Array([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);
  const base = tint ?? pal('steel', 6);
  const filter = new Filter({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'cobweb' }),
    resources: {
      u: {
        uSize: { value: new Float32Array([W, H]), type: 'vec2<f32>' },
        uWebA: { value: a, type: 'vec4<f32>', size: MAX_WEBS },
        uWebD: { value: d, type: 'vec2<f32>', size: MAX_WEBS },
        uCount: { value: webs.length, type: 'i32' },
        uColor: { value: rgb(base), type: 'vec3<f32>' },
        uGlint: { value: rgb(pal('steel', 7)), type: 'vec3<f32>' }
      }
    }
  });
  const quad = new Sprite(Texture.WHITE);
  quad.width = W;
  quad.height = H;
  quad.filters = [filter];
  const rt = RenderTexture.create({ width: W, height: H, resolution: 1 });
  rt.source.scaleMode = 'nearest';
  renderer.render({ container: quad, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
  filter.destroy();
  quad.destroy();
  return new Sprite(rt);
}
