import { BlurFilter, Container, Filter, GlProgram, Matrix, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

/**
 * Освещение — плавное и «объёмное», без пикселизации:
 *  - Лучи света из «окна» в фоне: мягкие косые столбы зелёного света с лёгким колебанием, лежат ЗА миром — тайлы и платформы их перекрывают
 *    (получаются тени), как в залах с высокими окнами; в лучах плавают пылинки.
 *  - Зелёный свет от фона на предметах: мир рисуется в текстуру, и шейдер даёт контровую подсветку граням, обращённым вверх и в стороны
 *    (мягкий спад на несколько пикселей — предметы выглядят объёмными), плюс общий зелёный свет, сильнее к низу, где в фоне туман.
 *  - Свечение мобов: яркие фиолетовые пиксели (глаза, наросты) вырезаются из той же текстуры, размываются в два слоя (ядро и гало)
 *    и ложатся аддитивно на всё вокруг — на тайлы, паутину, героя.
 * Дёшево: один проход рисования мира в текстуру, свечение считается в разрешении арта (в 25 раз меньше пикселей, чем на экране)
 * и растягивается билинейно, лучи — 7 спрайтов одной текстуры, пылинки — 40 спрайтов.
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

/** Зелёный свет от фона: контровая подсветка граней (мягкий спад ~4 px арта) + общий свет, сильнее к низу. */
const RIM_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize; // точность как в вершинном шейдере, иначе программа не линкуется
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
  // «открытость» к свету: сверху и по бокам (взвешено), чем больше свободного места рядом — тем сильнее подсветка
  float o = 0.0;
  o += 1.0 * (1.0 - alphaAt(vec2( 0.0, -1.5)));
  o += 1.0 * (1.0 - alphaAt(vec2( 0.0, -3.5)));
  o += 0.8 * (1.0 - alphaAt(vec2(-1.1, -1.1)));
  o += 0.8 * (1.0 - alphaAt(vec2( 1.1, -1.1)));
  o += 0.8 * (1.0 - alphaAt(vec2(-2.5, -2.5)));
  o += 0.8 * (1.0 - alphaAt(vec2( 2.5, -2.5)));
  o += 0.5 * (1.0 - alphaAt(vec2(-1.5,  0.0)));
  o += 0.5 * (1.0 - alphaAt(vec2( 1.5,  0.0)));
  o += 0.5 * (1.0 - alphaAt(vec2(-3.5,  0.0)));
  o += 0.5 * (1.0 - alphaAt(vec2( 3.5,  0.0)));
  o /= 7.2;
  float l = pow(o, 1.3) * uRim + uAmbient * (0.25 + 0.75 * vTextureCoord.y);
  finalColor = vec4(uColor * l, l);
}
`;

const PURPLE_CORE = [0.8, 0.5, 1.0];
const PURPLE_HALO = [0.55, 0.22, 0.95];
const GREEN = [0.2, 1.0, 0.55];

function makeFilter(fragment: string, name: string, uniforms: Record<string, { value: unknown; type: string }>): Filter {
  return new Filter({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment, name }),
    resources: { u: uniforms }
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

// ---- Лучи из «окна» над экраном: x и ширина — px, a — яркость; висят от верха экрана и лишь слегка смещаются вместе с камерой
const BEAMS = [
  { x: 40, w: 90, a: 0.16 }, { x: 175, w: 150, a: 0.10 }, { x: 310, w: 60, a: 0.17 }, { x: 450, w: 170, a: 0.09 },
  { x: 600, w: 80, a: 0.15 }, { x: 735, w: 130, a: 0.10 }, { x: 870, w: 70, a: 0.16 }
];
const BEAM_ANGLE = -0.32; // рад: лучи идут сверху-слева вниз-вправо
const BEAM_LENGTH = 1.25; // длина луча в высотах экрана
const BEAM_PARALLAX = 0.55; // лучи из глубины: смещаются по x медленнее мира
const BEAM_COLOR = 0x78ffb8;

// ---- Пылинки
const DUST_COUNT = 40;
const DUST_COLOR = 0xc8ffd6;

interface Dust {
  sprite: Sprite;
  vx: number;
  vy: number;
  phase: number;
  speed: number;
}

export class Lighting {
  /** За миром (между фоном и миром): лучи света и туман. */
  public readonly backContainer = new Container();
  /** Поверх мира, под интерфейсом: подсветка предметов, свечение мобов, пылинки. */
  public readonly container = new Container();

  private worldRT: RenderTexture | null = null;
  private glowRT: RenderTexture | null = null;
  private readonly glowRoot = new Container(); // источники для рендера свечения в низком разрешении
  private readonly glowSprites: Sprite[] = [];
  private readonly rimSprite = new Sprite();
  private readonly glowDisplay = new Sprite();
  private readonly rimFilter: Filter;
  private readonly beamLayer = new Container();
  private readonly beams: { sprite: Sprite; x: number; phase: number; base: number }[] = [];
  private readonly fog = new Sprite();
  private readonly dustLayer = new Container();
  private readonly dust: Dust[] = [];
  private scale = 1;
  private viewW = 480;
  private viewH = 270;
  private time = 0;
  private lastCam = { x: 0, y: 0, ready: false };
  private readonly matrix = new Matrix();

  constructor(private readonly renderer: Renderer, private readonly world: Container) {
    // ---- подсветка граней и общий зелёный свет
    this.rimFilter = makeFilter(RIM_FRAGMENT, 'rim', {
      uStep: { value: 1, type: 'f32' },
      uColor: { value: new Float32Array(GREEN), type: 'vec3<f32>' },
      uRim: { value: 0.7, type: 'f32' },
      uAmbient: { value: 0.09, type: 'f32' }
    });
    this.rimSprite.filters = [this.rimFilter];
    this.rimSprite.blendMode = 'add';

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
    this.glowDisplay.blendMode = 'add';

    // ---- лучи из окна
    const beamTex = makeTexture(64, 256, (u, v) => {
      const across = 1 - (2 * u - 1) ** 2; // колоколообразный профиль — края растворяются
      return across * across * Math.pow(1 - v, 1.35) * smoothstep(0, 0.06, v);
    });
    BEAMS.forEach((b, i) => {
      const sprite = new Sprite(beamTex);
      sprite.anchor.set(0.5, 0);
      sprite.tint = BEAM_COLOR;
      sprite.blendMode = 'add';
      sprite.width = b.w;
      sprite.rotation = BEAM_ANGLE;
      sprite.position.set(b.x, -24);
      this.beamLayer.addChild(sprite);
      this.beams.push({ sprite, x: b.x, phase: i * 1.7, base: b.a });
    });
    // туман у земли: зелёное свечение из глубины, снизу вверх
    this.fog.texture = makeTexture(4, 128, (_u, v) => Math.pow(smoothstep(0.3, 1.0, v), 1.6));
    this.fog.tint = 0x2bd673;
    this.fog.alpha = 0.3;
    this.fog.blendMode = 'add';
    this.backContainer.addChild(this.fog, this.beamLayer);

    // ---- пылинки
    const dustTex = makeTexture(16, 16, (u, v) => Math.pow(Math.max(0, 1 - Math.hypot(2 * u - 1, 2 * v - 1)), 1.6));
    for (let i = 0; i < DUST_COUNT; i++) {
      const sprite = new Sprite(dustTex);
      sprite.anchor.set(0.5);
      sprite.tint = DUST_COLOR;
      sprite.blendMode = 'add';
      sprite.width = sprite.height = 3 + Math.random() * 5;
      this.dustLayer.addChild(sprite);
      this.dust.push({ sprite, vx: (Math.random() - 0.3) * 6, vy: 2 + Math.random() * 7, phase: Math.random() * 6.28, speed: 0.4 + Math.random() * 1.2 });
      sprite.position.set(Math.random() * 480, Math.random() * 270);
    }
    this.container.addChild(this.rimSprite, this.glowDisplay, this.dustLayer);
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

    this.rimSprite.texture = this.worldRT;
    this.rimSprite.scale.set(1 / scale); // сцена масштабируется на scale: на экране текстура 1:1
    this.rimFilter.resources.u.uniforms.uStep = scale; // шаг в физических пикселях = один пиксель арта
    for (const s of this.glowSprites) {
      s.texture = this.worldRT;
      s.scale.set(1 / scale);
    }
    this.glowDisplay.texture = this.glowRT;
    for (const b of this.beams) b.sprite.height = this.viewH * BEAM_LENGTH;
    this.fog.width = this.viewW;
    this.fog.height = this.viewH;
  }

  /** Раз в кадр после обновления камеры (до отрисовки сцены). */
  public update(dt: number): void {
    if (!this.worldRT || !this.glowRT) return;
    this.time += dt;
    const s = this.scale;
    const wx = this.world.x;
    const wy = this.world.y;

    // лучи: слегка колеблются; смещаются вместе с камерой, но медленнее (глубина)
    this.beamLayer.position.set(wx * BEAM_PARALLAX, 0);
    for (const b of this.beams) {
      const k = 0.72 + 0.28 * Math.sin(this.time * 0.45 + b.phase);
      b.sprite.alpha = Math.min(1, b.base * k * 6);
      b.sprite.x = b.x + Math.sin(this.time * 0.17 + b.phase) * 9;
    }

    // пылинки: дрейфуют и мерцают, слегка отстают от камеры (параллакс), на краях заворачиваются
    const dcx = this.lastCam.ready ? wx - this.lastCam.x : 0;
    const dcy = this.lastCam.ready ? wy - this.lastCam.y : 0;
    this.lastCam = { x: wx, y: wy, ready: true };
    for (const d of this.dust) {
      const sp = d.sprite;
      sp.x += d.vx * dt + dcx * 0.55 + Math.sin(this.time * d.speed + d.phase) * 3 * dt;
      sp.y += d.vy * dt + dcy * 0.55;
      if (sp.x < -8) sp.x += this.viewW + 16; else if (sp.x > this.viewW + 8) sp.x -= this.viewW + 16;
      if (sp.y < -8) sp.y += this.viewH + 16; else if (sp.y > this.viewH + 8) sp.y -= this.viewH + 16;
      sp.alpha = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(this.time * d.speed * 1.7 + d.phase * 2));
    }

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
