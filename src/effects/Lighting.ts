import { BlurFilter, Container, Filter, GlProgram, Matrix, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

/**
 * Освещение — плавное и «объёмное», без пикселизации:
 *  - Зелёный свет от фона на предметах: мир рисуется в текстуру, и шейдер даёт контровую подсветку граням, обращённым вверх и в стороны
 *    (мягкий спад на несколько пикселей — предметы выглядят объёмными), плюс общий зелёный свет, сильнее к низу, + туман у земли за миром.
 *  - Свечение мобов: яркие фиолетовые пиксели (глаза, наросты) вырезаются из той же текстуры, размываются в два слоя (ядро и гало)
 *    и ложатся аддитивно на всё вокруг — на тайлы, паутину, героя.
 * Дёшево: один проход рисования мира в текстуру, свечение считается в разрешении арта (в 25 раз меньше пикселей, чем на экране)
 * и растягивается билинейно.
 */

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

/** Яркие фиолетовые пиксели -> яркость свечения. */
const EXTRACT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float purple = step(rgb.g + 0.10, rgb.r) * step(rgb.g + 0.30, rgb.b); // фиолетовый: синий >> зелёный, красный > зелёного
  float bright = smoothstep(0.70, 0.84, rgb.b);                          // светят только яркие детали, тёмный фиолетовый — нет
  float e = purple * bright * c.a;
  finalColor = vec4(e, e, e, e);
}
`;

/** Размытая яркость -> мягкое цветное свечение (плавный спад, без ступеней). */
const GLOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uGain;
void main(void) {
  float i = texture(uTexture, vTextureCoord).r * uGain;
  float q = 1.0 - exp(-i); // мягкое насыщение: у источника не «выгорает», вдали плавно сходит на нет
  finalColor = vec4(uColor * q, q);
}
`;

/**
 * Итоговый свет. Воздух (где в мире пусто) освещается мягко: небольшое свечение у ярких фиолетовых деталей мобов. На объектах (тайлы, мобы, герой,
 * декор) свет лежит только на крайних пикселях спрайта — на 1–2 пикселя арта от его края, а не на всём теле: зелёная контровая кромка от фона
 * на гранях вверх и в стороны, фиолетовое свечение ступенями и ровные полосы общего света, сильнее к низу. Края ищутся по самой картинке мира
 * (смещениями в один пиксель арта от каждого пикселя экрана), поэтому кромка идёт точно по пикселям спрайта, даже когда он повёрнут или
 * стоит не на сетке камеры.
 */
const COMPOSITE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uGlow;    // свечение мобов (пиксели арта)
uniform sampler2D uCaster;  // только существа и транзисторы
uniform highp vec4 uInputSize; // точность как в вершинном шейдере, иначе программа не линкуется
uniform vec2 uGlowSize;
uniform float uScale;       // физических пикселей на пиксель арта
uniform vec2 uOrigin;       // сдвиг сетки свечения относительно экрана, физ. px
uniform vec3 uColor;
uniform float uRim;
uniform float uAmbient;
uniform float uLevels;
bool onCaster = false; // этот пиксель принадлежит существу/транзистору
// Твёрдый ли сосед. Для пикселей поверхностей (тайлы) существа и транзисторы соседями не считаются: пол под ногами остаётся краем и освещён
// так же, как вокруг, а не тёмной дырой в кромке (тень на нём ляжет отдельно)
float solidAt(vec2 o) {
  vec2 uv = vTextureCoord + o * uScale * uInputSize.zw;
  float w = texture(uTexture, uv).a;
  return onCaster ? w : w * (1.0 - step(0.5, texture(uCaster, uv).a));
}
void main(void) {
  float a = texture(uTexture, vTextureCoord).a;
  onCaster = texture(uCaster, vTextureCoord).a > 0.5;
  vec2 frag = vTextureCoord * uInputSize.xy;
  vec3 glow = texture(uGlow, (frag - uOrigin) / uScale / uGlowSize).rgb;
  if (a < 0.5) {
    finalColor = vec4(glow, max(glow.r, max(glow.g, glow.b))); // воздух: мягкое свечение
    return;
  }
  float up1 = 1.0 - solidAt(vec2(0.0, -1.0));
  float dn1 = 1.0 - solidAt(vec2(0.0, 1.0));
  float lf1 = 1.0 - solidAt(vec2(-1.0, 0.0));
  float rt1 = 1.0 - solidAt(vec2(1.0, 0.0));
  float up2 = 1.0 - solidAt(vec2(0.0, -2.0));
  float dn2 = 1.0 - solidAt(vec2(0.0, 2.0));
  float lf2 = 1.0 - solidAt(vec2(-2.0, 0.0));
  float rt2 = 1.0 - solidAt(vec2(2.0, 0.0));
  float edge1 = max(max(up1, dn1), max(lf1, rt1));
  float edge2 = max(max(up2, dn2), max(lf2, rt2));
  float edge = edge1 > 0.5 ? 1.0 : (edge2 > 0.5 ? 0.5 : 0.0); // 1-й пиксель от края — полностью, 2-й — вполсилы, глубже — ничего
  if (edge == 0.0) { finalColor = vec4(0.0); return; }
  float gl = max(glow.r, max(glow.g, glow.b));
  if (gl > 0.0) glow *= floor(gl * uLevels + 0.5) / uLevels / gl; // свечение на краю — чёткими ступенями
  float rim = up1 > 0.5 ? 1.0 : (up2 > 0.5 ? 0.5 : ((lf1 + rt1) > 0.5 ? 0.4 : 0.0)); // кромка сверху ярче, по бокам слабее
  float band = floor((0.25 + 0.75 * vTextureCoord.y) * 3.0) / 3.0;                  // общий свет тремя ровными полосами
  vec3 c = uColor * (rim * uRim + uAmbient * band * edge) + glow * edge;
  finalColor = vec4(c, max(c.r, max(c.g, c.b)));
}
`;

/**
 * Тень существ лежит только на земле — на поверхностях тайлов под ними — и никогда на заднем плане. Для каждого пикселя тайла у открытого края
 * (до 3 пикселей арта вглубь) шейдер смотрит наружу от поверхности (вверх для пола, вниз для потолка, в стороны для стен): есть ли там существо.
 * Если есть, пиксель затемняется: на самом краю сильнее, глубже слабее, чем существо дальше от поверхности — тем бледнее. Так под персонажем
 * закрашивается полоска пола по всей его ширине (с руками), у ползущих по стене/потолку — полоска на стене/потолке. Тень идёт поверх света, поэтому
 * кромка и свечение на закрашенных пикселях гаснут. Сдвиг вдоль поверхности (по направлению от света) кратен пикселю арта.
 */
const SHADOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // только тайлы (физические пиксели): поверхности, на которые падает тень
uniform sampler2D uCaster;  // только существа
uniform highp vec4 uInputSize; // точность как в вершинном шейдере, иначе программа не линкуется
uniform float uScale;       // физических пикселей на пиксель арта
uniform float uShift;       // сдвиг тени вдоль поверхности, пиксели арта
uniform float uSmall;       // доля густоты тени у мелких предметов (транзисторов)
uniform float uReach;       // на каком расстоянии от поверхности существо ещё отбрасывает тень, пиксели арта
uniform vec3 uColor;
uniform float uStrength;
float tileAt(vec2 o) {
  return texture(uTexture, vTextureCoord + o * uScale * uInputSize.zw).a;
}
float casterAt(vec2 o) {
  return texture(uCaster, vTextureCoord + o * uScale * uInputSize.zw).a;
}
// Вид отбрасывающего тень задаёт прозрачность в текстуре существ: ≈0.55 — мелкий предмет (транзистор, тень слабее), ≈0.75 — паук (может отбрасывать
// тень и на стены с потолком), 1 — остальные (только на пол)
float hitMark = 1.0;
// Высота (в пикселях арта) ближайшей части существа над этой точкой поверхности, 0 — нет: ищется шагом 2 px наружу от поверхности.
// onlySpiders — на потолок и стены тень дают только пауки
float firstHit(vec2 dir, vec2 side, float lateral, bool onlySpiders) {
  for (int i = 1; i <= 24; i++) {
    float k = float(i) * 2.0 - 1.0;
    float a = casterAt(dir * k + side * lateral);
    if (a > 0.5 && (!onlySpiders || (a > 0.65 && a < 0.9))) { hitMark = a; return k; }
  }
  return 0.0;
}
// Тень на этом пикселе от существа, стоящего снаружи поверхности в направлении dir (side — вдоль поверхности).
// Форма — скруглённый овал: по глубине вглубь тайла (0, 1, 2 пикселя от края) нужна всё большая доля существа в окне ±3 пикселя вдоль поверхности,
// поэтому самый глубокий ряд короче, а края тени закруглены.
float shadowFrom(vec2 dir, vec2 side) {
  float depth = (1.0 - tileAt(dir)) > 0.5 ? 0.0 : ((1.0 - tileAt(dir * 2.0)) > 0.5 ? 1.0 : ((1.0 - tileAt(dir * 3.0)) > 0.5 ? 2.0 : -1.0));
  if (depth < 0.0) return 0.0;
  float need = depth < 0.5 ? 0.28 : (depth < 1.5 ? 0.5 : 0.78);
  float band = depth < 0.5 ? 1.0 : (depth < 1.5 ? 0.75 : 0.45);
  float cover = 0.0;
  float nearest = 1000.0;
  float nearestMark = 1.0;
  float heightSum = 0.0; // сумма «густот» по колонкам окна (для мелких предметов: тень по всей площади, а не пятна под тонкими ножками)
  bool onlySpiders = dir.y > -0.5; // пол (dir вверх) — для всех, потолок и стены — только для пауков
  for (int j = -3; j <= 3; j++) {
    float k = firstHit(dir, side, float(j) - uShift, onlySpiders);
    if (k > 0.0) {
      cover += 1.0;
      heightSum += clamp(1.0 - (k - 1.0) / uReach, 0.0, 1.0);
      if (k < nearest) { nearest = k; nearestMark = hitMark; }
    }
  }
  if (cover / 7.0 < need) return 0.0;
  if (nearestMark < 0.65) {
    // мелкий предмет (транзистор): густота — среднее по окну, поэтому узкие ножки не дают тёмных точек, а тело — мягкую тень под всей площадью
    float soft = heightSum / 7.0 * uSmall;
    return soft < 0.12 ? 0.0 : soft * band;
  }
  return clamp(1.0 - (nearest - 1.0) / uReach, 0.0, 1.0) * band;
}
void main(void) {
  if (tileAt(vec2(0.0)) < 0.5 || texture(uCaster, vTextureCoord).a > 0.5) { finalColor = vec4(0.0); return; }
  float s = max(
    max(shadowFrom(vec2(0.0, -1.0), vec2(1.0, 0.0)), shadowFrom(vec2(0.0, 1.0), vec2(1.0, 0.0))),
    max(shadowFrom(vec2(-1.0, 0.0), vec2(0.0, 1.0)), shadowFrom(vec2(1.0, 0.0), vec2(0.0, 1.0)))
  );
  float a = s * uStrength;
  finalColor = vec4(uColor * a, a);
}
`;

const SHADOW_SHIFT = 2; // px арта: тень чуть смещена вправо (свет — слева)
const SHADOW_REACH = 44; // px арта: выше этого существо тень не даёт
const SHADOW_SMALL = 1.0; // густота тени мелких предметов (транзисторов): среднее по площади — как у героя, но без точек под тонкими ножками
const SPIDER_MARK = 0.75; // прозрачность пауков в текстуре существ: отметка «может отбросить тень на потолок и стены»
const SMALL_MARK = 0.55; // прозрачность мелких предметов в ней же: отметка «тень слабее»
const SHADOW_STRENGTH = 0.85; // насколько тень гасит пол под собой (включая свет)
const SHADOW_COLOR = [0.0, 0.01, 0.04];

const PURPLE_CORE = [0.8, 0.5, 1.0];
const GREEN = [0.2, 1.0, 0.55];

function makeFilter(
  fragment: string, name: string, uniforms: Record<string, { value: unknown; type: string }>, extra: Record<string, unknown> = {}
): Filter {
  return new Filter({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment, name }),
    resources: { u: uniforms, ...extra }
  });
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Текстура из функции яркости (белый цвет, прозрачность = value(u, v), u и v в 0..1). */
function makeTexture(w: number, h: number, value: (u: number, v: number) => number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(255 * Math.max(0, Math.min(1, value((x + 0.5) / w, (y + 0.5) / h))));
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

export class Lighting {
  /** За миром (между фоном и миром): туман у земли. */
  public readonly backContainer = new Container();
  /** Поверх мира, под интерфейсом: подсветка предметов и свечение мобов. */
  public readonly container = new Container();

  private worldRT: RenderTexture | null = null;
  private casterRT: RenderTexture | null = null; // только существа: от них зависит тень
  private groundRT: RenderTexture | null = null; // только тайлы: на них тень ложится
  private glowRT: RenderTexture | null = null;
  private readonly glowRoot = new Container(); // источники для рендера свечения в низком разрешении
  private readonly glowSprites: Sprite[] = [];
  private readonly compSprite = new Sprite(); // итоговый свет: фильтр читает мир и свечение
  private comp: Filter | null = null;
  private readonly shadowSprite = new Sprite();
  private shadow: Filter | null = null;
  private readonly fog = new Sprite();
  private scale = 1;
  private viewW = 480;
  private viewH = 270;
  private readonly matrix = new Matrix();

  /** noCasters — слои мира, которые не отбрасывают тень (тайлы, декор, эффекты): остаются только существа; ground — слой тайлов, на который падает тень. */
  constructor(
    private readonly renderer: Renderer, private readonly world: Container, private readonly noCasters: Container[] = [],
    private readonly ground: Container | null = null, private readonly small: Container[] = [],
    private readonly spiders: () => Container[] = () => []
  ) {
    this.compSprite.blendMode = 'add';

    // ---- свечение: небольшое, у самых ярких деталей (широкого гало нет)
    const layers = [{ blur: 3.5, color: PURPLE_CORE, gain: 1.9 }];
    for (const l of layers) {
      const sprite = new Sprite();
      sprite.filters = [
        makeFilter(EXTRACT_FRAGMENT, 'glow-extract', { uUnused: { value: 0, type: 'f32' } }),
        new BlurFilter({ strength: l.blur, quality: 3 }),
        makeFilter(GLOW_FRAGMENT, 'glow-final', {
          uColor: { value: new Float32Array(l.color), type: 'vec3<f32>' },
          uGain: { value: l.gain, type: 'f32' }
        })
      ];
      sprite.blendMode = 'add';
      this.glowRoot.addChild(sprite);
      this.glowSprites.push(sprite);
    }

    // туман у земли: зелёное свечение из глубины, снизу вверх
    this.fog.texture = makeTexture(4, 128, (_u, v) => Math.pow(smoothstep(0.3, 1.0, v), 1.6));
    this.fog.tint = 0x2bd673;
    this.fog.alpha = 0.3;
    this.fog.blendMode = 'add';
    this.backContainer.addChild(this.fog);

    this.container.addChild(this.compSprite, this.shadowSprite); // тень ложится поверх света
  }

  /** physW/physH — размер холста в физических пикселях, scale — физических пикселей на пиксель арта. */
  public resize(physW: number, physH: number, scale: number): void {
    this.scale = scale;
    this.viewW = physW / scale;
    this.viewH = physH / scale;
    this.worldRT?.destroy(true);
    this.casterRT?.destroy(true);
    this.groundRT?.destroy(true);
    this.glowRT?.destroy(true);
    this.worldRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    this.casterRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    this.groundRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    // свечение — в разрешении арта (+ запас на сдвиг сетки под дробное положение камеры), на экран растягивается плавно
    const gw = Math.ceil(this.viewW) + 2;
    const gh = Math.ceil(this.viewH) + 2;
    this.glowRT = RenderTexture.create({ width: gw, height: gh, resolution: 1, scaleMode: 'linear' });

    this.compSprite.texture = this.worldRT;
    this.compSprite.scale.set(1 / scale); // сцена масштабируется на scale: на экране текстура 1:1
    // фильтр пересоздаётся вместе с текстурой свечения (она передаётся ему вторым ресурсом)
    this.comp = makeFilter(COMPOSITE_FRAGMENT, 'composite', {
      uGlowSize: { value: new Float32Array([gw, gh]), type: 'vec2<f32>' },
      uScale: { value: scale, type: 'f32' },
      uOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
      uColor: { value: new Float32Array(GREEN), type: 'vec3<f32>' },
      uRim: { value: 0.7, type: 'f32' },
      uAmbient: { value: 0.09, type: 'f32' },
      uLevels: { value: 5, type: 'f32' }
    }, { uGlow: this.glowRT.source, uCaster: this.casterRT.source });
    this.compSprite.filters = [this.comp];
    this.shadowSprite.texture = this.groundRT;
    this.shadowSprite.scale.set(1 / scale);
    this.shadow = makeFilter(SHADOW_FRAGMENT, 'shadow', {
      uScale: { value: scale, type: 'f32' },
      uShift: { value: SHADOW_SHIFT, type: 'f32' },
      uReach: { value: SHADOW_REACH, type: 'f32' },
      uSmall: { value: SHADOW_SMALL, type: 'f32' },
      uColor: { value: new Float32Array(SHADOW_COLOR), type: 'vec3<f32>' },
      uStrength: { value: SHADOW_STRENGTH, type: 'f32' }
    }, { uCaster: this.casterRT.source });
    this.shadowSprite.filters = [this.shadow];
    for (const s of this.glowSprites) {
      s.texture = this.worldRT;
      s.scale.set(1 / scale);
    }
    this.fog.width = this.viewW;
    this.fog.height = this.viewH;
  }

  /** Раз в кадр после обновления камеры (до отрисовки сцены). */
  public update(): void {
    if (!this.worldRT || !this.glowRT || !this.casterRT || !this.groundRT) return;
    const s = this.scale;
    const wx = this.world.x;
    const wy = this.world.y;

    // 1. мир -> текстура с тем же преобразованием, что и на экране (сцена × камера)
    this.matrix.set(s, 0, 0, s, wx * s, wy * s);
    this.renderer.render({
      container: this.world, target: this.worldRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
    });

    // 1б. только существа -> текстура (скрываем всё, что тени не отбрасывает)
    // вид существа кодируется прозрачностью (шейдер читает её): пауки — SPIDER_MARK, мелкие предметы — SMALL_MARK
    const hidden = this.noCasters.filter((c) => c.visible);
    for (const c of hidden) c.visible = false;
    const spiders = this.spiders();
    const saved = spiders.map((c) => c.alpha);
    for (const c of spiders) c.alpha = SPIDER_MARK;
    const savedSmall = this.small.map((c) => c.alpha);
    for (const c of this.small) c.alpha = SMALL_MARK;
    this.renderer.render({
      container: this.world, target: this.casterRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
    });
    spiders.forEach((c, i) => { c.alpha = saved[i]; });
    this.small.forEach((c, i) => { c.alpha = savedSmall[i]; });
    for (const c of hidden) c.visible = true;
    // 1в. только тайлы -> текстура (поверхности, на которые падает тень)
    if (this.ground) {
      this.renderer.render({
        container: this.ground, target: this.groundRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
      });
    }

    // 2. свечение: сетка пикселей свечения совпадает с сеткой арта (дробная часть сдвига камеры)
    const fx = wx - Math.floor(wx);
    const fy = wy - Math.floor(wy);
    for (const sp of this.glowSprites) sp.position.set(-fx, -fy);
    this.renderer.render({ container: this.glowRoot, target: this.glowRT, clear: true, clearColor: [0, 0, 0, 0] });
    this.comp!.resources.u.uniforms.uOrigin = new Float32Array([fx * s, fy * s]); // сетка арта относительно экрана
  }
}
