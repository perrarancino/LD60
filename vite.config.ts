import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function editorApiPlugin(): Plugin {
  return {
    name: 'ld60-editor-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ? req.url.split('?')[0] : '';

        // 1. Раздача ассетов и спрайтов для редактора
        if (url.startsWith('/ld60-assets/')) {
          const relativeAsset = decodeURIComponent(url.replace('/ld60-assets/', ''));
          let filePath = path.join(__dirname, 'assets', 'sprites', relativeAsset);
          if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, 'assets', relativeAsset);
          }

          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.svg': 'image/svg+xml',
              '.json': 'application/json'
            };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            return fs.createReadStream(filePath).pipe(res);
          } else {
            res.statusCode = 404;
            return res.end(`Asset not found: ${relativeAsset}`);
          }
        }

        // 2. API: Получение конфигураций
        if (url === '/api/ld60/config' && req.method === 'GET') {
          try {
            const dataDir = path.join(__dirname, 'data');
            const tilesFile = path.join(dataDir, 'tiles', 'tiles.json');
            const spritesFile = path.join(dataDir, 'sprites', 'sprites.json');
            const enemiesFile = path.join(dataDir, 'enemies', 'enemies.json');
            const worldFile = path.join(dataDir, 'world', 'world_layout.json');
            const bossesFile = path.join(dataDir, 'bosses', 'bosses.json');
            const backgroundsDir = path.join(dataDir, 'backgrounds');
            const levelsDir = path.join(dataDir, 'levels');

            const tiles = fs.existsSync(tilesFile) ? JSON.parse(fs.readFileSync(tilesFile, 'utf-8')) : null;
            const sprites = fs.existsSync(spritesFile) ? JSON.parse(fs.readFileSync(spritesFile, 'utf-8')) : null;
            const enemies = fs.existsSync(enemiesFile) ? JSON.parse(fs.readFileSync(enemiesFile, 'utf-8')) : [];
            const world = fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf-8')) : null;
            const bosses = fs.existsSync(bossesFile) ? JSON.parse(fs.readFileSync(bossesFile, 'utf-8')) : [];

            const backgrounds: any[] = [];
            if (fs.existsSync(backgroundsDir)) {
              for (const file of fs.readdirSync(backgroundsDir)) {
                if (file.endsWith('.json')) {
                  try {
                    backgrounds.push(JSON.parse(fs.readFileSync(path.join(backgroundsDir, file), 'utf-8')));
                  } catch (e) {
                    console.error(`Error reading background ${file}:`, e);
                  }
                }
              }
            }

            const levels: any[] = [];
            if (fs.existsSync(levelsDir)) {
              for (const file of fs.readdirSync(levelsDir)) {
                if (file.endsWith('.json')) {
                  try {
                    const content = JSON.parse(fs.readFileSync(path.join(levelsDir, file), 'utf-8'));
                    levels.push({ filename: file, data: content });
                  } catch (e) {
                    console.error(`Error reading level ${file}:`, e);
                  }
                }
              }
            }

            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              ld60Path: __dirname,
              tiles,
              sprites,
              enemies,
              bosses,
              world,
              backgrounds,
              levels
            }));
          } catch (err: any) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: err.message }));
          }
        }

        // 3. API: Сохранение уровня
        if (url === '/api/ld60/level/save' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);
              const { filename, level } = payload;
              if (!level || !level.id) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: 'Missing level.id' }));
              }

              const levelsDir = path.join(__dirname, 'data', 'levels');
              if (!fs.existsSync(levelsDir)) {
                fs.mkdirSync(levelsDir, { recursive: true });
              }

              const targetFilename = filename || `${level.id}.json`;
              const filePath = path.join(levelsDir, targetFilename);

              if (!level.$schema) {
                level.$schema = '../schemas/level.schema.json';
              }

              fs.writeFileSync(filePath, JSON.stringify(level, null, 2) + '\n', 'utf-8');

              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ ok: true, filename: targetFilename, path: filePath }));
            } catch (err: any) {
              res.statusCode = 500;
              return res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // 4. API: Сохранение тайлсета
        if (url === '/api/ld60/tiles/save' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);
              const tilesFile = path.join(__dirname, 'data', 'tiles', 'tiles.json');
              if (!payload.tiles || !Array.isArray(payload.tiles)) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: 'Invalid tiles payload' }));
              }

              if (!payload.$schema) payload.$schema = '../schemas/tile.schema.json';
              if (!payload.version) payload.version = '1.0.0';
              if (!payload.tile_size) payload.tile_size = 32;

              fs.writeFileSync(tilesFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ ok: true, tiles: payload }));
            } catch (err: any) {
              res.statusCode = 500;
              return res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [editorApiPlugin()],
  server: {
    port: 3000,
    open: true
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        editor: path.resolve(__dirname, 'editor.html')
      }
    }
  }
});
