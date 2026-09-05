-- Per-user theme: one JSON ThemeConfig (src/lib/theme.ts). NULL = stock frost.
ALTER TABLE users ADD COLUMN theme TEXT;
