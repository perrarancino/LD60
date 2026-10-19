import { Filter, GlProgram } from 'pixi.js';

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

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uColor;
uniform float uThickness;

void main(void) {
  vec4 own = texture(uTexture, vTextureCoord);
  if (own.a > 0.05) {
    // Пиксель внутри спрайта: лёгкий золотистый отблеск
    vec3 bright = mix(own.rgb, uColor.rgb, 0.12);
    finalColor = vec4(bright * own.a, own.a);
    return;
  }

  vec2 px = uInputSize.zw * uThickness;
  float maxA = 0.0;

  // 8 направлений соседних пикселей
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(-px.x, 0.0)).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(px.x, 0.0)).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(0.0, -px.y)).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(0.0, px.y)).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(-px.x, -px.y) * 0.707).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(px.x, -px.y) * 0.707).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(-px.x, px.y) * 0.707).a);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(px.x, px.y) * 0.707).a);

  // Второй слой для ровного плотного контура
  vec2 px2 = px * 1.5;
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(-px2.x, 0.0)).a * 0.8);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(px2.x, 0.0)).a * 0.8);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(0.0, -px2.y)).a * 0.8);
  maxA = max(maxA, texture(uTexture, vTextureCoord + vec2(0.0, px2.y)).a * 0.8);

  if (maxA > 0.05) {
    float alpha = min(1.0, maxA * 1.5) * uColor.a;
    finalColor = vec4(uColor.rgb * alpha, alpha);
  } else {
    finalColor = vec4(0.0);
  }
}
`;

/**
 * Шейдерный фильтр контурной обводки спрайтов (Outline) для интерактивных объектов
 */
export class SpriteOutlineFilter {
  public readonly filter: Filter;
  private time = 0;

  constructor(color: [number, number, number, number] = [0.98, 0.78, 0.22, 0.95], thickness = 1.4) {
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'sprite-outline' }),
      resources: {
        u: {
          uColor: { value: new Float32Array(color), type: 'vec4<f32>' },
          uThickness: { value: thickness, type: 'f32' }
        }
      }
    });
    this.filter.padding = 6;
  }

  /**
   * Обновление пульсации свечения обводки по времени
   */
  public update(dt: number, scale = 1): void {
    this.time += dt;
    const pulse = 0.88 + 0.12 * Math.sin(this.time * 5.0);
    const u = this.filter.resources.u.uniforms;
    // Золотисто-янтарный цвет с мягкой пульсацией яркости
    u.uColor = new Float32Array([0.98 * pulse, 0.78 * pulse, 0.22, 0.95 * pulse]);
    u.uThickness = Math.max(1.0, scale * 0.9);
  }
}

let sharedOutline: SpriteOutlineFilter | null = null;

export function getSharedOutlineFilter(): SpriteOutlineFilter {
  if (!sharedOutline) {
    sharedOutline = new SpriteOutlineFilter();
  }
  return sharedOutline;
}
