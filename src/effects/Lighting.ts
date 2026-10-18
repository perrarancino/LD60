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
 * Итоговый свет. Воздух (где в мире пусто) освещается мягко: плавное свечение мобов. Объекты (тайлы, мобы, герой, декор) — чётко, по пикселям арта:
 * пиксели арта считаются по сетке камеры, свечение на объект ложится ступенями, зелёный свет от фона — контровая кромка в 1–2 пикселя
 * на гранях, обращённых вверх и в стороны, и ровные полосы общего света, сильнее к низу.
 */
const COMPOSITE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uGlow;    // свечение мобов (пиксели арта)
uniform highp vec4 uInputSize; // точность как в вершинном шейдере, иначе программа не линкуется
uniform vec2 uGlowSize;
uniform float uScale;       // физических пикселей на пиксель арта
uniform vec2 uOrigin;       // сдвиг сетки арта относительно экрана, физ. px
uniform vec3 uColor;
uniform float uRim;
uniform float uAmbient;
uniform float uLevels;
float alphaAt(vec2 center, vec2 o) {
  return texture(uTexture, (center + o * uScale) * uInputSize.zw).a;
}
void main(void) {
  vec2 frag = vTextureCoord * uInputSize.xy;
  vec2 art = floor((frag - uOrigin) / uScale);          // пиксель арта, в котором этот фрагмент
  vec2 center = (art + 0.5) * uScale + uOrigin;
  float a = texture(uTexture, center * uInputSize.zw).a;
  if (a < 0.5) {
    vec3 g = texture(uGlow, (frag - uOrigin) / uScale / uGlowSize).rgb; // воздух: плавное свечение
    finalColor = vec4(g, max(g.r, max(g.g, g.b)));
    return;
  }
  vec3 g = texture(uGlow, (art + 0.5) / uGlowSize).rgb;
  float gl = max(g.r, max(g.g, g.b));
  if (gl > 0.0) g *= floor(gl * uLevels + 0.5) / uLevels / gl; // свечение на объекте — чёткими ступенями
  float up1 = 1.0 - alphaAt(center, vec2(0.0, -1.0));
  float up2 = 1.0 - alphaAt(center, vec2(0.0, -2.0));
  float side = 1.0 - min(alphaAt(center, vec2(-1.0, 0.0)), alphaAt(center, vec2(1.0, 0.0)));
  float rim = up1 > 0.5 ? 1.0 : (up2 > 0.5 ? 0.5 : (side > 0.5 ? 0.4 : 0.0)); // кромка: 1-й пиксель ярко, 2-й вполсилы
  float band = floor((0.25 + 0.75 * center.y * uInputSize.w) * 3.0) / 3.0;     // общий свет тремя ровными полосами
  float l = rim * uRim + uAmbient * band;
  vec3 c = uColor * l + g;
  finalColor = vec4(c, max(c.r, max(c.g, c.b)));
}
`;

const PURPLE_CORE = [0.8, 0.5, 1.0];
const PURPLE_HALO = [0.55, 0.22, 0.95];
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
  private glowRT: RenderTexture | null = null;
  private readonly glowRoot = new Container(); // источники для рендера свечения в низком разрешении
  private readonly glowSprites: Sprite[] = [];
  private readonly compSprite = new Sprite(); // итоговый свет: фильтр читает мир и свечение
  private comp: Filter | null = null;
  private readonly fog = new Sprite();
  private scale = 1;
  private viewW = 480;
  private viewH = 270;
  private readonly matrix = new Matrix();

  constructor(private readonly renderer: Renderer, private readonly world: Container) {
    this.compSprite.blendMode = 'add';

    // ---- свечение: два слоя — яркое ядро и широкое гало
    const layers = [
      { blur: 12, color: PURPLE_HALO, gain: 3.4 },
      { blur: 4, color: PURPLE_CORE, gain: 2.4 }
    ];
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

    this.container.addChild(this.compSprite);
  }

  /** physW/physH — размер холста в физических пикселях, scale — физических пикселей на пиксель арта. */
  public resize(physW: number, physH: number, scale: number): void {
    this.scale = scale;
    this.viewW = physW / scale;
    this.viewH = physH / scale;
    this.worldRT?.destroy(true);
    this.glowRT?.destroy(true);
    this.worldRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
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
    }, { uGlow: this.glowRT.source });
    this.compSprite.filters = [this.comp];
    for (const s of this.glowSprites) {
      s.texture = this.worldRT;
      s.scale.set(1 / scale);
    }
    this.fog.width = this.viewW;
    this.fog.height = this.viewH;
  }

  /** Раз в кадр после обновления камеры (до отрисовки сцены). */
  public update(): void {
    if (!this.worldRT || !this.glowRT) return;
    const s = this.scale;
    const wx = this.world.x;
    const wy = this.world.y;

    // 1. мир -> текстура с тем же преобразованием, что и на экране (сцена × камера)
    this.matrix.set(s, 0, 0, s, wx * s, wy * s);
    this.renderer.render({
      container: this.world, target: this.worldRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
    });

    // 2. свечение: сетка пикселей свечения совпадает с сеткой арта (дробная часть сдвига камеры)
    const fx = wx - Math.floor(wx);
    const fy = wy - Math.floor(wy);
    for (const sp of this.glowSprites) sp.position.set(-fx, -fy);
    this.renderer.render({ container: this.glowRoot, target: this.glowRT, clear: true, clearColor: [0, 0, 0, 0] });
    this.comp!.resources.u.uniforms.uOrigin = new Float32Array([fx * s, fy * s]); // сетка арта относительно экрана
  }
}
