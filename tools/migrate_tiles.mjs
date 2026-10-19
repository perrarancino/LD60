// Одноразовая миграция уровней: старые «умные» тайлы (platform_block — край/середина/заливка по соседям, textalite — верх/толща по хэшу клетки)
// превращаются в явные тайлы по кадрам: в каждой клетке хранится ровно тот тайл, что игра рисовала раньше. Вид уровня не меняется.
//   node tools/migrate_tiles.mjs
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../data/levels/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOLID = new Set(['platform_block', 'textalite', 'tileset1', 'tileset2', 'tileset3', 'tileset4', 'tile1', 'loc2', 'doptileset', 'platform_block_single', 'platform_slope_ur', 'platform_slope_ul', 'platform_slope_cr', 'platform_slope_cl', 'step']);
const CHARS = '#@%&$ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const full = path.join(dir, file);
  const raw = fs.readFileSync(full, 'utf8');
  const def = JSON.parse(raw);
  const idAt = (x, y) => (x < 0 || y < 0 || x >= def.width || y >= def.height ? null : def.legend[def.rows[y][x]] ?? null);
  const solidAt = (x, y) => SOLID.has(idAt(x, y));
  if (![...Object.values(def.legend)].some((v) => v === 'platform_block' || v === 'textalite')) continue;
  const out = [];
  for (let y = 0; y < def.height; y++) {
    const row = [];
    for (let x = 0; x < def.width; x++) {
      const id = idAt(x, y);
      const under = y > 0 && solidAt(x, y - 1);
      if (id === 'textalite') {
        const pool = under ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
        row.push(`textalite_${pool[(((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % pool.length)]}`);
      } else if (id === 'platform_block') {
        if (under) row.push('doptileset');
        else {
          const left = idAt(x - 1, y) === 'platform_block';
          const right = idAt(x + 1, y) === 'platform_block';
          row.push(`platform_loop_${left && right ? 1 : right ? 0 : left ? 2 : 1}`);
        }
      } else row.push(id);
    }
    out.push(row);
  }
  const legend = { '.': null };
  const charOf = new Map();
  const rows = out.map((row) => row.map((id) => {
    if (id === null) return '.';
    if (!charOf.has(id)) {
      const ch = [...CHARS].find((c) => !(c in legend));
      legend[ch] = id;
      charOf.set(id, ch);
    }
    return charOf.get(id);
  }).join(''));
  def.legend = legend;
  def.rows = rows;
  const crlf = raw.includes('\r\n');
  const text = JSON.stringify(def, null, 2) + '\n';
  fs.writeFileSync(full, crlf ? text.replace(/\n/g, '\r\n') : text);
  console.log(`${file}: ${Object.keys(legend).length - 1} тайлов`);
}
