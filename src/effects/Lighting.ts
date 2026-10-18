import { BlurFilter, Container, Filter, GlProgram, Matrix, RenderTexture, Sprite } from 'pixi.js';
import type { Renderer } from 'pixi.js';

/**
 * Освещение «как в 3D», но в пикселях:
 *  1. Мир рисуется в текстуру (в разрешении экрана — без потери точности).
 *  2. Свечение мобов: из неё вырезаются яркие фиолетовые пиксели (глаза, наросты, вставки), размываются в два слоя (узкий и широкий)
 *     в разрешении арта и квантуются в несколько ступеней с упорядоченным дизерингом (Байер 4x4) — получается пиксельное
 *     объёмное гало, которое ложится аддитивно на всё вокруг (на тайлы, паутину, героя).
 *  3. Зелёная подсветка от фона: верхние и боковые грани всего, что нарисовано в мире, получают тонкий зелёный контровой свет
 *     шириной в один пиксель арта + слабый общий зелёный свет, усиливающийся к низу (где в фоне туман).
 * Всё считается на GPU; на кадр — один проход рисования мира в текстуру и несколько мелких фильтров.
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

/** Яркие фиолетовые пиксели -> яркость свечения (в канале r; прозрачность сохраняется как у источника). */
const EXTRACT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float purple = step(rgb.g + 0.10, rgb.r) * step(rgb.g + 0.30, rgb.b); // фиолетовый: синий >> зелёный, красный > зелёного
  float bright = smoothstep(0.70, 0.84, rgb.b);                          // только яркие детали, тёмный фиолетовый не светит
  float e = purple * bright * c.a;
  finalColor = vec4(e, e, e, e);
}
`;

/** Размытая яркость -> ступенчатое пиксельное свечение с дизерингом. */
const GLOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uGain;
uniform float uLevels;
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { // упорядоченный дизеринг 4x4 без массивов (совместимо с GLSL ES 1.0)
  return bayer2(0.5 * a) * 0.25 + bayer2(a) + 0.03;
}
void main(void) {
  float i = clamp(texture(uTexture, vTextureCoord).r * uGain, 0.0, 1.0);
  float q = floor(i * uLevels + bayer4(floor(gl_FragCoord.xy))) / uLevels;
  q = clamp(q, 0.0, 1.0);
  finalColor = vec4(uColor * q, q);
}
`;

/** Контровой зелёный свет от фона: грани, обращённые вверх и в стороны (на один пиксель арта), + слабый общий свет, сильнее к низу. */
const RIM_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform float uStep;
uniform vec3 uColor;
uniform float uRim;
uniform float uAmbient;
float alphaAt(vec2 o) {
  return texture(uTexture, vTextureCoord + o * uInputSize.zw * uStep).a;
}
void main(void) {
  float a = texture(uTexture, vTextureCoord).a;
  if (a < 0.5) { finalColor = vec4(0.0); return; }
  float up = 1.0 - alphaAt(vec2(0.0, -1.0));
  float up2 = (1.0 - alphaAt(vec2(0.0, -2.0))) * (1.0 - up);
  float side = 0.5 * (2.0 - alphaAt(vec2(-1.0, 0.0)) - alphaAt(vec2(1.0, 0.0)));
  float rim = up + 0.4 * up2 + 0.35 * side * (1.0 - up);
  float ambient = uAmbient * (0.3 + 0.7 * vTextureCoord.y);
  float l = rim * uRim + ambient;
  finalColor = vec4(uColor * l, l);
}
`;

const PURPLE_TIGHT = [0.78, 0.45, 1.0];
const PURPLE_WIDE = [0.5, 0.2, 0.95];
const GREEN = [0.16, 0.95, 0.5];

function makeFilter(fragment: string, name: string, uniforms: Record<string, { value: unknown; type: string }>): Filter {
  return new Filter({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment, name }),
    resources: { u: uniforms }
  });
}

export class Lighting {
  /** Кладётся в сцену поверх мира и под интерфейс. */
  public readonly container = new Container();

  private worldRT: RenderTexture | null = null;
  private glowRT: RenderTexture | null = null;
  private readonly glowRoot = new Container(); // источники для рендера свечения в низком разрешении
  private readonly glowSprites: Sprite[] = [];
  private readonly rimSprite = new Sprite();
  private readonly glowDisplay = new Sprite();
  private readonly rimFilter: Filter;
  private scale = 1;
  private readonly matrix = new Matrix();

  constructor(private readonly renderer: Renderer, private readonly world: Container) {
    this.rimFilter = makeFilter(RIM_FRAGMENT, 'rim', {
      uStep: { value: 1, type: 'f32' },
      uColor: { value: new Float32Array(GREEN), type: 'vec3<f32>' },
      uRim: { value: 0.55, type: 'f32' },
      uAmbient: { value: 0.07, type: 'f32' }
    });
    this.rimSprite.filters = [this.rimFilter];
    this.rimSprite.blendMode = 'add';
    this.glowDisplay.blendMode = 'add';

    // два слоя свечения: узкое яркое ядро и широкое тусклое гало
    const layers: { blur: number; color: number[]; gain: number; levels: number }[] = [
      { blur: 10, color: PURPLE_WIDE, gain: 4.2, levels: 4 },
      { blur: 3.5, color: PURPLE_TIGHT, gain: 2.8, levels: 3 }
    ];
    for (const l of layers) {
      const sprite = new Sprite();
      sprite.filters = [
        makeFilter(EXTRACT_FRAGMENT, 'glow-extract', { uUnused: { value: 0, type: 'f32' } }),
        new BlurFilter({ strength: l.blur, quality: 3 }),
        makeFilter(GLOW_FRAGMENT, 'glow-quantize', {
          uColor: { value: new Float32Array(l.color), type: 'vec3<f32>' },
          uGain: { value: l.gain, type: 'f32' },
          uLevels: { value: l.levels, type: 'f32' }
        })
      ];
      sprite.blendMode = 'add';
      this.glowRoot.addChild(sprite);
      this.glowSprites.push(sprite);
    }
    this.container.addChild(this.rimSprite, this.glowDisplay);
  }

  /** physW/physH — размер холста в физических пикселях, scale — физических пикселей на пиксель арта. */
  public resize(physW: number, physH: number, scale: number): void {
    this.scale = scale;
    this.worldRT?.destroy(true);
    this.glowRT?.destroy(true);
    this.worldRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    // свечение — в разрешении арта (+ запас на сдвиг сетки под дробное положение камеры)
    const gw = Math.ceil(physW / scale) + 2;
    const gh = Math.ceil(physH / scale) + 2;
    this.glowRT = RenderTexture.create({ width: gw, height: gh, resolution: 1, scaleMode: 'nearest' });

    this.rimSprite.texture = this.worldRT;
    this.rimSprite.scale.set(1 / scale); // сцена масштабируется на scale: на экране текстура 1:1
    this.rimFilter.resources.u.uniforms.uStep = scale; // шаг в физических пикселях = один пиксель арта
    for (const s of this.glowSprites) {
      s.texture = this.worldRT;
      s.scale.set(1 / scale);
    }
    this.glowDisplay.texture = this.glowRT;
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
    this.glowDisplay.position.set(fx, fy);
  }
}
