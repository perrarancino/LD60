import { Container, Filter, GlProgram, Sprite, Texture } from 'pixi.js';
import type { BackgroundDef } from '../data/types.ts';

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
 * «Закрученная краска»: экран делится на крупные пиксели, поле закручивается спиралью, потом несколько раз сминается синусами — получаются
 * текучие пятна. Пятна красятся тремя цветами (тень, середина, блик) по расстоянию до «линии краски», блики чуть светятся.
 */
const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform vec2 uRes;
uniform vec2 uOffset;
uniform float uTime;
uniform float uPixel;
uniform float uZoom;
uniform float uSpin;
uniform float uContrast;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;

void main(void) {
  vec2 frag = vTextureCoord * uRes;
  if (uPixel > 0.5) frag = floor(frag / uPixel) * uPixel; // крупные пиксели; pixel = 0 — гладко, по физическим пикселям
  vec2 uv = (frag - 0.5 * uRes) / length(uRes) - uOffset;
  float len = length(uv);

  // спираль: чем дальше от центра, тем меньше закручено
  float ang = atan(uv.y, uv.x) + 302.2 - 5.0 * (uSpin * len + (1.0 - uSpin));
  vec2 mid = 0.5 * uRes / length(uRes);
  uv = vec2(len * cos(ang) + mid.x, len * sin(ang) + mid.y) - mid;

  uv *= uZoom; // частота пятен: меньше — крупнее и спокойнее
  float t = uTime;
  vec2 uv2 = vec2(uv.x + uv.y);
  for (int i = 0; i < 5; i++) {
    uv2 += sin(max(uv.x, uv.y)) + uv;
    uv += 0.5 * vec2(cos(5.1123314 + 0.353 * uv2.y + t * 0.131121), sin(uv2.x - 0.113 * t));
    uv -= cos(uv.x + uv.y) - sin(uv.x * 0.711 - uv.y);
  }

  float k = 0.25 * uContrast + 0.5 * uSpin + 1.2;
  float paint = min(2.0, max(0.0, length(uv) * 0.035 * k));
  float p1 = max(0.0, 1.0 - k * abs(1.0 - paint));
  float p2 = max(0.0, 1.0 - k * abs(paint));
  float p3 = 1.0 - min(1.0, p1 + p2);
  float light = 0.2 * max(p1 * 5.0 - 4.0, 0.0) + 0.4 * max(p2 * 5.0 - 4.0, 0.0);
  float base = 0.3 / uContrast;
  vec3 col = base * uC1 + (1.0 - base) * (uC1 * p1 + uC2 * p2 + uC3 * p3) + vec3(light) * uC2;
  finalColor = vec4(col, 1.0);
}
`;

const hex = (v: string): Float32Array => {
  const n = parseInt(v.slice(1), 16);
  return new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
};

/**
 * Фон-шейдер (data/backgrounds/*.json, поле shader): вместо слоёв-картинок экран закрашивает фрагментный шейдер, цвета берутся из данных.
 * Интерфейс как у ParallaxBackground (container / resize / update), чтобы игра выбирала любой.
 */
export class ShaderBackground {
  public readonly container = new Container();

  private readonly quad = new Sprite(Texture.WHITE);
  private readonly filter: Filter;
  private readonly speed: number;
  private time = Math.random() * 20;
  private last = performance.now();

  constructor(def: BackgroundDef) {
    const sh = def.shader;
    if (!sh) throw new Error(`[ShaderBackground] у фона "${def.id}" нет блока shader`);
    this.speed = sh.speed ?? 1;
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'swirl-background' }),
      resources: {
        u: {
          uRes: { value: new Float32Array([480, 270]), type: 'vec2<f32>' },
          uOffset: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uTime: { value: 0, type: 'f32' },
          uPixel: { value: sh.pixel ?? 3, type: 'f32' },
          uZoom: { value: sh.zoom ?? 30, type: 'f32' },
          uSpin: { value: 0.25 * (sh.spin ?? 1), type: 'f32' },
          uContrast: { value: sh.contrast ?? 3.5, type: 'f32' },
          uC1: { value: hex(sh.colors[0]), type: 'vec3<f32>' },
          uC2: { value: hex(sh.colors[1]), type: 'vec3<f32>' },
          uC3: { value: hex(sh.colors[2]), type: 'vec3<f32>' }
        }
      }
    });
    this.quad.filters = [this.filter];
    this.container.addChild(this.quad);
  }

  public resize(viewW: number, viewH: number): void {
    this.quad.width = viewW;
    this.quad.height = viewH;
    this.filter.resources.u.uniforms.uRes = new Float32Array([viewW, viewH]);
  }

  /** Камера почти не двигает краску (она далеко): лёгкий сдвиг по камере и течение по времени. */
  public update(camX: number, camY: number, _worldBottom: number, _pixelScale: number): void {
    const now = performance.now();
    this.time += Math.min(0.1, (now - this.last) / 1000) * this.speed;
    this.last = now;
    const u = this.filter.resources.u.uniforms;
    u.uTime = this.time;
    u.uOffset = new Float32Array([-camX * 0.00035, -camY * 0.00035]);
  }
}
