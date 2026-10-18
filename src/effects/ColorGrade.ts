import { Filter, GlProgram } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { GradeDef } from '../data/types.ts';

/**
 * Цветокоррекция уровня на готовый кадр (мир, свет, фон — без интерфейса): цветовой множитель и экспозиция (общий оттенок и тьма), гамма, насыщенность, контраст, раздельное тонирование (тени и света окрашиваются
 * в разные цвета) и виньетка. Тона плавно «дышат» и сдвигаются по уровню: от начала к концу тени и света переходят от цветов grade к *_end,
 * так что каждая часть уровня выглядит чуть иначе. Один проход по кадру на GPU.
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

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uExposure;
uniform float uGamma;
uniform vec3 uTint;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform vec3 uShadows;
uniform vec3 uHighlights;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  vec3 c = src.rgb * uTint * uExposure;                       // зелёный цвет локации и общая тьма
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, uSaturation);                       // насыщенность
  c = (c - 0.5) * uContrast + 0.5;                           // контраст
  c = pow(max(c, 0.0), vec3(uGamma));                         // гамма: средние тона темнее, тёмная локация
  float sh = 1.0 - smoothstep(0.0, 0.55, luma);              // раздельное тонирование: тени и света
  float hi = smoothstep(0.45, 1.0, luma);
  c += uShadows * sh + uHighlights * hi;
  vec2 d = vTextureCoord - 0.5;                              // виньетка
  c *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.0);
  // светящиеся фиолетовые детали (и блум вокруг них) не затемняются коррекцией: остаются яркими и сочными, как нарисованы
  vec3 s = src.rgb;
  float emit = step(s.g + 0.10, s.r) * smoothstep(0.82, 0.9, s.r) * smoothstep(0.96, 0.995, s.b); // неоновые пиксели (красный и синий почти на максимуме): не затемняются
  c = mix(c, min(s * 1.08, 1.0), emit);
  finalColor = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}
`;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class ColorGrade {
  private readonly filter: Filter;
  private time = 0;

  constructor(private readonly grade: GradeDef) {
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'color-grade' }),
      resources: {
        u: {
          uExposure: { value: grade.exposure ?? 1, type: 'f32' },
          uGamma: { value: grade.gamma ?? 1, type: 'f32' },
          uTint: { value: new Float32Array(grade.tint ?? [1, 1, 1]), type: 'vec3<f32>' },
          uSaturation: { value: grade.saturation ?? 1, type: 'f32' },
          uContrast: { value: grade.contrast ?? 1, type: 'f32' },
          uVignette: { value: grade.vignette ?? 0, type: 'f32' },
          uShadows: { value: new Float32Array(grade.shadows ?? [0, 0, 0]), type: 'vec3<f32>' },
          uHighlights: { value: new Float32Array(grade.highlights ?? [0, 0, 0]), type: 'vec3<f32>' }
        }
      }
    });
  }

  /** Вешает цветокоррекцию на контейнер (всё, что внутри, проходит через неё). */
  public apply(target: Container): void {
    target.filters = [this.filter];
  }

  /** progress — положение камеры по уровню, 0 (начало) .. 1 (конец). */
  public update(dt: number, progress: number): void {
    this.time += dt;
    const g = this.grade;
    const breath = 1 + 0.12 * Math.sin(this.time * 0.35); // тона слегка «дышат»
    const mix = (a: number[] | undefined, b: number[] | undefined) =>
      new Float32Array([0, 1, 2].map((i) => lerp((a ?? [0, 0, 0])[i], (b ?? a ?? [0, 0, 0])[i], progress) * breath));
    const u = this.filter.resources.u.uniforms;
    u.uShadows = mix(g.shadows, g.shadows_end);
    u.uHighlights = mix(g.highlights, g.highlights_end);
  }
}
