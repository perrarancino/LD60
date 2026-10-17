export const GAME_CONFIG = {
  // Virtual retro resolution (16:9 pixel-perfect widescreen)
  VIRTUAL_WIDTH: 480,
  VIRTUAL_HEIGHT: 270,

  // Colors
  BACKGROUND_COLOR: 0x0e1117,
  ACCENT_CYAN: 0x00f0ff,
  ACCENT_RED: 0xff0055,
  ACCENT_AMBER: 0xffb700,
  TEXT_COLOR: 0xffffff,

  // Physics defaults (Platformer feel)
  GRAVITY: 850,
  PLAYER_SPEED: 130,
  JUMP_FORCE: -310,
  COYOTE_TIME_SEC: 0.1,
  JUMP_BUFFER_SEC: 0.12,

  // 5-minute aging system
  TOTAL_LIFETIME_SEC: 300,
  WARNING_THRESHOLD_SEC: 60,
  CRITICAL_THRESHOLD_SEC: 30
} as const;
