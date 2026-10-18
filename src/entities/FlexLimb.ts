import { Container, Mesh, MeshGeometry, Texture } from 'pixi.js';

const SAMPLES = 48; // точек таблицы изогнутой оси

/**
 * Лапка со скелетом и скиннингом: рисунок — это ОДНА сетка (по вершине на угол каждого пикселя), которую ведёт цепочка костей
 * вдоль оси «корень -> кончик». Вершины общие у соседних пикселей, поэтому при изгибе поверхность не рвётся: пиксели
 * только растягиваются и сжимаются, между цветами нет щелей. Углы соседних костей плавно смешиваются (линейный скиннинг),
 * ось лапки превращается в гладкую кривую. В позе покоя (все углы 0) сетка в точности повторяет исходный рисунок.
 */
export class FlexLimb {
  /** Начало координат — корень лапки; сетка лежит в системе контейнера. */
  public readonly container = new Container();

  private readonly bones: number;
  private readonly length: number; // длина оси корень -> кончик, px
  private readonly axis: number; // угол оси, y вниз
  private readonly mesh: Mesh;
  private readonly positions: Float32Array;
  // Для каждой вершины: координата вдоль оси t и смещение поперёк оси d (в покое)
  private readonly vt: Float32Array;
  private readonly vd: Float32Array;
  // Таблица изогнутой оси: точка и угол в SAMPLES + 1 местах
  private readonly tx = new Float32Array(SAMPLES + 1);
  private readonly ty = new Float32Array(SAMPLES + 1);
  private readonly ta = new Float32Array(SAMPLES + 1);

  /**
   * @param image пиксели слоя лапки (холст целиком)
   * @param texture текстура этого же слоя (тот же холст)
   * @param root корень лапки в координатах холста
   * @param bones сколько костей в цепочке
   */
  constructor(image: ImageData, texture: Texture, root: { x: number; y: number }, bones: number) {
    this.bones = Math.max(2, Math.round(bones));
    const { data, width, height } = image;

    // Кончик — самый дальний от корня непрозрачный пиксель; границы непрозрачной области
    let tipX = root.x;
    let tipY = root.y;
    let best = -1;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const d = Math.hypot(x + 0.5 - root.x, y + 0.5 - root.y);
        if (d > best) {
          best = d;
          tipX = x + 0.5;
          tipY = y + 0.5;
        }
      }
    }
    if (best <= 0) throw new Error('[FlexLimb] слой лапки пустой');

    const ux = (tipX - root.x) / best;
    const uy = (tipY - root.y) / best;
    this.axis = Math.atan2(uy, ux);
    this.length = best;

    // Сетка вершин по углам пикселей; треугольники — только на непрозрачных пикселях
    const gw = maxX - minX + 2;
    const gh = maxY - minY + 2;
    const vertexCount = gw * gh;
    this.positions = new Float32Array(vertexCount * 2);
    this.vt = new Float32Array(vertexCount);
    this.vd = new Float32Array(vertexCount);
    const uvs = new Float32Array(vertexCount * 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        const cx = minX + i; // координата угла на холсте
        const cy = minY + j;
        uvs[k * 2] = cx / width;
        uvs[k * 2 + 1] = cy / height;
        const rx = cx - root.x;
        const ry = cy - root.y;
        this.vt[k] = rx * ux + ry * uy;
        this.vd[k] = -rx * uy + ry * ux;
      }
    }
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

    const geometry = new MeshGeometry({ positions: this.positions, uvs, indices: new Uint32Array(idx) });
    this.mesh = new Mesh({ geometry, texture });
    this.container.addChild(this.mesh);
    this.setPose(0, 0);
  }

  /**
   * Поза через углы костей (рад, относительно покоя): bone j охватывает отрезок оси [j, j+1] / bones.
   * Угол оси в точке получается плавным смешиванием углов соседних костей.
   */
  public setBoneAngles(angles: number[]): void {
    const n = this.bones;
    const ds = this.length / SAMPLES;
    let x = 0;
    let y = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const f = (i * ds) / this.length; // 0..1 вдоль оси
      // угол оси в точке f: линейная интерполяция между центрами костей
      const g = Math.min(Math.max(f * n - 0.5, 0), n - 1);
      const j = Math.min(Math.floor(g), n - 2);
      const w = g - j;
      const theta = this.axis + angles[j] * (1 - w) + angles[j + 1] * w;
      this.tx[i] = x;
      this.ty[i] = y;
      this.ta[i] = theta;
      x += Math.cos(theta) * ds;
      y += Math.sin(theta) * ds;
    }

    const p = this.positions;
    for (let k = 0; k < this.vt.length; k++) {
      const t = this.vt[k];
      const s = Math.min(Math.max(t, 0), this.length); // за пределами оси продолжаем по касательной
      const f = (s / this.length) * SAMPLES;
      const i = Math.min(Math.floor(f), SAMPLES - 1);
      const w = f - i;
      const cx = this.tx[i] * (1 - w) + this.tx[i + 1] * w;
      const cy = this.ty[i] * (1 - w) + this.ty[i + 1] * w;
      const th = this.ta[i] * (1 - w) + this.ta[i + 1] * w;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const extra = t - s;
      const d = this.vd[k];
      p[k * 2] = cx + c * extra - sn * d;
      p[k * 2 + 1] = cy + sn * extra + c * d;
    }
    this.mesh.geometry.getBuffer('aPosition').update();
  }

  /**
   * @param rootAngle поворот всей лапки у корня, рад
   * @param bend дополнительный изгиб, накопленный к кончику, рад (растёт равномерно по длине)
   */
  public setPose(rootAngle: number, bend: number): void {
    const angles: number[] = [];
    for (let j = 0; j < this.bones; j++) angles.push(rootAngle + bend * ((j + 0.5) / this.bones));
    this.setBoneAngles(angles);
  }
}
