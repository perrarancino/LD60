import { Container, Filter, GlProgram, Matrix, Mesh, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

/**
 * Освещение:
 *  - Зелёный свет от фона на предметах (до цветокоррекции): контровая кромка по краям спрайтов и ровные полосы общего света,
 *    + туман у земли за миром.
 *  - Свет жуков (после цветокоррекции, поверх кадра): каждый спрайт, в рисунке которого есть пиксели светящихся цветов
 *    (EMISSIVE_COLORS — глаза паука, метки паучихи), сам становится источником света. Источники находятся автоматически:
 *    светящиеся пиксели рисунка собираются в группы, у каждой группы — точечный свет в её центре, тем ярче, чем она крупнее.
 *    Свет падает на всё вокруг — тайлы, героя, декор, фон — и окрашивает их (цвет предмета × цвет света + немного чистого света),
 *    тайлы его заслоняют: он заходит в тайл на несколько пикселей с освещённой стороны, а за платформой — тень.
 *  - Неоновые пиксели: сами светящиеся пиксели рисуются поверх цветокоррекции — она их не трогает, — ярче нарисованного, чуть пульсируют;
 *    вокруг них — небольшой мягкий блум.
 * Свет жуков считается в разрешении арта (в scale² раз меньше пикселей, чем на экране), блум и итог — одним фильтром на весь экран.
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

/**
 * Зелёный свет от фона (до цветокоррекции). На объектах (тайлы, мобы, герой, декор) свет лежит только на крайних пикселях спрайта —
 * на 1–2 пикселя арта от его края: контровая кромка на гранях вверх и в стороны и ровные полосы общего света, сильнее к низу.
 * Края ищутся по самой картинке мира (смещениями в один пиксель арта), поэтому кромка идёт точно по пикселям спрайта.
 * Кромка сверху горит только там, где над краем открытое место (≥ 4 пикселя): в узкой щели (брюхо паука под потолком,
 * предмет вплотную под платформой) свет от фона не проходит — иначе кромка мигает, когда щель на шаге то открывается, то закрывается.
 */
const COMPOSITE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uCaster;  // только существа и транзисторы
uniform sampler2D uGround;  // только тайлы
uniform highp vec4 uInputSize; // точность как в вершинном шейдере, иначе программа не линкуется
uniform float uScale;       // физических пикселей на пиксель арта
uniform vec3 uColor;
uniform float uRim;
uniform float uAmbient;
bool onCaster = false; // этот пиксель принадлежит существу/транзистору
bool onTile = false;   // этот пиксель — поверхность уровня (тайл)
float solidAt(vec2 o) {
  vec2 uv = vTextureCoord + o * uScale * uInputSize.zw;
  // тайл — по геометрии самих тайлов (существа не в счёт: пол под ногами остаётся краем, стена за героем краем не становится);
  // существо и прочие предметы (куллер, RAM) — по картинке мира целиком: рядом с другим предметом контровой подсветки нет
  return (!onCaster && onTile) ? texture(uGround, uv).a : texture(uTexture, uv).a;
}
void main(void) {
  float a = texture(uTexture, vTextureCoord).a;
  if (a < 0.5) { finalColor = vec4(0.0); return; } // пустота света от фона не получает
  onCaster = texture(uCaster, vTextureCoord).a > 0.5;
  onTile = texture(uGround, vTextureCoord).a > 0.5;
  // открыто ли сверху: над краем не меньше 4 пикселей пустоты (в узкой щели света нет)
  float openUp = (1.0 - solidAt(vec2(0.0, -3.0))) * (1.0 - solidAt(vec2(0.0, -4.0)));
  float up1 = (1.0 - solidAt(vec2(0.0, -1.0))) * openUp;
  float up2 = (1.0 - solidAt(vec2(0.0, -2.0))) * openUp;
  float dn1 = 1.0 - solidAt(vec2(0.0, 1.0));
  float lf1 = 1.0 - solidAt(vec2(-1.0, 0.0));
  float rt1 = 1.0 - solidAt(vec2(1.0, 0.0));
  float dn2 = 1.0 - solidAt(vec2(0.0, 2.0));
  float lf2 = 1.0 - solidAt(vec2(-2.0, 0.0));
  float rt2 = 1.0 - solidAt(vec2(2.0, 0.0));
  float edge1 = max(max(up1, dn1), max(lf1, rt1));
  float edge2 = max(max(up2, dn2), max(lf2, rt2));
  float edge = edge1 > 0.5 ? 1.0 : (edge2 > 0.5 ? 0.5 : 0.0); // 1-й пиксель от края — полностью, 2-й — вполсилы, глубже — ничего
  if (edge == 0.0) { finalColor = vec4(0.0); return; }
  float rim = up1 > 0.5 ? 1.0 : (up2 > 0.5 ? 0.5 : ((lf1 + rt1) > 0.5 ? 0.4 : 0.0)); // кромка сверху ярче, по бокам слабее
  float band = floor((0.25 + 0.75 * vTextureCoord.y) * 3.0) / 3.0;                  // общий свет тремя ровными полосами
  vec3 c = uColor * (rim * uRim + uAmbient * band * edge);
  finalColor = vec4(c, max(c.r, max(c.g, c.b)));
}
`;

/**
 * Свет жуков в разрешении арта: сумма точечных источников. Спад — мягкий «обратный квадрат» с ядром uCore, гаснущий к радиусу.
 * Тайлы заслоняют свет: от пикселя к источнику идёт луч, по пути считается, сколько пикселей арта он прошёл внутри тайлов;
 * первые uPen пикселей свет ещё проходит (освещённая грань тайла светится на глубину нескольких пикселей и плавно гаснет),
 * дальше — тень (за платформой, под полом). Результат хранится вполовину (текстура 8 бит, яркость до 2).
 */
const LIGHT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // тайлы в разрешении арта: что заслоняет свет
uniform highp vec4 uInputSize;
uniform vec4 uLights[16];   // x, y (пиксели арта на экране), радиус, сила
uniform vec4 uColors[16];   // цвет света
uniform float uCount;
uniform float uCore;
uniform float uPen;
float solid(vec2 p) {
  return texture(uTexture, p * uInputSize.zw).a;
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5; // центр пикселя арта
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uCount) break;
    vec4 L = uLights[i];
    vec2 d = L.xy - p;
    float dist = length(d);
    if (dist >= L.z) continue;
    float w = 1.0 - (dist * dist) / (L.z * L.z);
    float att = L.w * w * w / (1.0 + (dist * dist) / (uCore * uCore));
    // заслонение тайлами: длина пути луча внутри тайлов (шаг ~1.5 px арта)
    float steps = clamp(ceil(dist / 1.5), 1.0, 48.0);
    vec2 st = d / steps;
    float sl = dist / steps;
    float inside = 0.0;
    for (int k = 0; k < 48; k++) {
      if (float(k) >= steps || inside >= uPen) break;
      inside += step(0.5, solid(p + st * (float(k) + 0.5))) * sl;
    }
    float occ = clamp(1.0 - inside / uPen, 0.0, 1.0);
    sum += uColors[i].rgb * att * occ * occ;
  }
  sum *= 0.5;
  sum /= max(1.0, max(sum.r, max(sum.g, sum.b))); // пересвет: цвет уменьшается целиком, без ухода в белый
  finalColor = vec4(sum, 1.0);
}
`;

/**
 * Свет жуков поверх кадра (после цветокоррекции, на экранном разрешении). Неоновые пиксели (заданные цвета) заменяют собой
 * откорректированный кадр — непрозрачны, ярче нарисованного, пульсируют. Остальное прибавляется (выход с нулевой прозрачностью
 * при премультиплицированном смешивании = чистое сложение): освещение жуков на предметах (цвет предмета × свет + немного чистого света;
 * на самих существах слабее, чтобы жук не заливался своим же светом), лёгкий свет на фоне и в воздухе и небольшой блум вокруг источников.
 */
const GLOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uLight;   // свет жуков (разрешение арта)
uniform sampler2D uCaster;  // существа и транзисторы
uniform highp vec4 uInputSize;
uniform float uScale;
uniform vec2 uLightSize;    // размер текстуры света, пиксели арта
uniform vec4 uLights[16];
uniform vec4 uColors[16];
uniform float uCount;
uniform float uTime;
uniform vec3 uNeon;
uniform vec3 uE0;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uDiffuse;     // доля «цвет предмета × свет»
uniform float uFlat;        // доля чистого цвета света (окрашивание)
uniform float uOnCaster;    // множитель света на существах
uniform float uAir;         // свет на фоне и в воздухе
uniform float uBloom;       // сила блума
uniform float uBloomR;      // радиус блума, пиксели арта
void main(void) {
  vec4 w = texture(uTexture, vTextureCoord);
  float a = w.a;
  vec3 own = w.rgb / max(a, 0.001);
  float pulse = 1.0 + 0.08 * sin(uTime * 3.0);
  if (a > 0.5) {
    float emissive = 1.0 - step(0.04, min(distance(own, uE0), min(distance(own, uE1), distance(own, uE2))));
    if (emissive > 0.5) {
      // неоновый пиксель: непрозрачен поверх кадра (цветокоррекция его не трогает), ярче нарисованного
      finalColor = vec4(min(max(own, uNeon * pulse), vec3(1.0)), 1.0);
      return;
    }
  }
  vec2 art = vTextureCoord * uInputSize.xy / uScale; // пиксели арта на экране
  vec3 c;
  if (a > 0.5) {
    // на предметах свет ровный в пределах пикселя арта (берётся в его центре) — освещение по пикселям, как у арта
    vec3 L = texture(uLight, (floor(art) + 0.5) / uLightSize).rgb * 2.0;
    float k = texture(uCaster, vTextureCoord).a > 0.5 ? uOnCaster : 1.0;
    c = L * (own * uDiffuse + uFlat) * k;
  } else {
    vec3 L = texture(uLight, art / uLightSize).rgb * 2.0; // в воздухе — плавно
    c = L * uAir;
  }
  // небольшой блум: мягкое гало вокруг каждого источника (без заслонения — это свечение в «объективе»)
  vec3 b = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uCount) break;
    vec2 d = art - uLights[i].xy;
    b += uColors[i].rgb * uLights[i].w * exp(-dot(d, d) / (uBloomR * uBloomR));
  }
  c += b * uBloom * pulse;
  finalColor = vec4(c, 0.0);
}
`;

/**
 * Тень существ лежит только на земле — на поверхностях тайлов под ними — и никогда на заднем плане. Для каждого пикселя тайла у открытого края
 * (до 3 пикселей арта вглубь) шейдер смотрит наружу от поверхности (вверх для пола, вниз для потолка, в стороны для стен): есть ли там существо.
 * Если есть, пиксель затемняется: на самом краю сильнее, глубже слабее, чем существо дальше от поверхности — тем бледнее. Так под персонажем
 * закрашивается полоска пола по всей его ширине (с руками), у ползущих по стене/потолку — полоска на стене/потолке. Тень идёт поверх света, поэтому
 * кромка на закрашенных пикселях гаснет. Сдвиг вдоль поверхности (по направлению от света) кратен пикселю арта.
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
// Вид отбрасывающего тень задаёт прозрачность в текстуре существ: ≈0.55 — мелкий предмет (транзистор), ≈0.75 — паук (может отбрасывать
// тень на стены), 1 — остальные (только на пол); на потолок не отбрасывает никто
float hitMark = 1.0;
// Высота (в пикселях арта) ближайшей части существа над этой точкой поверхности, 0 — нет: ищется шагом 2 px наружу от поверхности.
// onlySpiders — на стены тень дают только пауки
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
  if (dir.y > 0.5) return 0.0; // на потолке тени нет ни у кого
  float depth = (1.0 - tileAt(dir)) > 0.5 ? 0.0 : ((1.0 - tileAt(dir * 2.0)) > 0.5 ? 1.0 : ((1.0 - tileAt(dir * 3.0)) > 0.5 ? 2.0 : -1.0));
  if (depth < 0.0) return 0.0;
  float need = depth < 0.5 ? 0.28 : (depth < 1.5 ? 0.5 : 0.78);
  float band = depth < 0.5 ? 1.0 : (depth < 1.5 ? 0.75 : 0.45);
  float cover = 0.0;
  float nearest = 1000.0;
  float nearestMark = 1.0;
  float heightSum = 0.0; // сумма «густот» по колонкам окна (для мелких предметов: тень по всей площади, а не пятна под тонкими ножками)
  bool onlySpiders = dir.y > -0.5; // пол (dir вверх) — для всех, стены — только для пауков
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

// Светятся только пиксели этих цветов (RGB 0..255): самые светлые фиолетовые — глаза и яркие метки мобов (паук, паучиха). До трёх цветов.
// Спрайт, в рисунке которого они есть, сам становится источником света.
const EMISSIVE_COLORS: number[][] = [[0xc0, 0x95, 0xfc]];
const emissiveUniform = (i: number) => new Float32Array((EMISSIVE_COLORS[i] ?? [-255, -255, -255]).map((v) => v / 255));

const GREEN = [0.2, 1.0, 0.55];
const NEON = [0.96, 0.66, 1.0]; // цвет неоновых пикселей (до пульсации): они светятся не темнее его и не темнее нарисованного

// ---- Свет жуков
const MAX_LIGHTS = 16; // столько источников обрабатывает шейдер (ближние к экрану и самые сильные)
const LIGHT_COLOR = [0.78, 0.42, 1.0]; // цвет света от светящихся пикселей (насыщеннее самих пикселей)
const LIGHT_RADIUS = 84; // px арта: дальше свет не достаёт (у группы из одного пикселя; крупнее группа — дальше)
const LIGHT_BASE = 0.55; // сила света группы светящихся пикселей...
const LIGHT_PER_PIXEL = 0.09; // ...плюс за каждый её пиксель
const LIGHT_MAX = 1.5;
const SPRITE_MAX = 1.7; // общая сила всех групп одного спрайта (у паучихи их много — делят её между собой, а не засвечивают всё вокруг)
const LIGHT_CORE = 17; // px арта: ядро спада (ближе — почти ровно ярко, дальше — как обратный квадрат)
const LIGHT_PEN = 5; // px арта: на сколько свет заходит в тайл с освещённой стороны
const CLUSTER_DIST = 5; // px рисунка: светящиеся пиксели ближе этого — одна группа (один источник)
const CLUSTERS_PER_SPRITE = 6;
const DIFFUSE = 1.5; // свет на предмете: цвет предмета × свет...
const FLAT = 0.55; // ...плюс немного чистого цвета света (окрашивание)
const ON_CASTER = 0.3; // на существах свет слабее (жук не заливается своим же светом)
const AIR = 0.2; // свет на фоне и в воздухе
const BLOOM = 0.3; // небольшой блум вокруг светящихся пикселей
const BLOOM_RADIUS = 4.5; // px арта

interface Cluster {
  x: number; // центр группы в пикселях кадра текстуры
  y: number;
  n: number; // сколько в ней пикселей
}

/** Точка группы на деформируемой сетке: треугольник, в который попадает её uv, и барицентрические веса (считаются один раз на сетку). */
interface MeshPoint {
  i0: number;
  i1: number;
  i2: number;
  w0: number;
  w1: number;
  w2: number;
  n: number;
}

function makeFilter(
  fragment: string, name: string, uniforms: Record<string, { value: unknown; type: string; size?: number }>, extra: Record<string, unknown> = {}
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

/** Группы светящихся пикселей в рисунке кадра (считаются один раз на текстуру). */
const clusterCache = new WeakMap<Texture, Cluster[]>();
function emissiveClusters(tex: Texture): Cluster[] {
  let found = clusterCache.get(tex);
  if (found) return found;
  found = [];
  const resource = tex?.source?.resource as CanvasImageSource | undefined;
  const { x: fx, y: fy, width: w, height: h } = tex?.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  if (resource && w > 0 && h > 0 && w * h <= 512 * 512) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(resource, fx, fy, w, h, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const groups: { sx: number; sy: number; n: number }[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          if (data[o + 3] < 128) continue;
          const hit = EMISSIVE_COLORS.some((c) => Math.hypot(data[o] - c[0], data[o + 1] - c[1], data[o + 2] - c[2]) < 10);
          if (!hit) continue;
          // в ближайшую группу (по её центру) или новая
          let best: (typeof groups)[number] | null = null;
          let bestD = CLUSTER_DIST;
          for (const g of groups) {
            const d = Math.hypot(g.sx / g.n - x, g.sy / g.n - y);
            if (d < bestD) { bestD = d; best = g; }
          }
          if (best) { best.sx += x; best.sy += y; best.n++; } else groups.push({ sx: x, sy: y, n: 1 });
        }
      }
      // самые крупные группы (у паучихи их много — берём главные)
      groups.sort((a, b) => b.n - a.n);
      found = groups.slice(0, CLUSTERS_PER_SPRITE).map((g) => ({ x: g.sx / g.n + 0.5, y: g.sy / g.n + 0.5, n: g.n }));
    } catch {
      found = []; // текстуру нельзя прочитать — без света
    }
  }
  clusterCache.set(tex, found);
  return found;
}

/** Группы светящихся пикселей на сетке (паучиха): для каждой — треугольник сетки с её uv и веса внутри него. */
const meshCache = new WeakMap<Mesh, MeshPoint[]>();
function meshPoints(mesh: Mesh): MeshPoint[] {
  let found = meshCache.get(mesh);
  if (found) return found;
  found = [];
  const clusters = emissiveClusters(mesh.texture);
  const uvs = mesh.geometry.uvs;
  const idx = mesh.geometry.indices;
  for (const k of clusters) {
    const u = k.x / mesh.texture.frame.width;
    const v = k.y / mesh.texture.frame.height;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const x0 = uvs[a * 2], y0 = uvs[a * 2 + 1], x1 = uvs[b * 2], y1 = uvs[b * 2 + 1], x2 = uvs[c * 2], y2 = uvs[c * 2 + 1];
      const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(det) < 1e-12) continue;
      const w0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / det;
      const w1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / det;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      found.push({ i0: a, i1: b, i2: c, w0, w1, w2, n: k.n });
      break;
    }
  }
  meshCache.set(mesh, found);
  return found;
}

interface Light {
  x: number;
  y: number;
  r: number;
  i: number;
}

export class Lighting {
  /** За миром (между фоном и миром): туман у земли. */
  public readonly backContainer = new Container();
  /** Поверх мира, под интерфейсом, внутри цветокоррекции: зелёный свет от фона и тени. */
  public readonly container = new Container();
  /** Поверх откорректированного кадра, под интерфейсом: свет жуков, неоновые пиксели и блум (цветокоррекция их не трогает). */
  public readonly overlay = new Container();

  private worldRT: RenderTexture | null = null;
  private casterRT: RenderTexture | null = null; // только существа: от них зависит тень
  private groundRT: RenderTexture | null = null; // только тайлы: на них тень ложится
  private lightRT: RenderTexture | null = null; // свет жуков в разрешении арта
  private readonly compSprite = new Sprite(); // зелёный свет от фона: фильтр читает мир
  private comp: Filter | null = null;
  private readonly shadowSprite = new Sprite();
  private shadow: Filter | null = null;
  private readonly lightRoot = new Container(); // проход света: тайлы в разрешении арта -> фильтр света -> lightRT
  private readonly lightSprite = new Sprite();
  private lightPass: Filter | null = null;
  private readonly glowSprite = new Sprite(); // итог света жуков поверх кадра
  private glow: Filter | null = null;
  private readonly lightData = new Float32Array(MAX_LIGHTS * 4);
  private readonly colorData = new Float32Array(MAX_LIGHTS * 4);
  private readonly fog = new Sprite();
  private scale = 1;
  private viewW = 480;
  private viewH = 270;
  private readonly matrix = new Matrix();
  private readonly tmp = new Matrix();

  /**
   * noCasters — слои мира, которые не отбрасывают тень (тайлы, декор, эффекты): остаются только существа; ground — слой тайлов, на который
   * падает тень и который заслоняет свет жуков; emitters — кто может светить (мобы): их спрайты со светящимися пикселями — источники света.
   */
  constructor(
    private readonly renderer: Renderer, private readonly world: Container, private readonly noCasters: Container[] = [],
    private readonly ground: Container | null = null, private readonly small: Container[] = [],
    private readonly spiders: () => Container[] = () => [], private readonly emitters: () => Container[] = () => []
  ) {
    this.compSprite.blendMode = 'add';

    // туман у земли: зелёное свечение из глубины, снизу вверх
    this.fog.texture = makeTexture(4, 128, (_u, v) => Math.pow(smoothstep(0.3, 1.0, v), 1.6));
    this.fog.tint = 0x2bd673;
    this.fog.alpha = 0.3;
    this.fog.blendMode = 'add';
    this.backContainer.addChild(this.fog);

    this.container.addChild(this.compSprite, this.shadowSprite); // тень ложится поверх света
    this.lightRoot.addChild(this.lightSprite);
    this.overlay.addChild(this.glowSprite);
    for (let i = 0; i < MAX_LIGHTS; i++) this.colorData.set(LIGHT_COLOR, i * 4);
  }

  /** physW/physH — размер холста в физических пикселях, scale — физических пикселей на пиксель арта. */
  public resize(physW: number, physH: number, scale: number): void {
    this.scale = scale;
    this.viewW = physW / scale;
    this.viewH = physH / scale;
    this.worldRT?.destroy(true);
    this.casterRT?.destroy(true);
    this.groundRT?.destroy(true);
    this.lightRT?.destroy(true);
    this.worldRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    this.casterRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    this.groundRT = RenderTexture.create({ width: physW, height: physH, resolution: 1, scaleMode: 'nearest' });
    const lw = Math.ceil(this.viewW);
    const lh = Math.ceil(this.viewH);
    this.lightRT = RenderTexture.create({ width: lw, height: lh, resolution: 1, scaleMode: 'linear' });
    this.compSprite.texture = this.worldRT;
    this.compSprite.scale.set(1 / scale); // сцена масштабируется на scale: на экране текстура 1:1
    // фильтры пересоздаются вместе с текстурами (они передаются им ресурсами)
    this.comp = makeFilter(COMPOSITE_FRAGMENT, 'composite', {
      uScale: { value: scale, type: 'f32' },
      uColor: { value: new Float32Array(GREEN), type: 'vec3<f32>' },
      uRim: { value: 0.5, type: 'f32' },
      uAmbient: { value: 0.09, type: 'f32' }
    }, { uCaster: this.casterRT.source, uGround: this.groundRT.source });
    this.comp.blendMode = 'add'; // фильтр рисуется в кадр прибавлением света (blendMode спрайта на результат фильтра не действует)
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

    // свет жуков: тайлы, уменьшенные до разрешения арта, -> фильтр света -> lightRT
    this.lightSprite.texture = this.groundRT;
    this.lightSprite.scale.set(1 / scale);
    this.lightPass = makeFilter(LIGHT_FRAGMENT, 'bug-light', {
      uLights: { value: this.lightData, type: 'vec4<f32>', size: MAX_LIGHTS },
      uColors: { value: this.colorData, type: 'vec4<f32>', size: MAX_LIGHTS },
      uCount: { value: 0, type: 'f32' },
      uCore: { value: LIGHT_CORE, type: 'f32' },
      uPen: { value: LIGHT_PEN, type: 'f32' }
    });
    this.lightSprite.filters = [this.lightPass];

    // итог поверх кадра
    this.glowSprite.texture = this.worldRT;
    this.glowSprite.scale.set(1 / scale);
    this.glow = makeFilter(GLOW_FRAGMENT, 'bug-glow', {
      uScale: { value: scale, type: 'f32' },
      uLightSize: { value: new Float32Array([lw, lh]), type: 'vec2<f32>' },
      uLights: { value: this.lightData, type: 'vec4<f32>', size: MAX_LIGHTS },
      uColors: { value: this.colorData, type: 'vec4<f32>', size: MAX_LIGHTS },
      uCount: { value: 0, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
      uNeon: { value: new Float32Array(NEON), type: 'vec3<f32>' },
      uE0: { value: emissiveUniform(0), type: 'vec3<f32>' },
      uE1: { value: emissiveUniform(1), type: 'vec3<f32>' },
      uE2: { value: emissiveUniform(2), type: 'vec3<f32>' },
      uDiffuse: { value: DIFFUSE, type: 'f32' },
      uFlat: { value: FLAT, type: 'f32' },
      uOnCaster: { value: ON_CASTER, type: 'f32' },
      uAir: { value: AIR, type: 'f32' },
      uBloom: { value: BLOOM, type: 'f32' },
      uBloomR: { value: BLOOM_RADIUS, type: 'f32' }
    }, { uLight: this.lightRT.source, uCaster: this.casterRT.source });
    this.glowSprite.filters = [this.glow];

    this.fog.width = this.viewW;
    this.fog.height = this.viewH;
  }

  /** Источники света: группы светящихся пикселей в спрайтах мобов, в пикселях арта на экране. */
  private collectLights(): Light[] {
    const lights: Light[] = [];
    const s = this.scale;
    // точка (lx, ly) в системе объекта с n светящимися пикселями -> источник на экране
    const power = (n: number) => Math.min(LIGHT_MAX, LIGHT_BASE + LIGHT_PER_PIXEL * n);
    // доля силы каждой группы спрайта: вместе — не больше SPRITE_MAX
    const shareOf = (ns: number[]) => Math.min(1, SPRITE_MAX / ns.reduce((a, n) => a + power(n), 0));
    const add = (m: Matrix, alpha: number, lx: number, ly: number, n: number) => {
      const size = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / s; // масштаб объекта (паучки меньше)
      const x = (m.a * lx + m.c * ly + m.tx) / s;
      const y = (m.b * lx + m.d * ly + m.ty) / s;
      const i = power(n) * size * alpha;
      const r = LIGHT_RADIUS * Math.sqrt(size) * (0.85 + 0.15 * Math.min(4, n) / 2);
      // за пределами экрана дальше радиуса — не светит на видимое
      if (x < -r || y < -r || x > this.viewW + r || y > this.viewH + r || i <= 0.01) return;
      lights.push({ x, y, r, i });
    };
    const visit = (c: Container) => {
      if (!c.visible || c.alpha <= 0) return;
      if (c instanceof Sprite) {
        const clusters = emissiveClusters(c.texture);
        if (clusters.length) {
          const m = c.getGlobalTransform(this.tmp, false); // в физических пикселях холста
          const alpha = c.getGlobalAlpha(false) * shareOf(clusters.map((k) => k.n));
          const ax = c.anchor.x * c.texture.orig.width;
          const ay = c.anchor.y * c.texture.orig.height;
          for (const k of clusters) add(m, alpha, k.x - ax, k.y - ay, k.n);
        }
      } else if (c instanceof Mesh) {
        const pts = meshPoints(c);
        if (pts.length) {
          const m = c.getGlobalTransform(this.tmp, false);
          const alpha = c.getGlobalAlpha(false) * shareOf(pts.map((q) => q.n));
          const p = c.geometry.positions; // сетка деформируется — точка едет вместе с ней
          for (const q of pts) {
            const lx = p[q.i0 * 2] * q.w0 + p[q.i1 * 2] * q.w1 + p[q.i2 * 2] * q.w2;
            const ly = p[q.i0 * 2 + 1] * q.w0 + p[q.i1 * 2 + 1] * q.w1 + p[q.i2 * 2 + 1] * q.w2;
            add(m, alpha, lx, ly, q.n);
          }
        }
      }
      for (const ch of c.children) visit(ch as Container);
    };
    for (const e of this.emitters()) visit(e);
    if (lights.length > MAX_LIGHTS) lights.sort((a, b) => b.i - a.i).length = MAX_LIGHTS;
    return lights;
  }

  /** Раз в кадр после обновления камеры (до отрисовки сцены). */
  public update(): void {
    if (!this.worldRT || !this.casterRT || !this.groundRT || !this.lightRT) return;
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
    // 1в. только тайлы -> текстура (поверхности, на которые падает тень и которые заслоняют свет жуков)
    if (this.ground) {
      this.renderer.render({
        container: this.ground, target: this.groundRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
      });
    }

    // 2. свет жуков: источники -> uniform'ы, проход света в разрешении арта
    const lights = this.collectLights();
    this.lightData.fill(0);
    lights.forEach((l, i) => this.lightData.set([l.x, l.y, l.r, l.i], i * 4));
    const t = performance.now() / 1000;
    for (const f of [this.lightPass!, this.glow!]) {
      const u = f.resources.u.uniforms;
      u.uLights = this.lightData;
      u.uCount = lights.length;
    }
    this.glow!.resources.u.uniforms.uTime = t; // неон пульсирует
    f32Touch(this.lightPass!, this.glow!);
    this.renderer.render({ container: this.lightRoot, target: this.lightRT, clear: true, clearColor: [0, 0, 0, 1] });
  }
}

/** Массивы uniform'ов меняются на месте — помечаем группы изменёнными, чтобы они ушли на GPU. */
function f32Touch(...filters: Filter[]): void {
  for (const f of filters) f.resources.u.update();
}
