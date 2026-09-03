-- Per-game grade, computed from the player's own baseline.
--
-- Stored rather than derived on read so the Games list can sort and chart without rebuilding a
-- baseline per row, and so a grade stays pinned to the analysis version that produced it.
--
-- NULL is meaningful and common: a game is ungraded when the corpus is too thin (under 5 prior
-- games) or too few metrics are scoreable. A grade off two games of history is noise wearing a
-- number, and showing it would be worse than showing nothing.
ALTER TABLE game ADD COLUMN gradeScore INTEGER;
ALTER TABLE game ADD COLUMN gradeRank TEXT;
