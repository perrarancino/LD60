/**
 * Эталонная палитра проекта — OldTech 72 Vivid (assets/palettes/oldtech-vivid-72.gpl, формат GIMP/Aseprite).
 * Все новые цвета (процедурные эффекты, искры, молнии, интерфейс, свет) берутся ТОЛЬКО отсюда: 9 «рамп» по 8 оттенков, от самого тёмного (0)
 * к самому светлому (7, блик). Рисунок мобов второй локации — рампа cobalt; свечение жуков — void; электричество — electric и cobalt.
 *
 * Использование: `pal('cobalt', 5)` -> 0x41bafc для Pixi (Graphics.fill, tint, частицы).
 */
export type Ramp = 'void' | 'steel' | 'pcb' | 'electric' | 'cobalt' | 'virus' | 'plasma' | 'ember' | 'gold';

export const PALETTE_NAME = 'OldTech 72 Vivid';

/** Рампы: от тёмного (0) к светлому (7, блик), цвета 0xRRGGBB. */
export const RAMPS: Record<Ramp, readonly number[]> = {
  void: [0x0a0427, 0x250b67, 0x471ba7, 0x6b44cd, 0x9667f2, 0xc095fc, 0xe0bdfb, 0xf8ddff],
  steel: [0x020c17, 0x12283b, 0x30485c, 0x50697f, 0x738da3, 0x97b2c9, 0xb6d2ea, 0xd5ebff],
  pcb: [0x020e0b, 0x062e24, 0x05523a, 0x007a4b, 0x00a452, 0x22d04c, 0x56f436, 0xb9ff97],
  electric: [0x020d13, 0x062b36, 0x054d5d, 0x007384, 0x009baa, 0x22c5cd, 0x3de9e6, 0x91fff1],
  cobalt: [0x010a20, 0x042453, 0x044387, 0x0067b7, 0x0090e2, 0x41bafc, 0x8fdafb, 0xc1f1ff],
  virus: [0x110320, 0x350857, 0x620792, 0x9600ca, 0xd00df8, 0xf76bfc, 0xfbb2eb, 0xffddef],
  plasma: [0x190211, 0x460731, 0x7c0650, 0xb8006a, 0xf7007f, 0xfc829d, 0xfbbabf, 0xffdfde],
  ember: [0x1a0209, 0x4a071c, 0x830628, 0xc00027, 0xff0b08, 0xfc896b, 0xfbbda6, 0xffe1d2],
  gold: [0x1b0302, 0x431704, 0x6a3504, 0x905700, 0xb77c00, 0xdda31c, 0xfbc53d, 0xffe5aa],
};

/** Цвет палитры по рампе и оттенку (0..7). */
export function pal(ramp: Ramp, shade: number): number {
  return RAMPS[ramp][shade];
}
