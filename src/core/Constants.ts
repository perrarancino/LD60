export const GAME_CONFIG = {
  // Эталонное разрешение: целый масштаб пикселя = round(высота окна / VIRTUAL_HEIGHT); реальная область обзора
  // зависит от размера окна (см. GameApp.handleResize), графика не растягивается
  VIRTUAL_WIDTH: 480,
  VIRTUAL_HEIGHT: 270,

  // Размер одного тайла уровня в пикселях виртуального разрешения (см. data/tiles/tiles.json)
  TILE_SIZE: 32,

  // Цветовая палитра оформления
  BACKGROUND_COLOR: 0x0e1117,
  ACCENT_CYAN: 0x00f0ff,
  ACCENT_RED: 0xff0055,
  ACCENT_AMBER: 0xffb700,
  TEXT_COLOR: 0xffffff,

  // Базовые параметры кинематики платформера
  GRAVITY: 850,
  PLAYER_SPEED: 130,
  JUMP_FORCE: -420, // высота прыжка ~104px (≈3 тайла) под тайлы 32px и героя 64px
  COYOTE_TIME_SEC: 0.1,
  JUMP_BUFFER_SEC: 0.12,

  // Параметры 5-минутного таймера угасания энергоядра
  TOTAL_LIFETIME_SEC: 300,
  WARNING_THRESHOLD_SEC: 60,
  CRITICAL_THRESHOLD_SEC: 30
} as const;
