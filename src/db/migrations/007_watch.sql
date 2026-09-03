-- The visual pass: what the coach saw in the replay frames for one moment.
--
-- Kept separate from `feedback_item` because it has a different evidential status. Every figure
-- in a feedback item came from the digest and can be checked by the parser; a visual read cannot
-- be checked by anything, because the only evidence is a picture. Storing it apart keeps that
-- distinction visible in the schema instead of relying on everyone remembering it.
CREATE TABLE IF NOT EXISTS watch_note (
	id         TEXT    PRIMARY KEY,
	gameId     INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	momentId   TEXT    NOT NULL,
	text       TEXT    NOT NULL,
	model      TEXT,
	costUsd    REAL,
	/** How many frames the read was based on. Fewer frames, weaker read. */
	frameCount INTEGER NOT NULL DEFAULT 0,
	status     TEXT    NOT NULL DEFAULT 'ok',
	error      TEXT,
	createdMs  INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS watch_note_moment ON watch_note (gameId, momentId);
