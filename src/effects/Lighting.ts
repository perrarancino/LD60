import { Container, Filter, GlProgram, Matrix, Mesh, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

/**
 * Освещение. Мир рисуется ОДИН раз в текстуру worldRT (физическое разрешение) и на экран выводится из неё. Все расчёты света
 * (тени, свет жуков, блум) идут на сетке арта, привязанной к миру (клетка = пиксель арта мира, сдвиг камеры — доля клетки), то есть в scale² раз
 * меньше пикселей, чем на экране; на физическом разрешении остаются два лёгких прохода:
 *  - до цветокоррекции (сцена мира): зелёная контровая кромка по краям спрайтов (до 13 чтений на непустой пиксель), тени на земле, туман у земли;
 *  - после цветокоррекции (поверх кадра): свет жуков на предметах и в воздухе, кромка от света, неоновые пиксели, блум и ореол (цветокоррекция их не трогает).
 * Кромка считается по физическому силуэту (у повёрнутых частей край гладкий, как в рисунке), тени режутся силуэтом.
 *
 * Слои света на сетке арта:
 *  - worldA: r — прозрачность мира, g — светящийся пиксель (неон), b — отметка существа (вид задаёт прозрачность в текстуре существ);
 *  - groundA: только тайлы (рисуются сразу на сетке, видимые чанки);
 *  - fxRT: g — сила тени;
 *  - lightRT: rgb — свет жуков (с заслонением тайлами), a — ореол вокруг светящихся пикселей;
 *  - fx2RT: rgb — блум вокруг источников.
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

/** Сжатие мира и существ с физического разрешения в сетку арта: значение берётся в центре клетки. */
const DOWN_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;   // размер сетки арта
uniform sampler2D uWorld;        // мир (физические пиксели)
uniform sampler2D uCaster;       // существа (физические пиксели)
uniform vec2 uPhys;              // размер физической текстуры
uniform vec2 uFrac;              // дробная часть положения камеры, пиксели арта
uniform float uScale;            // физических пикселей на пиксель арта
uniform vec3 uE0;
uniform vec3 uE1;
uniform vec3 uE2;
void main(void) {
  vec2 cell = floor(vTextureCoord * uInputSize.xy);
  vec2 uv = clamp(((cell + 0.5 - uFrac) * uScale) / uPhys, 0.5 / uPhys, 1.0 - 0.5 / uPhys);
  vec4 w = texture(uWorld, uv);
  float mark = texture(uCaster, uv).a;
  vec3 own = w.rgb / max(w.a, 0.001);
  float emit = w.a > 0.5 ? 1.0 - step(0.04, min(distance(own, uE0), min(distance(own, uE1), distance(own, uE2)))) : 0.0;
  finalColor = vec4(w.a, emit, mark, 1.0);
}
`;

/**
 * Тени на сетке арта. Тень существ лежит только на земле — на тайлах под ними — и никогда на заднем плане: для каждой клетки тайла у открытого края
 * (до 3 клеток вглубь) шейдер смотрит наружу (вверх для пола, в стороны для стен; на потолок тень не падает ни у кого): есть ли там существо. Есть —
 * клетка затемняется: на самом краю сильнее, глубже слабее, чем существо дальше от поверхности — тем бледнее. Форма скруглённая: чем глубже ряд, тем
 * большая доля существа в окне ±3 клетки нужна. Вид отбрасывающего тень задаёт отметка существа (b у worldA): ≈0.55 мелкий предмет (транзистор),
 * ≈0.75 паук (может на стены), ≈0.85 светящийся моб, 1 — остальные (только на пол). Зелёная кромка считается не здесь, а на физическом разрешении
 * (по силуэту спрайта), иначе у повёрнутых частей она сползает с края.
 */
const SHADOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform vec2 uInvArt;       // 1 / размер сетки арта (uInputSize у фильтра — размер служебной текстуры, не сетки)
uniform sampler2D uWorldA;
uniform sampler2D uGroundA;
uniform float uShift;       // сдвиг тени вдоль поверхности, клетки
uniform float uSmall;       // доля густоты тени у мелких предметов
uniform float uReach;       // до какой высоты существо ещё отбрасывает тень, клетки
uniform float uStrength;
vec2 cell;
vec2 uvAt(vec2 o) { return (cell + 0.5 + o) * uInvArt; }
float casterAt(vec2 o) { return texture(uWorldA, uvAt(o)).b; }
float tileAt(vec2 o) { return texture(uGroundA, uvAt(o)).a; }
float hitMark = 1.0;
float firstHit(vec2 dir, vec2 side, float lateral, bool onlySpiders) {
  for (int i = 1; i <= 24; i++) {
    float k = float(i) * 2.0 - 1.0;
    float a = casterAt(dir * k + side * lateral);
    if (a > 0.5 && (!onlySpiders || (a > 0.65 && a < 0.8))) { hitMark = a; return k; }
  }
  return 0.0;
}
float shadowFrom(vec2 dir, vec2 side) {
  if (dir.y > 0.5) return 0.0; // на потолке тени нет ни у кого
  float depth = (1.0 - tileAt(dir)) > 0.5 ? 0.0 : ((1.0 - tileAt(dir * 2.0)) > 0.5 ? 1.0 : ((1.0 - tileAt(dir * 3.0)) > 0.5 ? 2.0 : -1.0));
  if (depth < 0.0) return 0.0;
  float need = depth < 0.5 ? 0.28 : (depth < 1.5 ? 0.5 : 0.78);
  float band = depth < 0.5 ? 1.0 : (depth < 1.5 ? 0.75 : 0.45);
  float cover = 0.0;
  float nearest = 1000.0;
  float nearestMark = 1.0;
  float heightSum = 0.0;
  bool onlySpiders = dir.y > -0.5; // пол — для всех, стены — только для пауков
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
    float soft = heightSum / 7.0 * uSmall;
    return soft < 0.12 ? 0.0 : soft * band;
  }
  return clamp(1.0 - (nearest - 1.0) / uReach, 0.0, 1.0) * band;
}
void main(void) {
  cell = floor(vTextureCoord * uInputSize.xy);
  float shadowOut = 0.0;
  if (tileAt(vec2(0.0)) > 0.5 && casterAt(vec2(0.0)) < 0.5) {
    float s = max(
      max(shadowFrom(vec2(0.0, -1.0), vec2(1.0, 0.0)), shadowFrom(vec2(0.0, 1.0), vec2(1.0, 0.0))),
      max(shadowFrom(vec2(-1.0, 0.0), vec2(0.0, 1.0)), shadowFrom(vec2(1.0, 0.0), vec2(0.0, 1.0)))
    );
    shadowOut = s * uStrength;
  }
  finalColor = vec4(0.0, shadowOut, 0.0, 1.0);
}
`;

/**
 * Свет жуков на сетке арта: сумма точечных источников. Спад — мягкий «обратный квадрат» с ядром uCore, гаснущий к радиусу.
 * Тайлы заслоняют свет: от клетки к источнику идёт луч, по пути считается, сколько клеток он прошёл внутри тайлов;
 * первые uPen клеток свет ещё проходит (освещённая грань тайла светится на глубину нескольких пикселей и плавно гаснет),
 * дальше — тень (за платформой, под полом). Яркость мягко насыщается к 1 без смены оттенка (у самого источника фиолетовый не выгорает в белый).
 * В прозрачность пишется ореол: сколько светящихся пикселей рядом (окно ±3 клетки, гауссов вес).
 */
const LIGHT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform vec2 uInvArt;       // 1 / размер сетки арта (uInputSize у фильтра — размер служебной текстуры, не сетки)
uniform sampler2D uGroundA;
uniform sampler2D uWorldA;
uniform vec4 uLights[16];   // x, y (клетки сетки), радиус, сила
uniform vec4 uColors[16];   // цвет света
uniform float uCount;
uniform float uCore;
uniform float uPen;
float solid(vec2 p) {
  return texture(uGroundA, p * uInvArt).a;
}
float emitAt(vec2 p) {
  return texture(uWorldA, p * uInvArt).g;
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5; // центр клетки
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uCount) break;
    vec4 L = uLights[i];
    vec2 d = L.xy - p;
    float dist = length(d);
    if (dist >= L.z) continue;
    float w = 1.0 - (dist * dist) / (L.z * L.z);
    float att = L.w * w * w / (1.0 + (dist * dist) / (uCore * uCore));
    // заслонение тайлами: длина пути луча внутри тайлов (шаг ~1.5 клетки)
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
  float m = max(sum.r, max(sum.g, sum.b));
  sum *= m > 0.0 ? (1.0 - exp(-1.3 * m)) / m : 1.0; // мягкое насыщение: цвет уменьшается целиком, без ухода в белый
  float glow = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      float d2 = float(x * x + y * y);
      if (d2 > 10.0) continue;
      glow += emitAt(p + vec2(float(x), float(y))) * exp(-d2 / 3.0);
    }
  }
  finalColor = vec4(sum, 1.0 - exp(-0.45 * glow));
}
`;

/** Блум вокруг источников на сетке арта: мягкое гало (гауссиана) от каждого источника, без заслонения — это свечение «в объективе». */
const BLOOM_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform vec4 uLights[16];
uniform vec4 uColors[16];
uniform float uCount;
uniform float uBloom;
uniform float uBloomR;
void main(void) {
  vec2 center = floor(vTextureCoord * uInputSize.xy) + 0.5;
  vec3 b = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uCount) break;
    vec2 d = center - uLights[i].xy;
    b += uColors[i].rgb * uLights[i].w * exp(-dot(d, d) / (uBloomR * uBloomR));
  }
  finalColor = vec4(b * uBloom, 0.0);
}
`;

/**
 * Сцена мира до цветокоррекции, физическое разрешение (один фильтр на спрайте с worldRT). Зелёная контровая кромка считается здесь, по физическому
 * силуэту спрайта (края повёрнутых частей — героя, рук, босса — остаются гладкими): на объектах (тайлы, мобы, герой, декор) свет лежит только на
 * крайних пикселях — на 1–2 пикселя арта от края: кромка на гранях вверх и в стороны и ровные полосы общего света, сильнее к низу. Сверху кромка горит
 * только там, где над краем открыто ≥ 4 пикселя (в узкой щели света от фона нет — иначе она мигает на каждом шаге). Не больше 13 чтений на непустой
 * пиксель. Тень берётся с сетки арта и режется силуэтом; туман у земли добавляется там, где мир прозрачен (он лежит под миром).
 */
const SCENE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uCaster;  // только существа (физические пиксели)
uniform sampler2D uFx;      // сетка арта: g — тень
uniform sampler2D uGroundA; // сетка арта: тайлы
uniform highp vec4 uInputSize;
uniform float uScale;
uniform vec2 uFrac;
uniform vec2 uArtSize;
uniform float uRim;
uniform float uAmbient;
uniform vec3 uRimColor;
uniform vec3 uShadowColor;
uniform vec3 uFog;          // цвет тумана с учётом его силы
bool onCaster = false;
bool onTile = false;
vec2 art;
float solidAt(vec2 o) {
  // тайл — по геометрии тайлов (существа не в счёт: пол под ногами остаётся краем, стена за героем краем не становится);
  // существо и прочие предметы (куллер, RAM) — по картинке мира целиком: рядом с другим предметом контровой подсветки нет
  return (!onCaster && onTile) ? texture(uGroundA, (art + o) / uArtSize).a : texture(uTexture, vTextureCoord + o * uScale * uInputSize.zw).a;
}
void main(void) {
  vec4 w = texture(uTexture, vTextureCoord);
  art = vTextureCoord * uInputSize.xy / uScale + uFrac; // положение в клетках сетки арта (дробное)
  float solid = step(0.5, w.a);
  float rimK = 0.0;
  if (solid > 0.5) {
    onCaster = texture(uCaster, vTextureCoord).a > 0.5;
    onTile = texture(uGroundA, art / uArtSize).a > 0.5;
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
    float edge = edge1 > 0.5 ? 1.0 : (edge2 > 0.5 ? 0.5 : 0.0); // 1-й пиксель арта от края — полностью, 2-й — вполсилы
    if (edge > 0.0) {
      float rim = up1 > 0.5 ? 1.0 : (up2 > 0.5 ? 0.5 : ((lf1 + rt1) > 0.5 ? 0.4 : 0.0)); // сверху ярче, по бокам слабее
      float band = floor((0.25 + 0.75 * vTextureCoord.y) * 3.0) / 3.0;                  // общий свет тремя ровными полосами
      rimK = rim * uRim + uAmbient * band * edge;
    }
  }
  float sa = texture(uFx, art / uArtSize).g * solid;
  vec3 rgb = w.rgb + uRimColor * rimK;
  rgb = rgb * (1.0 - sa) + uShadowColor * sa;      // тень идёт поверх кромки
  float v = pow(smoothstep(0.3, 1.0, vTextureCoord.y), 1.6);
  rgb += uFog * v * (1.0 - w.a);                    // туман: снизу вверх, только сквозь прозрачные места мира
  finalColor = vec4(rgb, w.a);
}
`;

/**
 * Свет жуков поверх кадра (после цветокоррекции), физическое разрешение. Неоновые пиксели (заданные цвета) заменяют собой откорректированный кадр —
 * непрозрачны, ярче нарисованного (тот же оттенок), пульсируют. Остальное прибавляется (прозрачность 0 при премультиплицированном смешивании =
 * чистое сложение): заливка предметов (цвет предмета × свет + немного чистого света) и контровая кромка от света — как у зелёной кромки, по
 * физическому силуэту: края предметов и персонажей (1-й пиксель арта от края — полностью, 2-й — вполсилы), повёрнутые к источнику, загораются его
 * цветом; сторона края — по тому, где рядом пусто, направление на свет — средневзвешенное по источникам (считается только у краёв рядом со светом).
 * Свет на фоне и в воздухе, блум и ореол светящихся пикселей берутся с сетки арта (плавно).
 */
const GLOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture; // мир (физические пиксели)
uniform sampler2D uCaster;  // только существа (физические пиксели); прозрачность — отметка вида существа
uniform sampler2D uLight;   // сетка арта: rgb — свет, a — ореол (линейная фильтрация)
uniform sampler2D uFx2;     // сетка арта: rgb — блум (линейная фильтрация)
uniform sampler2D uGroundA; // сетка арта: тайлы
uniform highp vec4 uInputSize;
uniform float uScale;
uniform vec2 uFrac;
uniform vec2 uArtSize;
uniform vec4 uLights[16];
uniform float uCount;
uniform float uCore;
uniform float uRim;         // сила кромки
uniform float uTime;
uniform float uBoost;       // во сколько раз неоновые пиксели ярче нарисованных
uniform vec3 uE0;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uDiffuse;     // доля «цвет предмета × свет»
uniform float uFlat;        // доля чистого цвета света (окрашивание)
uniform float uOnCaster;    // множитель света на самих светящихся мобах
uniform float uAir;         // свет на фоне и в воздухе
uniform float uHalo;        // сила ореола у светящихся пикселей
uniform vec3 uHaloColor;
bool onCaster = false;
bool onTile = false;
vec2 art;
float solidAt(vec2 o) {
  return (!onCaster && onTile) ? texture(uGroundA, (art + o) / uArtSize).a : texture(uTexture, vTextureCoord + o * uScale * uInputSize.zw).a;
}
void main(void) {
  vec4 w = texture(uTexture, vTextureCoord);
  float a = w.a;
  vec3 own = w.rgb / max(a, 0.001);
  float pulse = 1.0 + 0.08 * sin(uTime * 3.0);
  if (a > 0.5) {
    float emissive = 1.0 - step(0.04, min(distance(own, uE0), min(distance(own, uE1), distance(own, uE2))));
    if (emissive > 0.5) {
      // неоновый пиксель: непрозрачен поверх кадра (цветокоррекция его не трогает), ярче нарисованного, того же оттенка
      finalColor = vec4(min((own * uBoost + 0.04) * pulse, vec3(1.0)), 1.0);
      return;
    }
  }
  art = vTextureCoord * uInputSize.xy / uScale + uFrac;
  vec2 smoothUv = art / uArtSize;                              // для плавных величин (воздух, блум, ореол)
  vec2 cell = floor(art) + 0.5;
  vec2 cellUv = cell / uArtSize;                                // для величин «по пикселю арта» (предметы)
  vec3 c;
  if (a > 0.5) {
    vec3 L = texture(uLight, cellUv).rgb;
    float mark = texture(uCaster, vTextureCoord).a;
    onCaster = mark > 0.5;
    onTile = texture(uGroundA, cellUv).a > 0.5;
    float k = (mark > 0.6 && mark < 0.99) ? uOnCaster : 1.0;   // светящиеся мобы — слабее
    c = L * (own * uDiffuse + uFlat) * k;
    // кромка: край (1–2 пикселя арта), повёрнутый к свету
    if (max(L.r, max(L.g, L.b)) > 0.01) {
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
      float edge = edge1 > 0.5 ? 1.0 : (edge2 > 0.5 ? 0.5 : 0.0);
      if (edge > 0.0) {
        vec2 n = edge1 > 0.5 ? vec2(rt1 - lf1, dn1 - up1) : vec2(rt2 - lf2, dn2 - up2); // наружу от края — туда, где пусто
        vec2 dir = vec2(0.0);
        for (int i = 0; i < 16; i++) {
          if (float(i) >= uCount) break;
          vec4 S = uLights[i];
          vec2 d = S.xy - cell;
          float dist = length(d);
          if (dist >= S.z || dist < 0.001) continue;
          float f = 1.0 - (dist * dist) / (S.z * S.z);
          dir += d / dist * S.w * f * f / (1.0 + (dist * dist) / (uCore * uCore));
        }
        float facing = 1.0; // тонкое (пусто с обеих сторон) — край светится целиком
        if (length(n) > 0.1 && length(dir) > 0.001) facing = smoothstep(-0.15, 0.6, dot(normalize(n), normalize(dir)));
        c += L * (0.7 + 0.5 * own) * uRim * facing * edge * k;
      }
    }
  } else {
    c = texture(uLight, smoothUv).rgb * uAir;
  }
  c += texture(uFx2, smoothUv).rgb * pulse;                    // блум
  c += uHaloColor * texture(uLight, smoothUv).a * uHalo * pulse; // ореол светящихся пикселей
  finalColor = vec4(c, 0.0);
}
`;

const SHADOW_SHIFT = 2; // px арта: тень чуть смещена вправо (свет — слева)
const SHADOW_REACH = 44; // px арта: выше этого существо тень не даёт
const SHADOW_SMALL = 1.0; // густота тени мелких предметов (транзисторов): среднее по площади — как у героя, но без точек под тонкими ножками
const SPIDER_MARK = 0.75; // прозрачность пауков в текстуре существ: отметка «может отбросить тень на потолок и стены»
const SMALL_MARK = 0.55; // прозрачность мелких предметов в ней же: отметка «тень слабее»
const SHADOW_STRENGTH = 0.85; // насколько тень гасит пол под собой (включая свет)
const SHADOW_COLOR = [0.0, 0.01, 0.04];

// Светятся только пиксели этих цветов (RGB 0..255): самые светлые фиолетовые — глаза и яркие метки мобов (паук, паучиха, червяк). До трёх цветов.
// Спрайт, в рисунке которого они есть, сам становится источником света.
const EMISSIVE_COLORS: number[][] = [[0xc0, 0x95, 0xfc], [0x96, 0x67, 0xf2]]; // глаза паука и метки паучихи; кристаллы червяка
const emissiveUniform = (i: number) => new Float32Array((EMISSIVE_COLORS[i] ?? [-255, -255, -255]).map((v) => v / 255));

const GREEN = [0.2, 1.0, 0.55];
const FOG = [0.169 * 0.3, 0.839 * 0.3, 0.451 * 0.3]; // туман у земли: цвет 0x2bd673 с силой 0.3

const NEON_BOOST = 1.3; // во сколько раз неоновые пиксели ярче нарисованных (оттенок тот же)

// ---- Свет жуков
const MAX_LIGHTS = 16; // столько источников обрабатывает шейдер (ближние к экрану и самые сильные)
const LIGHT_COLOR = [0.78, 0.42, 1.0]; // цвет света от светящихся пикселей (насыщеннее самих пикселей)
const LIGHT_RADIUS = 84; // px арта: дальше свет не достаёт (у группы из одного пикселя; крупнее группа — дальше)
const LIGHT_BASE = 0.55; // сила света группы светящихся пикселей...
const LIGHT_PER_PIXEL = 0.09; // ...плюс за каждый её пиксель
const LIGHT_MAX = 1.5;
const ROOT_MAX = 1.8; // общая сила источников одного моба на один источник; у моба с многими источниками (паучиха, червяк) — × корень из их числа: длинный червяк светит заметно, но не засвечивает всё вокруг
const MERGE_DIST = 10; // px арта: источники ближе этого сливаются в один (меньше источников — дешевле, и они не «перескакивают»)
const LIGHT_CORE = 17; // px арта: ядро спада (ближе — почти ровно ярко, дальше — как обратный квадрат)
const LIGHT_PEN = 5; // px арта: на сколько свет заходит в тайл с освещённой стороны
const CLUSTER_DIST = 5; // px рисунка: светящиеся пиксели ближе этого — одна группа (один источник)
const CLUSTERS_PER_SPRITE = 6;
const DIFFUSE = 0.5; // заливка предмета (слабая, главное — кромка): цвет предмета × свет...
const FLAT = 0.12; // ...плюс немного чистого цвета света (окрашивание)
const ON_CASTER = 0.6; // на самих светящихся мобах свет слабее (жук не заливается своим же светом, но его тело вокруг светящихся мест подсвечено)
const RIM = 1.5; // контровая кромка от света жуков на краях, повёрнутых к нему
const EMITTER_MARK = 0.85; // прозрачность светящихся мобов (кроме пауков) в текстуре существ: отметка «свет на нём слабее»
const AIR = 0.2; // свет на фоне и в воздухе
const BLOOM = 0.15; // небольшой блум вокруг источников (центров групп)
const HALO = 0.6; // ореол вокруг самих светящихся пикселей
const HALO_COLOR = [0.72, 0.42, 1.0];
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

type Uniforms = Record<string, { value: unknown; type: string; size?: number }>;

/** Проход на сетке арта: полноэкранный квад в текстуру размером с сетку, шейдер читает другие слои сетки. */
class ArtPass {
  private readonly root = new Container();
  private readonly quad = new Sprite(Texture.WHITE);
  public readonly filter: Filter;

  constructor(fragment: string, name: string, w: number, h: number, uniforms: Uniforms, resources: Record<string, unknown>) {
    this.quad.width = w;
    this.quad.height = h;
    this.root.addChild(this.quad);
    this.filter = makeFilter(fragment, name, uniforms, resources);
    this.quad.filters = [this.filter];
  }

  /** Униформы фильтра (изменённые на месте массивы помечаются вызовом touch()). */
  public get u(): Record<string, unknown> {
    return this.filter.resources.u.uniforms;
  }

  public touch(): void {
    this.filter.resources.u.update();
  }

  public run(renderer: Renderer, target: RenderTexture): void {
    renderer.render({ container: this.root, target, clear: true, clearColor: [0, 0, 0, 0] });
  }

  public destroy(): void {
    this.quad.filters = [];
    this.filter.destroy();
    this.root.destroy({ children: true });
  }
}

export class Lighting {
  /**
   * Сцена мира (до цветокоррекции): спрайт с текстурой мира и фильтром кромки/теней/тумана. Заменяет собой слой мира на экране —
   * сам слой мира в сцену не добавляется, он рисуется только в текстуру (один раз за кадр).
   */
  public readonly sceneView = new Sprite();
  /** Поверх откорректированного кадра, под интерфейсом: свет жуков, неоновые пиксели, блум и ореол (цветокоррекция их не трогает). */
  public readonly overlay = new Container();

  private worldRT: RenderTexture | null = null; // весь мир, физическое разрешение
  private casterRT: RenderTexture | null = null; // только существа, физическое разрешение
  private groundA: RenderTexture | null = null; // тайлы на сетке арта
  private worldA: RenderTexture | null = null; // сжатый мир и существа (см. шапку)
  private fxRT: RenderTexture | null = null; // тень
  private lightRT: RenderTexture | null = null; // свет жуков и ореол
  private fx2RT: RenderTexture | null = null; // блум
  private down: ArtPass | null = null;
  private shadow: ArtPass | null = null;
  private light: ArtPass | null = null;
  private bloom: ArtPass | null = null;
  private scene: Filter | null = null;
  private glow: Filter | null = null;
  private readonly glowSprite = new Sprite(); // итог света жуков поверх кадра
  private readonly lightData = new Float32Array(MAX_LIGHTS * 4);
  private readonly colorData = new Float32Array(MAX_LIGHTS * 4);
  private readonly frac = new Float32Array(2); // дробная часть положения камеры, пиксели арта
  private scale = 1;
  private viewW = 480;
  private viewH = 270;
  private readonly matrix = new Matrix();
  private readonly artMatrix = new Matrix();
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
    this.overlay.addChild(this.glowSprite);
    for (let i = 0; i < MAX_LIGHTS; i++) this.colorData.set(LIGHT_COLOR, i * 4);
  }

  /** physW/physH — размер холста в физических пикселях, scale — физических пикселей на пиксель арта. */
  public resize(physW: number, physH: number, scale: number): void {
    this.scale = scale;
    this.viewW = physW / scale;
    this.viewH = physH / scale;
    for (const rt of [this.worldRT, this.casterRT, this.groundA, this.worldA, this.fxRT, this.lightRT, this.fx2RT]) rt?.destroy(true);
    for (const p of [this.down, this.shadow, this.light, this.bloom]) p?.destroy();
    this.scene?.destroy();
    this.glow?.destroy();

    const aw = Math.ceil(this.viewW) + 2; // сетка арта: экран + клетка запаса с каждой стороны (дробный сдвиг камеры)
    const ah = Math.ceil(this.viewH) + 2;
    const mk = (w: number, h: number, mode: 'nearest' | 'linear') => RenderTexture.create({ width: w, height: h, resolution: 1, scaleMode: mode });
    this.worldRT = mk(physW, physH, 'nearest');
    this.casterRT = mk(physW, physH, 'nearest');
    this.groundA = mk(aw, ah, 'nearest');
    this.worldA = mk(aw, ah, 'nearest');
    this.fxRT = mk(aw, ah, 'nearest');
    this.lightRT = mk(aw, ah, 'linear');
    this.fx2RT = mk(aw, ah, 'linear');

    const e = (i: number) => ({ value: emissiveUniform(i), type: 'vec3<f32>' });
    const frac = { value: this.frac, type: 'vec2<f32>' };
    const lights = { value: this.lightData, type: 'vec4<f32>', size: MAX_LIGHTS };
    const colors = { value: this.colorData, type: 'vec4<f32>', size: MAX_LIGHTS };
    const f1 = (v: number) => ({ value: v, type: 'f32' });

    this.down = new ArtPass(DOWN_FRAGMENT, 'light-down', aw, ah, {
      uPhys: { value: new Float32Array([physW, physH]), type: 'vec2<f32>' }, uFrac: frac, uScale: f1(scale), uE0: e(0), uE1: e(1), uE2: e(2)
    }, { uWorld: this.worldRT.source, uCaster: this.casterRT.source });
    const inv = { value: new Float32Array([1 / aw, 1 / ah]), type: 'vec2<f32>' };
    this.shadow = new ArtPass(SHADOW_FRAGMENT, 'light-shadow', aw, ah, {
      uInvArt: inv, uShift: f1(SHADOW_SHIFT), uSmall: f1(SHADOW_SMALL), uReach: f1(SHADOW_REACH), uStrength: f1(SHADOW_STRENGTH)
    }, { uWorldA: this.worldA.source, uGroundA: this.groundA.source });
    this.light = new ArtPass(LIGHT_FRAGMENT, 'light-bugs', aw, ah, {
      uInvArt: inv, uLights: lights, uColors: colors, uCount: f1(0), uCore: f1(LIGHT_CORE), uPen: f1(LIGHT_PEN)
    }, { uGroundA: this.groundA.source, uWorldA: this.worldA.source });
    this.bloom = new ArtPass(BLOOM_FRAGMENT, 'light-bloom', aw, ah, {
      uLights: lights, uColors: colors, uCount: f1(0), uBloom: f1(BLOOM), uBloomR: f1(BLOOM_RADIUS)
    }, {});

    // сцена мира: спрайт с текстурой мира на весь экран (сцена масштабируется на scale — на экране текстура 1:1)
    this.sceneView.texture = this.worldRT;
    this.sceneView.scale.set(1 / scale);
    this.scene = makeFilter(SCENE_FRAGMENT, 'light-scene', {
      uScale: f1(scale), uFrac: frac, uArtSize: { value: new Float32Array([aw, ah]), type: 'vec2<f32>' }, uRim: f1(0.5), uAmbient: f1(0.09),
      uRimColor: { value: new Float32Array(GREEN), type: 'vec3<f32>' }, uShadowColor: { value: new Float32Array(SHADOW_COLOR), type: 'vec3<f32>' },
      uFog: { value: new Float32Array(FOG), type: 'vec3<f32>' }
    }, { uFx: this.fxRT.source, uCaster: this.casterRT.source, uGroundA: this.groundA.source });
    this.sceneView.filters = [this.scene];

    // свет жуков поверх кадра
    this.glowSprite.texture = this.worldRT;
    this.glowSprite.scale.set(1 / scale);
    this.glow = makeFilter(GLOW_FRAGMENT, 'light-glow', {
      uScale: f1(scale), uFrac: frac, uArtSize: { value: new Float32Array([aw, ah]), type: 'vec2<f32>' }, uTime: f1(0), uBoost: f1(NEON_BOOST),
      uLights: lights, uCount: f1(0), uCore: f1(LIGHT_CORE), uRim: f1(RIM), uE0: e(0), uE1: e(1), uE2: e(2), uDiffuse: f1(DIFFUSE), uFlat: f1(FLAT), uOnCaster: f1(ON_CASTER), uAir: f1(AIR), uHalo: f1(HALO),
      uHaloColor: { value: new Float32Array(HALO_COLOR), type: 'vec3<f32>' }
    }, { uLight: this.lightRT.source, uFx2: this.fx2RT.source, uCaster: this.casterRT.source, uGroundA: this.groundA.source });
    this.glowSprite.filters = [this.glow];
  }

  /** Источники света: группы светящихся пикселей в спрайтах мобов; координаты — клетки сетки арта (мир минус целый сдвиг камеры). */
  private collectLights(): Light[] {
    const lights: Light[] = [];
    const power = (n: number) => Math.min(LIGHT_MAX, LIGHT_BASE + LIGHT_PER_PIXEL * n);
    // слой мира не в сцене: глобальная матрица — в пикселях арта на экране (мир + сдвиг камеры), без масштаба сцены
    const add = (m: Matrix, alpha: number, lx: number, ly: number, n: number) => {
      const size = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); // масштаб объекта (паучки меньше)
      const x = m.a * lx + m.c * ly + m.tx;
      const y = m.b * lx + m.d * ly + m.ty;
      const i = power(n) * size * alpha;
      const r = LIGHT_RADIUS * Math.sqrt(size) * (0.85 + 0.15 * Math.min(4, n) / 2);
      // за пределами экрана дальше радиуса — не светит на видимое
      if (x < -r || y < -r || x > this.viewW + r || y > this.viewH + r || i <= 0.01) return;
      lights.push({ x: x + this.frac[0], y: y + this.frac[1], r, i });
    };
    const visit = (c: Container) => {
      if (!c.visible || c.alpha <= 0) return;
      if (c instanceof Sprite) {
        const clusters = emissiveClusters(c.texture);
        if (clusters.length) {
          const m = c.getGlobalTransform(this.tmp, false);
          const alpha = c.getGlobalAlpha(false);
          const ax = c.anchor.x * c.texture.orig.width;
          const ay = c.anchor.y * c.texture.orig.height;
          for (const k of clusters) add(m, alpha, k.x - ax, k.y - ay, k.n);
        }
      } else if (c instanceof Mesh) {
        const pts = meshPoints(c);
        if (pts.length) {
          const m = c.getGlobalTransform(this.tmp, false);
          const alpha = c.getGlobalAlpha(false);
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
    const all: Light[] = [];
    for (const e of this.emitters()) {
      lights.length = 0;
      visit(e);
      // все источники одного моба вместе — не сильнее ROOT_MAX × √(число источников)
      const total = lights.reduce((sum, l) => sum + l.i, 0);
      const cap = ROOT_MAX * Math.sqrt(Math.max(1, lights.length));
      const k = total > cap ? cap / total : 1;
      for (const l of lights) all.push({ ...l, i: l.i * k });
    }
    // близкие источники сливаются в один (центр — средневзвешенный, сила — сумма)
    all.sort((a, b) => b.i - a.i);
    const merged: Light[] = [];
    for (const l of all) {
      const m = merged.find((q) => Math.hypot(q.x - l.x, q.y - l.y) < MERGE_DIST);
      if (!m) { merged.push({ ...l }); continue; }
      const sum = m.i + l.i;
      m.x = (m.x * m.i + l.x * l.i) / sum;
      m.y = (m.y * m.i + l.y * l.i) / sum;
      m.i = Math.min(LIGHT_MAX, sum);
      m.r = Math.max(m.r, l.r);
    }
    if (merged.length > MAX_LIGHTS) merged.length = MAX_LIGHTS; // самые сильные
    return merged;
  }

  /** Раз в кадр после обновления камеры (до отрисовки сцены). */
  public update(): void {
    const { worldRT, casterRT, groundA, worldA, fxRT, lightRT, fx2RT, down, shadow, light, bloom } = this;
    if (!worldRT || !casterRT || !groundA || !worldA || !fxRT || !lightRT || !fx2RT || !down || !shadow || !light || !bloom) return;
    const s = this.scale;
    const wx = this.world.x;
    const wy = this.world.y;
    // сетка арта привязана к миру: целая часть сдвига камеры — начало сетки, дробная — сдвиг при выводе на экран
    const ix0 = Math.floor(-wx);
    const iy0 = Math.floor(-wy);
    this.frac[0] = -wx - ix0;
    this.frac[1] = -wy - iy0;

    // 1. мир -> текстура с тем же преобразованием, что и на экране (сцена × камера); на экран он выводится уже из неё
    this.matrix.set(s, 0, 0, s, wx * s, wy * s);
    this.renderer.render({
      container: this.world, target: worldRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
    });

    // 2. только существа -> текстура (скрываем всё, что тени не отбрасывает)
    // вид существа кодируется прозрачностью (шейдер читает её): пауки — SPIDER_MARK, мелкие предметы — SMALL_MARK
    const hidden = this.noCasters.filter((c) => c.visible);
    for (const c of hidden) c.visible = false;
    const spiders = this.spiders();
    const saved = spiders.map((c) => c.alpha);
    for (const c of spiders) c.alpha = SPIDER_MARK;
    const spiderSet = new Set(spiders);
    const glowing = this.emitters().filter((c) => !spiderSet.has(c));
    const savedGlow = glowing.map((c) => c.alpha);
    for (const c of glowing) c.alpha *= EMITTER_MARK;
    const savedSmall = this.small.map((c) => c.alpha);
    for (const c of this.small) c.alpha = SMALL_MARK;
    this.renderer.render({
      container: this.world, target: casterRT, clear: true, clearColor: [0, 0, 0, 0], transform: this.matrix
    });
    spiders.forEach((c, i) => { c.alpha = saved[i]; });
    glowing.forEach((c, i) => { c.alpha = savedGlow[i]; });
    this.small.forEach((c, i) => { c.alpha = savedSmall[i]; });
    for (const c of hidden) c.visible = true;

    // 3. только тайлы -> сетка арта (прямо в её разрешении: тайлы стоят на целых пикселях арта, видимые чанки)
    if (this.ground) {
      this.artMatrix.set(1, 0, 0, 1, -ix0, -iy0);
      this.renderer.render({
        container: this.ground, target: groundA, clear: true, clearColor: [0, 0, 0, 0], transform: this.artMatrix
      });
    }

    // 4. свет жуков: источники -> униформы
    const lights = this.collectLights();
    this.lightData.fill(0);
    lights.forEach((l, i) => this.lightData.set([l.x, l.y, l.r, l.i], i * 4));
    for (const p of [light, bloom]) p.u.uCount = lights.length;
    this.glow!.resources.u.uniforms.uCount = lights.length;
    this.glow!.resources.u.uniforms.uTime = performance.now() / 1000; // неон пульсирует
    for (const p of [down, shadow, light, bloom]) p.touch();
    this.scene!.resources.u.update();
    this.glow!.resources.u.update();

    // 5. проходы на сетке арта (в scale² раз меньше пикселей, чем на экране)
    down.run(this.renderer, worldA);
    shadow.run(this.renderer, fxRT);
    light.run(this.renderer, lightRT);
    bloom.run(this.renderer, fx2RT);
  }
}
