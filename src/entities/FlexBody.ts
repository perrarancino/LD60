import { Container, Mesh, MeshGeometry, Texture } from 'pixi.js';

const SAMPLES = 48; // точек таблицы изогнутой оси лапки
const ANCHOR_RAMP = 6; // px: на таком расстоянии от корня вес изгиба нарастает от 0 до 1 (лапка «врастает» в тело)

export interface LimbSpec {
  mask: ImageData; // холст целиком: непрозрачные пиксели — пиксели этой лапки
  root: { x: number; y: number }; // корень лапки на холсте
  bones: number; // число костей в цепочке
}

interface Limb {
  bones: number;
  length: number; // длина оси корень -> кончик, px
  axis: number; // угол оси, y вниз
  rootX: number;
  rootY: number;
  vertices: number[]; // индексы вершин, которые ведёт эта лапка
  t: Float32Array; // координата вдоль оси (в покое)
  d: Float32Array; // смещение поперёк оси (в покое)
  w: Float32Array; // вес лапки у вершины: 0 у корня (вершина закреплена на теле), 1 дальше
  tx: Float32Array; // таблица изогнутой оси: точка и угол
  ty: Float32Array;
  ta: Float32Array;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Тело и лапки существа — ОДНА сетка (вершина на каждый угол пикселя) со скиннингом. Пиксели рисунка делят вершины, поэтому ничего
 * не рвётся: ни пиксели внутри лапки, ни стык лапки с телом. Вершины лапки ведёт цепочка костей вдоль оси «корень -> кончик»
 * (углы соседних костей плавно смешиваются), а вес изгиба у корня плавно падает до нуля — основание лапки остаётся
 * приклеенным к телу. Вершины тела не двигаются. Без изгиба сетка в точности повторяет исходный рисунок.
 */
export class FlexBody {
  /** Начало координат — точка холста origin; сетка лежит в системе контейнера. */
  public readonly container = new Container();

  private readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly rest: Float32Array; // положение вершин в покое (относительно origin)
  private readonly limbs: Limb[] = [];

  /**
   * @param image пиксели полного рисунка
   * @param texture его текстура (холст целиком)
   * @param limbs лапки (маски и корни)
   * @param origin точка холста, которая оказывается в начале контейнера
   */
  constructor(image: ImageData, texture: Texture, limbs: LimbSpec[], origin: { x: number; y: number }) {
    const { data, width, height } = image;

    // Какой лапке принадлежит пиксель (-1 — телу)
    const owner = new Int16Array(width * height).fill(-1);
    limbs.forEach((l, k) => {
      for (let i = 0; i < width * height; i++) {
        if (l.mask.data[i * 4 + 3] > 0 && data[i * 4 + 3] > 0 && owner[i] < 0) owner[i] = k;
      }
    });

    // Границы непрозрачной области
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) throw new Error('[FlexBody] рисунок пустой');

    // Сетка вершин по углам пикселей
    const gw = maxX - minX + 2;
    const gh = maxY - minY + 2;
    const vcount = gw * gh;
    this.positions = new Float32Array(vcount * 2);
    this.rest = new Float32Array(vcount * 2);
    const uvs = new Float32Array(vcount * 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        const cx = minX + i;
        const cy = minY + j;
        uvs[k * 2] = cx / width;
        uvs[k * 2 + 1] = cy / height;
        this.rest[k * 2] = this.positions[k * 2] = cx - origin.x;
        this.rest[k * 2 + 1] = this.positions[k * 2 + 1] = cy - origin.y;
      }
    }

    // Треугольники — только на непрозрачных пикселях
    const idx: number[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        const a = (y - minY) * gw + (x - minX);
        const b = a + 1;
        const c = a + gw;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }

    // Вершину ведёт лапка, если рядом с ней есть пиксель этой лапки (стык лапки с телом — тоже лапкин, но с весом ~0)
    const vOwner = new Int16Array(vcount).fill(-1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const o = owner[y * width + x];
        if (o < 0) continue;
        const a = (y - minY) * gw + (x - minX);
        for (const v of [a, a + 1, a + gw, a + gw + 1]) if (vOwner[v] < 0) vOwner[v] = o;
      }
    }

    limbs.forEach((l, k) => {
      // Кончик — самый дальний от корня пиксель лапки
      let best = -1;
      let tipX = l.root.x;
      let tipY = l.root.y;
      for (let i = 0; i < width * height; i++) {
        if (owner[i] !== k) continue;
        const x = i % width;
        const y = (i - x) / width;
        const dist = Math.hypot(x + 0.5 - l.root.x, y + 0.5 - l.root.y);
        if (dist > best) {
          best = dist;
          tipX = x + 0.5;
          tipY = y + 0.5;
        }
      }
      if (best <= 0) throw new Error(`[FlexBody] лапка ${k} пустая`);
      const ux = (tipX - l.root.x) / best;
      const uy = (tipY - l.root.y) / best;
      const ramp = Math.min(ANCHOR_RAMP, best * 0.4);

      const vertices: number[] = [];
      for (let v = 0; v < vcount; v++) if (vOwner[v] === k) vertices.push(v);
      const t = new Float32Array(vertices.length);
      const d = new Float32Array(vertices.length);
      const w = new Float32Array(vertices.length);
      vertices.forEach((v, n) => {
        const rx = this.rest[v * 2] + origin.x - l.root.x;
        const ry = this.rest[v * 2 + 1] + origin.y - l.root.y;
        t[n] = rx * ux + ry * uy;
        d[n] = -rx * uy + ry * ux;
        w[n] = smooth(Math.min(Math.max(t[n] / ramp, 0), 1));
      });
      this.limbs.push({
        bones: Math.max(2, Math.round(l.bones)),
        length: best,
        axis: Math.atan2(uy, ux),
        rootX: l.root.x - origin.x,
        rootY: l.root.y - origin.y,
        vertices, t, d, w,
        tx: new Float32Array(SAMPLES + 1),
        ty: new Float32Array(SAMPLES + 1),
        ta: new Float32Array(SAMPLES + 1)
      });
    });

    const geometry = new MeshGeometry({ positions: this.positions, uvs, indices: new Uint32Array(idx) });
    this.mesh = new Mesh({ geometry, texture });
    this.container.addChild(this.mesh);
  }

  public get limbCount(): number {
    return this.limbs.length;
  }

  /**
   * Поза лапки через углы костей (рад, относительно покоя): bone j охватывает отрезок оси [j, j+1] / bones.
   * Угол оси в точке получается плавным смешиванием углов соседних костей. Сетка обновляется сразу.
   */
  public setBoneAngles(limb: number, angles: number[]): void {
    const L = this.limbs[limb];
    const n = L.bones;
    const ds = L.length / SAMPLES;
    let x = 0;
    let y = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const f = (i * ds) / L.length; // 0..1 вдоль оси
      const g = Math.min(Math.max(f * n - 0.5, 0), n - 1); // между центрами костей
      const j = Math.min(Math.floor(g), n - 2);
      const w = g - j;
      const theta = L.axis + angles[j] * (1 - w) + angles[j + 1] * w;
      L.tx[i] = x;
      L.ty[i] = y;
      L.ta[i] = theta;
      x += Math.cos(theta) * ds;
      y += Math.sin(theta) * ds;
    }

    const p = this.positions;
    for (let m = 0; m < L.vertices.length; m++) {
      const v = L.vertices[m];
      const t = L.t[m];
      const s = Math.min(Math.max(t, 0), L.length); // за пределами оси продолжаем по касательной
      const f = (s / L.length) * SAMPLES;
      const i = Math.min(Math.floor(f), SAMPLES - 1);
      const w = f - i;
      const cx = L.tx[i] * (1 - w) + L.tx[i + 1] * w;
      const cy = L.ty[i] * (1 - w) + L.ty[i + 1] * w;
      const th = L.ta[i] * (1 - w) + L.ta[i + 1] * w;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const extra = t - s;
      const d = L.d[m];
      const bx = L.rootX + cx + c * extra - sn * d; // положение вершины на изогнутой лапке
      const by = L.rootY + cy + sn * extra + c * d;
      // вес гасит изгиб у корня: там вершина остаётся на месте (приклеена к телу)
      p[v * 2] = this.rest[v * 2] + (bx - this.rest[v * 2]) * L.w[m];
      p[v * 2 + 1] = this.rest[v * 2 + 1] + (by - this.rest[v * 2 + 1]) * L.w[m];
    }
  }

  /** Угол оси лапки (корень -> кончик) в покое, рад, y вниз. */
  public limbAxis(limb: number): number {
    return this.limbs[limb].axis;
  }

  /** Поза проще: поворот у корня и суммарный изгиб к кончику (растёт равномерно по длине). */
  public setPose(limb: number, rootAngle: number, bend: number): void {
    const n = this.limbs[limb].bones;
    const angles: number[] = [];
    for (let j = 0; j < n; j++) angles.push(rootAngle + bend * ((j + 0.5) / n));
    this.setBoneAngles(limb, angles);
  }

  /** Отправляет новые положения вершин на видеокарту (вызывать раз за кадр после setPose). */
  public commit(): void {
    this.mesh.geometry.getBuffer('aPosition').update();
  }
}
