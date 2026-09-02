-- coachskaffur schema v1.
--
-- Conventions, all deliberate:
--   * Column names are camelCase and match the domain types in src/shared/schema/domain.ts
--     exactly, so a SQLite row maps to a domain object with no renaming layer to drift.
--   * Every table is STRICT: SQLite enforces the declared types instead of coercing.
--     There is no BOOLEAN type, so booleans are INTEGER 0/1 and are converted at the edges
--     in queries.ts. node:sqlite refuses to bind a JS boolean at all, which keeps us honest.
--   * Large payloads (timelines are 112 KB, clips are megabytes) live on disk, not here.
--     Rows carry the relative path; blobs.ts owns the files.
--   * job.gameId deliberately has NO foreign key: a match-ingest job is enqueued for a
--     gameId BEFORE the game row exists. Same for app_event.
--
-- PRAGMAs (journal_mode, foreign_keys, busy_timeout) are applied by openDb(), not here,
-- because journal_mode is a per-connection persistent setting rather than schema.

CREATE TABLE IF NOT EXISTS schema_version (
	version    INTEGER NOT NULL,
	appliedMs  INTEGER NOT NULL
) STRICT;

-- One row per game we know about. The stat block is the USER's slice, denormalised so the
-- game list renders from a single row with no joins.
CREATE TABLE IF NOT EXISTS game (
	gameId             INTEGER PRIMARY KEY,
	platformId         TEXT    NOT NULL,
	queueId            INTEGER NOT NULL,
	gameMode           TEXT    NOT NULL,
	gameType           TEXT,
	mapId              INTEGER,
	gameVersion        TEXT    NOT NULL,          -- "16.17.810.4348" (replay metadata needs it verbatim)
	patch              TEXT    NOT NULL,          -- "16.17"
	gameCreationMs     INTEGER NOT NULL,          -- epoch ms
	gameDurationSec    INTEGER NOT NULL,          -- SECONDS, the LCU's own unit
	endedAtMs          INTEGER NOT NULL,          -- creation + duration; the retention/expiry clock

	participantId      INTEGER NOT NULL,
	teamId             INTEGER NOT NULL,
	championId         INTEGER NOT NULL,
	championName       TEXT    NOT NULL DEFAULT '',
	role               TEXT    NOT NULL DEFAULT 'UNKNOWN',
	roleConfidence     TEXT    NOT NULL DEFAULT 'low',
	win                INTEGER NOT NULL,          -- 0/1
	kills              INTEGER NOT NULL DEFAULT 0,
	deaths             INTEGER NOT NULL DEFAULT 0,
	assists            INTEGER NOT NULL DEFAULT 0,
	cs                 INTEGER NOT NULL DEFAULT 0,   -- lane minions
	jungleCs           INTEGER NOT NULL DEFAULT 0,   -- camps + scuttle; this is a jungler's "CS"
	gold               INTEGER NOT NULL DEFAULT 0,
	visionScore        INTEGER NOT NULL DEFAULT 0,
	champLevel         INTEGER NOT NULL DEFAULT 0,
	damageToChampions  INTEGER NOT NULL DEFAULT 0,

	-- content availability
	matchBlob          TEXT,                      -- relative path under DATA_DIR, or NULL
	timelineBlob       TEXT,
	liveBlob           TEXT,
	replayPath         TEXT,                      -- NULL once pruned
	replayState        TEXT    NOT NULL DEFAULT 'absent',
	                              -- absent|downloading|available|expired|pruned

	-- cache invalidation (see stack-daemon.md §6.5)
	ingestedAtMs       INTEGER NOT NULL,
	contentHash        TEXT    NOT NULL DEFAULT '',
	analysisVersion    INTEGER NOT NULL DEFAULT 0,
	reviewVersion      INTEGER NOT NULL DEFAULT 0,
	updatedMs          INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS game_by_time     ON game(gameCreationMs DESC);
CREATE INDEX IF NOT EXISTS game_by_replay   ON game(replayState, endedAtMs);
CREATE INDEX IF NOT EXISTS game_by_analysis ON game(analysisVersion);

-- All ten players, so scoreboards and role comparisons work offline.
CREATE TABLE IF NOT EXISTS participant (
	gameId             INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	participantId      INTEGER NOT NULL,
	teamId             INTEGER NOT NULL,
	puuid              TEXT    NOT NULL DEFAULT '',
	riotId             TEXT    NOT NULL DEFAULT '',   -- "Name#TAG"; summonerName is "" now
	summonerId         INTEGER,
	championId         INTEGER NOT NULL,
	championName       TEXT    NOT NULL DEFAULT '',
	role               TEXT    NOT NULL DEFAULT 'UNKNOWN',
	roleConfidence     TEXT    NOT NULL DEFAULT 'low',
	isUser             INTEGER NOT NULL DEFAULT 0,
	win                INTEGER NOT NULL DEFAULT 0,
	kills              INTEGER NOT NULL DEFAULT 0,
	deaths             INTEGER NOT NULL DEFAULT 0,
	assists            INTEGER NOT NULL DEFAULT 0,
	cs                 INTEGER NOT NULL DEFAULT 0,
	jungleCs           INTEGER NOT NULL DEFAULT 0,
	gold               INTEGER NOT NULL DEFAULT 0,
	visionScore        INTEGER NOT NULL DEFAULT 0,
	champLevel         INTEGER NOT NULL DEFAULT 0,
	damageToChampions  INTEGER NOT NULL DEFAULT 0,
	spell1Id           INTEGER,
	spell2Id           INTEGER,
	itemsJson          TEXT    NOT NULL DEFAULT '[]',
	statsJson          TEXT    NOT NULL DEFAULT '{}',  -- the full ~118-field stats object
	PRIMARY KEY (gameId, participantId)
) STRICT;

CREATE INDEX IF NOT EXISTS participant_by_game ON participant(gameId, teamId);

-- Derived analytics. Wholly replaced whenever analysis re-runs for a game.
CREATE TABLE IF NOT EXISTS metric (
	gameId      INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	key         TEXT    NOT NULL,               -- "camps@8", "goldDiff@15", "deathsInEnemyJungle"
	label       TEXT    NOT NULL DEFAULT '',
	value       REAL    NOT NULL,
	unit        TEXT    NOT NULL DEFAULT '',
	band        TEXT    NOT NULL DEFAULT 'unknown',   -- good|ok|bad|unknown
	vsBaseline  REAL,                           -- NULL when there is not enough history
	confidence  TEXT    NOT NULL DEFAULT 'medium',    -- high|medium|low
	explain     TEXT    NOT NULL DEFAULT '',
	PRIMARY KEY (gameId, key)
) STRICT;

-- Timestamped moments. The spine of the review screen.
CREATE TABLE IF NOT EXISTS moment (
	id                    TEXT    PRIMARY KEY,   -- deterministic: g<gameId>-<kind>-<tSec>
	gameId                INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	tSec                  REAL    NOT NULL,      -- game clock, seconds
	kind                  TEXT    NOT NULL,
	title                 TEXT    NOT NULL DEFAULT '',
	severity              REAL    NOT NULL DEFAULT 0,   -- 0..1
	mapX                  REAL    NOT NULL DEFAULT 0,
	mapY                  REAL    NOT NULL DEFAULT 0,
	cameraX               REAL,                  -- NULL => aim at mapX/mapY
	cameraY               REAL,
	participantsJson      TEXT    NOT NULL DEFAULT '[]',
	costGold              REAL,                  -- NULL when it cannot be computed honestly
	confidence            TEXT    NOT NULL DEFAULT 'medium',
	evidence              TEXT    NOT NULL DEFAULT ''    -- the raw data behind this moment
) STRICT;

CREATE INDEX IF NOT EXISTS moment_by_game ON moment(gameId, tSec);
CREATE INDEX IF NOT EXISTS moment_by_sev  ON moment(gameId, severity DESC);

-- Claude output. gameId is NULL for a cross-game "trend" review.
CREATE TABLE IF NOT EXISTS review (
	id               TEXT    PRIMARY KEY,
	gameId           INTEGER REFERENCES game(gameId) ON DELETE CASCADE,
	kind             TEXT    NOT NULL DEFAULT 'game',   -- game|trend
	model            TEXT    NOT NULL,
	createdMs        INTEGER NOT NULL,
	promptHash       TEXT    NOT NULL DEFAULT '',
	analysisVersion  INTEGER NOT NULL DEFAULT 0,
	headline         TEXT    NOT NULL DEFAULT '',
	encouragement    TEXT    NOT NULL DEFAULT '',
	goalsJson        TEXT    NOT NULL DEFAULT '[]',
	status           TEXT    NOT NULL DEFAULT 'ok',     -- ok|failed
	error            TEXT,
	durationMs       INTEGER,
	inputTokens      INTEGER,
	outputTokens     INTEGER,
	costUsd          REAL,
	rawJson          TEXT    NOT NULL DEFAULT '{}'      -- exactly what the model returned
) STRICT;

CREATE INDEX IF NOT EXISTS review_by_game ON review(gameId, createdMs DESC);
CREATE INDEX IF NOT EXISTS review_by_kind ON review(kind, createdMs DESC);

-- Individual coaching points, each optionally anchored to a time, a moment and media.
CREATE TABLE IF NOT EXISTS feedback_item (
	id             TEXT    PRIMARY KEY,
	reviewId       TEXT    NOT NULL REFERENCES review(id) ON DELETE CASCADE,
	gameId         INTEGER,                      -- NULL on a trend item that spans games
	ord            INTEGER NOT NULL DEFAULT 0,   -- preserves the model's ordering
	title          TEXT    NOT NULL DEFAULT '',
	body           TEXT    NOT NULL DEFAULT '',
	severity       TEXT    NOT NULL DEFAULT 'info',   -- info|minor|major
	category       TEXT,
	momentIdsJson  TEXT    NOT NULL DEFAULT '[]',
	mediaIdsJson   TEXT    NOT NULL DEFAULT '[]',
	metricKeysJson TEXT    NOT NULL DEFAULT '[]',
	tSec           REAL,
	acknowledged   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS feedback_by_review ON feedback_item(reviewId, ord);
CREATE INDEX IF NOT EXISTS feedback_by_game   ON feedback_item(gameId);

-- Screenshots, clips, and the always-available generated map images.
CREATE TABLE IF NOT EXISTS media (
	id          TEXT    PRIMARY KEY,
	gameId      INTEGER NOT NULL REFERENCES game(gameId) ON DELETE CASCADE,
	momentId    TEXT    REFERENCES moment(id) ON DELETE SET NULL,
	kind        TEXT    NOT NULL,               -- screenshot|clip|map
	path        TEXT    NOT NULL,               -- relative to DATA_DIR
	width       INTEGER NOT NULL DEFAULT 0,
	height      INTEGER NOT NULL DEFAULT 0,
	tSec        REAL    NOT NULL DEFAULT 0,
	durationSec REAL,
	bytes       INTEGER,
	mimeType    TEXT,
	source      TEXT    NOT NULL DEFAULT 'generated',   -- replay|generated
	createdMs   INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS media_by_game   ON media(gameId, tSec);
CREATE INDEX IF NOT EXISTS media_by_moment ON media(momentId);

-- Durable job queue. Survives restarts; leases make a crash recoverable.
-- NOTE: no FK on gameId — jobs are enqueued for games that do not have a row yet.
CREATE TABLE IF NOT EXISTS job (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	kind           TEXT    NOT NULL,
	gameId         INTEGER,
	state          TEXT    NOT NULL DEFAULT 'queued',
	                          -- queued|leased|done|failed|deferred|expired
	intrusive      INTEGER NOT NULL DEFAULT 0,
	priority       INTEGER NOT NULL DEFAULT 100,   -- lower runs first
	attempts       INTEGER NOT NULL DEFAULT 0,
	maxAttempts    INTEGER NOT NULL DEFAULT 5,
	lastError      TEXT,                           -- also carries a deferral's gate reason
	notBeforeMs    INTEGER NOT NULL DEFAULT 0,
	deadlineMs     INTEGER,                        -- replay download: endedAtMs + 30min
	leaseUntilMs   INTEGER,
	payload        TEXT    NOT NULL DEFAULT '{}',
	createdMs      INTEGER NOT NULL,
	updatedMs      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS job_runnable ON job(state, notBeforeMs, priority, id);
CREATE INDEX IF NOT EXISTS job_by_game  ON job(gameId, kind);
CREATE INDEX IF NOT EXISTS job_recent   ON job(createdMs DESC);

-- At most one live job of a given kind per game. ifnull() is needed because SQLite treats
-- NULLs in a unique index as distinct, which would let trend reviews pile up unbounded.
CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe
	ON job(kind, ifnull(gameId, -1))
	WHERE state IN ('queued', 'deferred', 'leased');

-- UI notification feed, and the replay log behind SSE Last-Event-ID.
CREATE TABLE IF NOT EXISTS app_event (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	atMs     INTEGER NOT NULL,
	kind     TEXT    NOT NULL,
	gameId   INTEGER,
	payload  TEXT    NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX IF NOT EXISTS app_event_by_time ON app_event(atMs DESC);

-- User settings: one row per key, value is JSON. Read merged over DEFAULT_SETTINGS, so a new
-- setting needs no migration.
CREATE TABLE IF NOT EXISTS settings (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updatedMs  INTEGER NOT NULL
) STRICT;

-- Small daemon-owned scratch state: last sync cursor, baseline caches, bridge diagnostics.
CREATE TABLE IF NOT EXISTS kv (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updatedMs  INTEGER NOT NULL
) STRICT;

-- Index over in-game telemetry; the bulk lives in blobs/<gameId>/live.ndjson.gz.
CREATE TABLE IF NOT EXISTS live_session (
	gameId       INTEGER PRIMARY KEY,
	startedMs    INTEGER NOT NULL,
	endedMs      INTEGER,
	sampleCount  INTEGER NOT NULL DEFAULT 0,
	lastEventId  INTEGER NOT NULL DEFAULT -1     -- dedupe against /eventdata EventID
) STRICT;
