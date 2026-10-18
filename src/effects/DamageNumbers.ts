import { Container, Text, TextStyle } from 'pixi.js';

/**
 * Сочные цифры урона пиксельным шрифтом uvKits (assets/fonts/uvKits.ttf): выскакивают с перелётом по размеру, вспыхивают белым,
 * летят дугой вверх-в сторону удара и падают, гаснут в конце. Критический удар — крупнее, золотой, дрожит и живёт дольше.
 * Шрифт нарисован по сетке 16 пикселей на кегль (цифры — 8 пикселей): размер 16 — пиксель шрифта = пиксель арта, 32 — вдвое крупнее.
 * Текст рисуется в разрешении арта и увеличивается без сглаживания — пиксели шрифта чёткие.
 */

const FONT_FAMILY = 'uvKits';
const FONT_URL = new URL('../../assets/fonts/uvKits.ttf', import.meta.url).href;

const LIFE = 0.85; // с
const CRIT_LIFE = 1.1;
const GRAVITY = 330; // px/с²
const POP_TIME = 0.07; // с: выскакивание до максимального размера
const SETTLE_TIME = 0.22; // с: пружинит обратно к своему размеру
const FLASH_TIME = 0.06; // с: вспышка белым
const FADE_SHARE = 0.3; // последняя доля жизни — растворяется

const COLOR = 0xf4e9ff; // обычный урон
const CRIT_COLOR = 0xffd23f; // критический
const OUTLINE = 0x1a0b2e;

interface Num {
  text: Text;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  pop: number; // максимальный размер при выскакивании
  rot: number;
  color: number;
  crit: boolean;
}

let fontReady: Promise<void> | null = null;

/** Загружает шрифт цифр (один раз). Цифры можно создавать и раньше — они перерисуются, когда шрифт загрузится. */
export function loadDamageFont(): Promise<void> {
  if (!fontReady) {
    const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
    fontReady = face.load().then((f) => { document.fonts.add(f); }).catch((e) => console.warn('[DamageNumbers] шрифт не загрузился', e));
  }
  return fontReady;
}

const makeStyle = (size: number) => new TextStyle({
  fontFamily: FONT_FAMILY,
  fontSize: size,
  fill: 0xffffff, // цвет задаёт tint (вспышка белым -> свой цвет)
  stroke: { color: OUTLINE, width: size / 8, join: 'miter' }, // обводка в пиксель шрифта
  dropShadow: { color: OUTLINE, alpha: 1, angle: Math.PI / 2, distance: size / 16, blur: 0 },
  padding: 4
});

export class DamageNumbers {
  /** Слой цифр в мировых координатах: main двигает его вместе с камерой. Лежит поверх цветокоррекции и света. */
  public readonly container = new Container();
  private readonly nums: Num[] = [];
  private readonly style = makeStyle(16);
  private readonly critStyle = makeStyle(32);

  /** Цифра урона в точке (x, y) мира; dirX — направление удара по горизонтали (цифра отлетает туда). */
  public spawn(x: number, y: number, value: number, crit = false, dirX = 0): void {
    const text = new Text({
      text: String(value), style: crit ? this.critStyle : this.style, resolution: 1, textureStyle: { scaleMode: 'nearest' }
    });
    text.anchor.set(0.5);
    this.container.addChild(text);
    const side = Math.sign(dirX) || (Math.random() < 0.5 ? -1 : 1);
    this.nums.push({
      text, x: x + (Math.random() - 0.5) * 6, y: y - 4,
      vx: side * (25 + Math.random() * 35) + dirX * 20,
      vy: -(crit ? 150 : 115) - Math.random() * 30,
      t: 0, life: crit ? CRIT_LIFE : LIFE, pop: crit ? 1.6 : 1.8,
      rot: (Math.random() - 0.5) * 0.5, color: crit ? CRIT_COLOR : COLOR, crit
    });
  }

  public update(dt: number): void {
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.t += dt;
      if (n.t >= n.life) {
        n.text.destroy();
        this.nums.splice(i, 1);
        continue;
      }
      n.vy += GRAVITY * dt;
      n.vx *= Math.exp(-2.5 * dt);
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      // размер: выскакивает больше своего, затем пружинит к 1, в конце сжимается
      let s: number;
      if (n.t < POP_TIME) {
        s = n.pop * (n.t / POP_TIME);
      } else if (n.t < POP_TIME + SETTLE_TIME) {
        const u = (n.t - POP_TIME) / SETTLE_TIME;
        s = 1 + (n.pop - 1) * Math.exp(-5 * u) * Math.cos(u * Math.PI * 2.5);
      } else {
        s = 1;
      }
      const left = 1 - n.t / n.life;
      if (left < FADE_SHARE) s *= 0.6 + 0.4 * (left / FADE_SHARE);
      // крит дрожит первые мгновения
      const shake = n.crit && n.t < 0.3 ? (1 - n.t / 0.3) * 1.5 : 0;
      // целые пиксели арта — цифры не «плывут» между пикселями
      n.text.position.set(Math.round(n.x + (Math.random() - 0.5) * 2 * shake), Math.round(n.y + (Math.random() - 0.5) * 2 * shake));
      n.text.scale.set(Math.max(0.01, s));
      n.text.rotation = n.rot * Math.max(0, 1 - n.t / 0.25);
      n.text.tint = n.t < FLASH_TIME ? 0xffffff : n.color;
      n.text.alpha = left < FADE_SHARE ? left / FADE_SHARE : 1;
    }
  }
}
