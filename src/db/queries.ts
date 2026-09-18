/**
 * Every prepared statement in the application, in one place.
 *
 * Rules this module exists to enforce:
 *   * SQL lives here and nowhere else. If a job handler needs a query, it gets a function.
 *   * The SQLite <-> domain conversion happens here: booleans are 0/1 columns, arrays and
 *     nested objects are JSON columns, and `undefined` is never bound (node:sqlite refuses
 *     to bind it, and refuses JS booleans too — which is a useful guardrail, not a nuisance).
 *   * Rows come back with a null prototype; every getter returns a plain object so the value
 *     can be spread, JSON-serialised and validated normally.
 *
 * NODE-ONLY. Never import this from `src/web`.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite"
import { getDb, transact } from "./index.ts"
import {
	JOB_LEASE_MS,
	JOB_MAX_ATTEMPTS,
	JOB_PRIORITY,
	JOB_RETRY_BASE_MS,
	JOB_RETRY_MAX_MS,
	WATCH_FRAME_WINDOW_SEC
} from "../shared/constants.ts"
import type {
	ChatMessage,
	WatchNote,
	AppEvent,
	FeedbackItem,
	Game,
	Job,
	JobKind,
	JobRequest,
	JobState,
	Media,
	Metric,
	Moment,
	ParticipantSummary,
	Review
} from "../shared/schema/domain.ts"
import { isCoachable } from "../shared/coachable.ts"
import { DEFAULT_SETTINGS } from "../shared/schema/settings.ts"
import type { Settings } from "../shared/schema/settings.ts"

/* ------------------------------------------------------- statement cache */

let cacheOwner: DatabaseSync | null = null
const stmtCache = new Map<string, StatementSync>()

/** Prepare-once, reuse-forever. The cache resets if the connection is swapped (tests). */
const prep = (sql: string): StatementSync => {
	const database = getDb()
	if (cacheOwner !== database) {
		stmtCache.clear()
		cacheOwner = database
	}
	let stmt = stmtCache.get(sql)
	if (!stmt) {
		stmt = database.prepare(sql)
		stmtCache.set(sql, stmt)
	}
	return stmt
}

/* ------------------------------------------------------------ conversion */

type Row = Record<string, unknown>

/** node:sqlite rows have a null prototype; give callers an ordinary object. */
const plain = (row: unknown): Row | null =>
	row === undefined || row === null ? null : { ...(row as Row) }

const b2i = (v: boolean): number => (v ? 1 : 0)
const i2b = (v: unknown): boolean => v === 1 || v === true

const num = (v: unknown, fallback = 0): number =>
	typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : fallback

const str = (v: unknown, fallback = ""): string =>
	typeof v === "string" ? v : fallback

const nullableNum = (v: unknown): number | null =>
	v === null || v === undefined ? null : num(v)

const nullableStr = (v: unknown): string | null =>
	v === null || v === undefined ? null : String(v)

/** Parse a JSON column, degrading to `fallback` rather than throwing on corruption. */
const json = <T>(v: unknown, fallback: T): T => {
	if (typeof v !== "string" || v === "") return fallback
	try {
		return JSON.parse(v) as T
	} catch {
		return fallback
	}
}

/* ================================================================== game */

const GAME_COLUMNS = `gameId, platformId, queueId, gameMode, gameType, mapId, gameVersion, patch,
	gameCreationMs, gameDurationSec, endedAtMs, participantId, teamId, championId, championName,
	role, roleConfidence, win, kills, deaths, assists, cs, jungleCs, gold, visionScore,
	champLevel, damageToChampions, matchBlob, timelineBlob, liveBlob, replayPath, replayState,
	ingestedAtMs, contentHash, analysisVersion, reviewVersion, updatedMs, gradeScore, gradeRank`

const rowToGame = (row: Row): Game => ({
	gameId: num(row.gameId),
	platformId: str(row.platformId),
	queueId: num(row.queueId),
	gameMode: str(row.gameMode),
	gameCreationMs: num(row.gameCreationMs),
	gameDurationSec: num(row.gameDurationSec),
	endedAtMs: num(row.endedAtMs),
	patch: str(row.patch),
	gameVersion: str(row.gameVersion),
	win: i2b(row.win),
	participantId: num(row.participantId),
	teamId: num(row.teamId),
	championId: num(row.championId),
	championName: str(row.championName),
	role: str(row.role, "UNKNOWN") as Game["role"],
	roleConfidence: str(row.roleConfidence, "low") as Game["roleConfidence"],
	kills: num(row.kills),
	deaths: num(row.deaths),
	assists: num(row.assists),
	cs: num(row.cs),
	jungleCs: num(row.jungleCs),
	gold: num(row.gold),
	visionScore: num(row.visionScore),
	champLevel: num(row.champLevel),
	damageToChampions: num(row.damageToChampions),
	replayState: str(row.replayState, "absent") as Game["replayState"],
	replayPath: nullableStr(row.replayPath),
	hasTimeline: row.timelineBlob !== null && row.timelineBlob !== undefined,
	gradeScore: nullableNum(row.gradeScore),
	gradeRank: nullableStr(row.gradeRank),
	analysisVersion: num(row.analysisVersion),
	reviewVersion: num(row.reviewVersion),
	ingestedAtMs: num(row.ingestedAtMs)
})

/** Everything ingestion knows about a game. Blob paths and versions are updated separately. */
export interface GameUpsert {
	gameId: number
	platformId: string
	queueId: number
	gameMode: string
	gameType?: string | null
	mapId?: number | null
	gameVersion: string
	patch: string
	gameCreationMs: number
	gameDurationSec: number
	endedAtMs?: number
	participantId: number
	teamId: number
	championId: number
	championName?: string
	role?: string
	roleConfidence?: string
	win: boolean
	kills?: number
	deaths?: number
	assists?: number
	cs?: number
	jungleCs?: number
	gold?: number
	visionScore?: number
	champLevel?: number
	damageToChampions?: number
	matchBlob?: string | null
	timelineBlob?: string | null
	liveBlob?: string | null
	replayPath?: string | null
	replayState?: string
	contentHash?: string
	analysisVersion?: number
	reviewVersion?: number
}

/**
 * Insert or update a game.
 *
 * Deliberately does NOT clobber `analysisVersion` / `reviewVersion` / blob paths / the replay
 * state when the caller omits them — re-ingesting a game must not silently invalidate work
 * already done on it. Pass the field explicitly to change it.
 *
 * `replayState` in particular: NO caller passes it (the download path owns it, through
 * `setGameReplayState`). Binding it as a plain `excluded.replayState` therefore reset every
 * re-ingested game to `'absent'` while `replayPath` — which IS coalesced — survived, leaving a
 * self-contradictory row that claimed no replay existed while naming the `.rofl` on disk. That
 * defeated `needsReplay()` (re-queuing a download every 30 s for a game already downloaded) and
 * hid the replay from `gamesForRetentionPrune`, which only ever sees `'available'` rows.
 */
export const upsertGame = (g: GameUpsert): void => {
	const now = Date.now()
	prep(`INSERT INTO game (
		gameId, platformId, queueId, gameMode, gameType, mapId, gameVersion, patch,
		gameCreationMs, gameDurationSec, endedAtMs, participantId, teamId, championId,
		championName, role, roleConfidence, win, kills, deaths, assists, cs, jungleCs, gold,
		visionScore, champLevel, damageToChampions, matchBlob, timelineBlob, liveBlob,
		replayPath, replayState, ingestedAtMs, contentHash, analysisVersion, reviewVersion,
		updatedMs
	) VALUES (
		@gameId, @platformId, @queueId, @gameMode, @gameType, @mapId, @gameVersion, @patch,
		@gameCreationMs, @gameDurationSec, @endedAtMs, @participantId, @teamId, @championId,
		@championName, @role, @roleConfidence, @win, @kills, @deaths, @assists, @cs, @jungleCs,
		@gold, @visionScore, @champLevel, @damageToChampions, @matchBlob, @timelineBlob,
		@liveBlob, @replayPath, @replayState, @now, @contentHash, @analysisVersion,
		@reviewVersion, @now
	)
	ON CONFLICT(gameId) DO UPDATE SET
		platformId = excluded.platformId,
		queueId = excluded.queueId,
		gameMode = excluded.gameMode,
		gameType = excluded.gameType,
		mapId = excluded.mapId,
		gameVersion = excluded.gameVersion,
		patch = excluded.patch,
		gameCreationMs = excluded.gameCreationMs,
		gameDurationSec = excluded.gameDurationSec,
		endedAtMs = excluded.endedAtMs,
		participantId = excluded.participantId,
		teamId = excluded.teamId,
		championId = excluded.championId,
		championName = excluded.championName,
		role = excluded.role,
		roleConfidence = excluded.roleConfidence,
		win = excluded.win,
		kills = excluded.kills,
		deaths = excluded.deaths,
		assists = excluded.assists,
		cs = excluded.cs,
		jungleCs = excluded.jungleCs,
		gold = excluded.gold,
		visionScore = excluded.visionScore,
		champLevel = excluded.champLevel,
		damageToChampions = excluded.damageToChampions,
		matchBlob = coalesce(excluded.matchBlob, game.matchBlob),
		timelineBlob = coalesce(excluded.timelineBlob, game.timelineBlob),
		liveBlob = coalesce(excluded.liveBlob, game.liveBlob),
		replayPath = coalesce(excluded.replayPath, game.replayPath),
		replayState = coalesce(@replayStatePatch, game.replayState),
		contentHash = excluded.contentHash,
		updatedMs = excluded.updatedMs`).run({
		gameId: g.gameId,
		platformId: g.platformId,
		queueId: g.queueId,
		gameMode: g.gameMode,
		gameType: g.gameType ?? null,
		mapId: g.mapId ?? null,
		gameVersion: g.gameVersion,
		patch: g.patch,
		gameCreationMs: g.gameCreationMs,
		gameDurationSec: g.gameDurationSec,
		endedAtMs: g.endedAtMs ?? g.gameCreationMs + g.gameDurationSec * 1000,
		participantId: g.participantId,
		teamId: g.teamId,
		championId: g.championId,
		championName: g.championName ?? "",
		role: g.role ?? "UNKNOWN",
		roleConfidence: g.roleConfidence ?? "low",
		win: b2i(g.win),
		kills: g.kills ?? 0,
		deaths: g.deaths ?? 0,
		assists: g.assists ?? 0,
		cs: g.cs ?? 0,
		jungleCs: g.jungleCs ?? 0,
		gold: g.gold ?? 0,
		visionScore: g.visionScore ?? 0,
		champLevel: g.champLevel ?? 0,
		damageToChampions: g.damageToChampions ?? 0,
		matchBlob: g.matchBlob ?? null,
		timelineBlob: g.timelineBlob ?? null,
		liveBlob: g.liveBlob ?? null,
		replayPath: g.replayPath ?? null,
		replayState: g.replayState ?? "absent",
		// NULL on an update means "leave whatever the download/prune path last wrote".
		replayStatePatch: g.replayState ?? null,
		contentHash: g.contentHash ?? "",
		analysisVersion: g.analysisVersion ?? 0,
		reviewVersion: g.reviewVersion ?? 0,
		now
	})
}

export const getGame = (gameId: number): Game | null => {
	const row = plain(prep(`SELECT ${GAME_COLUMNS} FROM game WHERE gameId = ?`).get(gameId))
	return row ? rowToGame(row) : null
}

/** Newest first. */
export const listGames = (limit = 50, offset = 0): Game[] =>
	prep(
		`SELECT ${GAME_COLUMNS} FROM game ORDER BY gameCreationMs DESC LIMIT ? OFFSET ?`
	)
		.all(limit, offset)
		.map(r => rowToGame({ ...(r as Row) }))

/** Which of these gameIds we already have. Cheap enough to call with a whole history page. */
export const existingGameIds = (gameIds: readonly number[]): Set<number> => {
	if (gameIds.length === 0) return new Set()
	const marks = gameIds.map(() => "?").join(",")
	const rows = prep(`SELECT gameId FROM game WHERE gameId IN (${marks})`).all(
		...gameIds
	)
	return new Set(rows.map(r => num((r as Row).gameId)))
}

export const countGames = (): number =>
	num(plain(prep("SELECT count(*) AS c FROM game").get())?.c)

/** Games whose derived analytics are stale (or absent) for the current ANALYSIS_VERSION. */
export const gamesNeedingAnalysis = (analysisVersion: number, limit = 50): number[] =>
	prep(
		`SELECT gameId FROM game
		 WHERE analysisVersion < ? AND timelineBlob IS NOT NULL
		 ORDER BY gameCreationMs DESC LIMIT ?`
	)
		.all(analysisVersion, limit)
		.map(r => num((r as Row).gameId))

/** Games with no review at the current REVIEW_VERSION. */
export const gamesNeedingReview = (reviewVersion: number, limit = 20): number[] =>
	prep(
		`SELECT gameId FROM game
		 WHERE reviewVersion < ? AND analysisVersion > 0
		 ORDER BY gameCreationMs DESC LIMIT ?`
	)
		.all(reviewVersion, limit)
		.map(r => num((r as Row).gameId))

/** Games missing one of their raw blobs — i.e. still needing ingestion. */
/**
 * Games still missing a match or timeline blob, newest first.
 *
 * UNCOACHABLE GAMES ARE EXCLUDED, and that is the whole point of the filter. `match-ingest`
 * writes a stub row with no blobs so a replay download can start, and relies on this query to
 * re-queue the game until the full match arrives — correct for a real game, and an infinite
 * loop for one where it never will. The LCU never returns a full match for a Practice Tool
 * game, so all eleven that this returned on the machine it was written on were PRACTICETOOL,
 * every one re-queued every five minutes since 2 September: about 5,300 of 8,475 rows in the
 * `job` table, with the matching `app_event` rows and log lines, all of it for work that was
 * refused the instant it ran.
 *
 * The rule is `uncoachableReason`, not a second copy of it in SQL — the daemon and the UI have
 * to agree on what a real game is, and a game the app will not coach is by definition not one
 * it should be chasing blobs for. Over-fetches before filtering so a backlog of practice games
 * cannot starve the limit of real ones.
 */
export const gamesNeedingIngest = (limit = 50): number[] =>
	prep(
		`SELECT gameId, queueId, gameMode, gameType, gameDurationSec FROM game
		 WHERE matchBlob IS NULL OR timelineBlob IS NULL
		 ORDER BY gameCreationMs DESC LIMIT ?`
	)
		.all(limit * 4)
		.map(r => plain(r) as Row)
		.filter(r =>
			isCoachable({
				gameMode: str(r.gameMode),
				gameType: str(r.gameType),
				queueId: num(r.queueId),
				gameDurationSec: num(r.gameDurationSec)
			})
		)
		.slice(0, limit)
		.map(r => num(r.gameId))

export const setGameBlobs = (
	gameId: number,
	blobs: {
		matchBlob?: string | null
		timelineBlob?: string | null
		liveBlob?: string | null
		contentHash?: string
	}
): void => {
	prep(
		`UPDATE game SET
			matchBlob = coalesce(@matchBlob, matchBlob),
			timelineBlob = coalesce(@timelineBlob, timelineBlob),
			liveBlob = coalesce(@liveBlob, liveBlob),
			contentHash = coalesce(@contentHash, contentHash),
			updatedMs = @now
		 WHERE gameId = @gameId`
	).run({
		gameId,
		matchBlob: blobs.matchBlob ?? null,
		timelineBlob: blobs.timelineBlob ?? null,
		liveBlob: blobs.liveBlob ?? null,
		contentHash: blobs.contentHash ?? null,
		now: Date.now()
	})
}

export const setGameReplayState = (
	gameId: number,
	replayState: Game["replayState"],
	replayPath: string | null = null
): void => {
	prep(
		`UPDATE game SET replayState = @replayState,
			replayPath = CASE WHEN @replayPath IS NULL THEN replayPath ELSE @replayPath END,
			updatedMs = @now
		 WHERE gameId = @gameId`
	).run({ gameId, replayState, replayPath, now: Date.now() })
}

export const setGameAnalysisVersion = (gameId: number, version: number): void => {
	prep("UPDATE game SET analysisVersion = ?, updatedMs = ? WHERE gameId = ?").run(
		version,
		Date.now(),
		gameId
	)
}

export const setGameReviewVersion = (gameId: number, version: number): void => {
	prep("UPDATE game SET reviewVersion = ?, updatedMs = ? WHERE gameId = ?").run(
		version,
		Date.now(),
		gameId
	)
}

export const setGameRole = (
	gameId: number,
	role: string,
	confidence: string
): void => {
	prep(
		"UPDATE game SET role = ?, roleConfidence = ?, updatedMs = ? WHERE gameId = ?"
	).run(role, confidence, Date.now(), gameId)
}

/** Replay files older than the retention window, for pruning. */
export const gamesForRetentionPrune = (olderThanMs: number): Game[] =>
	prep(
		`SELECT ${GAME_COLUMNS} FROM game
		 WHERE replayState = 'available' AND replayPath IS NOT NULL AND endedAtMs < ?`
	)
		.all(olderThanMs)
		.map(r => rowToGame({ ...(r as Row) }))

/**
 * The rows the habit tracker counts: ranked solo games with a stored timeline, newest first.
 *
 * `queueId = 420` is not a default, it is the population the measurement behind the tracker was
 * taken on (`data/eval/what-wins-20260918.json`, ranked solo only). Counting a normal game into
 * that rate would be quoting an interval for a population it was never measured on.
 *
 * `teamIds` comes along because credit on an elite monster is the KILLER's and the killer has to
 * be checked against his team — one small join here rather than a second read of the match blob
 * per game.
 */
export interface HabitGameRow {
	gameId: number
	gameCreationMs: number
	gameDurationSec: number
	championName: string
	win: boolean
	participantId: number
	teamId: number
}

export const recentHabitGames = (limit = 20, queueId = 420): HabitGameRow[] =>
	prep(
		`SELECT gameId, gameCreationMs, gameDurationSec, championName, win, participantId, teamId
		 FROM game
		 WHERE queueId = ? AND timelineBlob IS NOT NULL
		 ORDER BY gameCreationMs DESC LIMIT ?`
	)
		.all(queueId, limit)
		.map(r => {
			const row = r as Row
			return {
				gameId: num(row.gameId),
				gameCreationMs: num(row.gameCreationMs),
				gameDurationSec: num(row.gameDurationSec),
				championName: str(row.championName),
				win: num(row.win) === 1,
				participantId: num(row.participantId),
				teamId: num(row.teamId)
			}
		})

/** The participant ids on one side of one game. Used to decide who took an objective. */
export const teamParticipantIds = (gameId: number, teamId: number): number[] =>
	prep("SELECT participantId FROM participant WHERE gameId = ? AND teamId = ?")
		.all(gameId, teamId)
		.map(r => num((r as Row).participantId))

/* ========================================================== participants */

const rowToParticipant = (row: Row): ParticipantSummary => ({
	gameId: num(row.gameId),
	participantId: num(row.participantId),
	teamId: num(row.teamId),
	puuid: str(row.puuid),
	riotId: str(row.riotId),
	championId: num(row.championId),
	championName: str(row.championName),
	role: str(row.role, "UNKNOWN") as ParticipantSummary["role"],
	roleConfidence: str(
		row.roleConfidence,
		"low"
	) as ParticipantSummary["roleConfidence"],
	isUser: i2b(row.isUser),
	kills: num(row.kills),
	deaths: num(row.deaths),
	assists: num(row.assists),
	cs: num(row.cs),
	jungleCs: num(row.jungleCs),
	gold: num(row.gold),
	visionScore: num(row.visionScore),
	champLevel: num(row.champLevel),
	damageToChampions: num(row.damageToChampions),
	win: i2b(row.win),
	spell1Id: nullableNum(row.spell1Id) ?? undefined,
	spell2Id: nullableNum(row.spell2Id) ?? undefined,
	items: json<number[]>(row.itemsJson, [])
})

export interface ParticipantUpsert extends ParticipantSummary {
	/** The full ~118-field LCU stats object, kept verbatim for anything we did not model. */
	stats?: unknown
	summonerId?: number | null
}

/** Replaces all ten rows for a game in one transaction. */
export const upsertParticipants = (
	gameId: number,
	participants: readonly ParticipantUpsert[]
): void => {
	transact(() => {
		prep("DELETE FROM participant WHERE gameId = ?").run(gameId)
		const insert = prep(`INSERT INTO participant (
			gameId, participantId, teamId, puuid, riotId, summonerId, championId, championName,
			role, roleConfidence, isUser, win, kills, deaths, assists, cs, jungleCs, gold,
			visionScore, champLevel, damageToChampions, spell1Id, spell2Id, itemsJson, statsJson
		) VALUES (
			@gameId, @participantId, @teamId, @puuid, @riotId, @summonerId, @championId,
			@championName, @role, @roleConfidence, @isUser, @win, @kills, @deaths, @assists,
			@cs, @jungleCs, @gold, @visionScore, @champLevel, @damageToChampions, @spell1Id,
			@spell2Id, @itemsJson, @statsJson
		)`)
		for (const p of participants)
			insert.run({
				gameId,
				participantId: p.participantId,
				teamId: p.teamId,
				puuid: p.puuid ?? "",
				riotId: p.riotId ?? "",
				summonerId: p.summonerId ?? null,
				championId: p.championId,
				championName: p.championName ?? "",
				role: p.role ?? "UNKNOWN",
				roleConfidence: p.roleConfidence ?? "low",
				isUser: b2i(p.isUser),
				win: b2i(p.win),
				kills: p.kills ?? 0,
				deaths: p.deaths ?? 0,
				assists: p.assists ?? 0,
				cs: p.cs ?? 0,
				jungleCs: p.jungleCs ?? 0,
				gold: p.gold ?? 0,
				visionScore: p.visionScore ?? 0,
				champLevel: p.champLevel ?? 0,
				damageToChampions: p.damageToChampions ?? 0,
				spell1Id: p.spell1Id ?? null,
				spell2Id: p.spell2Id ?? null,
				itemsJson: JSON.stringify(p.items ?? []),
				statsJson: JSON.stringify(p.stats ?? {})
			})
	})
}

export const getParticipants = (gameId: number): ParticipantSummary[] =>
	prep("SELECT * FROM participant WHERE gameId = ? ORDER BY participantId")
		.all(gameId)
		.map(r => rowToParticipant({ ...(r as Row) }))

/* =============================================================== metrics */

const rowToMetric = (row: Row): Metric => ({
	key: str(row.key),
	label: str(row.label),
	value: num(row.value),
	unit: str(row.unit),
	band: str(row.band, "unknown") as Metric["band"],
	vsBaseline: nullableNum(row.vsBaseline),
	confidence: str(row.confidence, "medium") as Metric["confidence"],
	explain: str(row.explain)
})

/** Wholesale replacement — analysis is deterministic, so partial updates would only confuse. */
export const replaceMetrics = (gameId: number, metrics: readonly Metric[]): void => {
	transact(() => {
		prep("DELETE FROM metric WHERE gameId = ?").run(gameId)
		const insert = prep(
			`INSERT INTO metric (gameId, key, label, value, unit, band, vsBaseline, confidence, explain)
			 VALUES (@gameId, @key, @label, @value, @unit, @band, @vsBaseline, @confidence, @explain)`
		)
		for (const m of metrics)
			insert.run({
				gameId,
				key: m.key,
				label: m.label ?? "",
				value: Number.isFinite(m.value) ? m.value : 0,
				unit: m.unit ?? "",
				band: m.band ?? "unknown",
				vsBaseline: m.vsBaseline ?? null,
				confidence: m.confidence ?? "medium",
				explain: m.explain ?? ""
			})
	})
}

export const getMetrics = (gameId: number): Metric[] =>
	prep("SELECT * FROM metric WHERE gameId = ? ORDER BY key")
		.all(gameId)
		.map(r => rowToMetric({ ...(r as Row) }))

export const getMetric = (gameId: number, key: string): Metric | null => {
	const row = plain(
		prep("SELECT * FROM metric WHERE gameId = ? AND key = ?").get(gameId, key)
	)
	return row ? rowToMetric(row) : null
}

/**
 * One metric across the most recent `limit` games, newest first. This is what both the trend
 * chart and the baseline calculation read — never re-derive it from raw blobs.
 */
export const metricSeries = (
	key: string,
	limit = 20
): { gameId: number; tMs: number; value: number }[] =>
	prep(
		`SELECT m.gameId AS gameId, g.gameCreationMs AS tMs, m.value AS value
		 FROM metric m JOIN game g ON g.gameId = m.gameId
		 WHERE m.key = ?
		 ORDER BY g.gameCreationMs DESC LIMIT ?`
	)
		.all(key, limit)
		.map(r => {
			const row = r as Row
			return { gameId: num(row.gameId), tMs: num(row.tMs), value: num(row.value) }
		})

/** Distinct metric keys present in the DB, for building the trends page generically. */
export const metricKeys = (): string[] =>
	prep("SELECT DISTINCT key FROM metric ORDER BY key")
		.all()
		.map(r => str((r as Row).key))

/* =============================================================== moments */

const rowToMoment = (row: Row): Moment => {
	const cx = nullableNum(row.cameraX)
	const cy = nullableNum(row.cameraY)
	return {
		id: str(row.id),
		gameId: num(row.gameId),
		tSec: num(row.tSec),
		kind: str(row.kind, "other") as Moment["kind"],
		title: str(row.title),
		severity: num(row.severity),
		mapX: num(row.mapX),
		mapY: num(row.mapY),
		cameraTarget: cx !== null && cy !== null ? { x: cx, y: cy } : null,
		participantsInvolved: json<number[]>(row.participantsJson, []),
		costGold: nullableNum(row.costGold),
		confidence: str(row.confidence, "medium") as Moment["confidence"],
		evidence: str(row.evidence)
	}
}

/**
 * Replace a game's moments.
 *
 * Moment ids are deterministic (`makeMomentId`), so media rows that reference a surviving
 * moment keep working across a re-analysis. Media pointing at a moment that no longer exists
 * has its `momentId` set to NULL by the schema's `ON DELETE SET NULL` — the picture is kept,
 * it just loses its anchor.
 */
export const replaceMoments = (gameId: number, moments: readonly Moment[]): void => {
	transact(() => {
		prep("DELETE FROM moment WHERE gameId = ?").run(gameId)
		const insert = prep(`INSERT INTO moment (
			id, gameId, tSec, kind, title, severity, mapX, mapY, cameraX, cameraY,
			participantsJson, costGold, confidence, evidence
		) VALUES (
			@id, @gameId, @tSec, @kind, @title, @severity, @mapX, @mapY, @cameraX, @cameraY,
			@participantsJson, @costGold, @confidence, @evidence
		)`)
		for (const m of moments)
			insert.run({
				id: m.id,
				gameId,
				tSec: m.tSec,
				kind: m.kind,
				title: m.title ?? "",
				severity: Number.isFinite(m.severity) ? m.severity : 0,
				mapX: m.mapX ?? 0,
				mapY: m.mapY ?? 0,
				cameraX: m.cameraTarget?.x ?? null,
				cameraY: m.cameraTarget?.y ?? null,
				participantsJson: JSON.stringify(m.participantsInvolved ?? []),
				costGold: m.costGold ?? null,
				confidence: m.confidence ?? "medium",
				evidence: m.evidence ?? ""
			})
	})
}

export const getMoments = (gameId: number): Moment[] =>
	prep("SELECT * FROM moment WHERE gameId = ? ORDER BY tSec")
		.all(gameId)
		.map(r => rowToMoment({ ...(r as Row) }))

export const countMoments = (gameId: number): number =>
	num(
		plain(prep("SELECT count(*) AS c FROM moment WHERE gameId = ?").get(gameId))?.c
	)

/* =============================================================== reviews */

const rowToFeedbackItem = (row: Row): FeedbackItem => ({
	id: str(row.id),
	gameId: nullableNum(row.gameId),
	title: str(row.title),
	body: str(row.body),
	fix: str(row.fix),
	impact: str(row.impact, "medium") as FeedbackItem["impact"],
	actionability: str(row.actionability, "medium") as FeedbackItem["actionability"],
	confidence: str(row.confidence, "medium") as FeedbackItem["confidence"],
	priority: num(row.priority),
	severity: str(row.severity, "info") as FeedbackItem["severity"],
	category: nullableStr(row.category) ?? undefined,
	momentIds: json<string[]>(row.momentIdsJson, []),
	mediaIds: json<string[]>(row.mediaIdsJson, []),
	metricKeys: json<string[]>(row.metricKeysJson, []),
	tSec: nullableNum(row.tSec),
	warnings: json<string[]>(row.warningsJson, [])
})

const rowToReview = (row: Row, items: FeedbackItem[]): Review => ({
	id: str(row.id),
	gameId: nullableNum(row.gameId),
	kind: str(row.kind, "game") as Review["kind"],
	model: str(row.model),
	createdMs: num(row.createdMs),
	promptHash: str(row.promptHash),
	analysisVersion: num(row.analysisVersion),
	headline: str(row.headline),
	encouragement: str(row.encouragement),
	items,
	goals: json<string[]>(row.goalsJson, []),
	status: str(row.status, "ok") as "ok" | "failed",
	error: nullableStr(row.error),
	durationMs: nullableNum(row.durationMs),
	inputTokens: nullableNum(row.inputTokens),
	outputTokens: nullableNum(row.outputTokens),
	costUsd: nullableNum(row.costUsd)
})

/** Extra bookkeeping the review job records alongside the model's own output. */
export interface ReviewInsert extends Review {
	/** Exactly what the model returned, before we shaped it. Kept for debugging a bad review. */
	raw?: unknown
}

/** Insert a review and its feedback items atomically. Returns the review's id. */
export const insertReview = (review: ReviewInsert): string => {
	transact(() => {
		prep(`INSERT INTO review (
			id, gameId, kind, model, createdMs, promptHash, analysisVersion, headline,
			encouragement, goalsJson, status, error, durationMs, inputTokens, outputTokens,
			costUsd, rawJson
		) VALUES (
			@id, @gameId, @kind, @model, @createdMs, @promptHash, @analysisVersion, @headline,
			@encouragement, @goalsJson, @status, @error, @durationMs, @inputTokens,
			@outputTokens, @costUsd, @rawJson
		)
		ON CONFLICT(id) DO UPDATE SET
			headline = excluded.headline,
			encouragement = excluded.encouragement,
			goalsJson = excluded.goalsJson,
			status = excluded.status,
			error = excluded.error,
			rawJson = excluded.rawJson`).run({
			id: review.id,
			gameId: review.gameId ?? null,
			kind: review.kind,
			model: review.model,
			createdMs: review.createdMs,
			promptHash: review.promptHash ?? "",
			analysisVersion: review.analysisVersion ?? 0,
			headline: review.headline ?? "",
			encouragement: review.encouragement ?? "",
			goalsJson: JSON.stringify(review.goals ?? []),
			status: review.status ?? "ok",
			error: review.error ?? null,
			durationMs: review.durationMs ?? null,
			inputTokens: review.inputTokens ?? null,
			outputTokens: review.outputTokens ?? null,
			costUsd: review.costUsd ?? null,
			rawJson: JSON.stringify(review.raw ?? {})
		})

		prep("DELETE FROM feedback_item WHERE reviewId = ?").run(review.id)
		const insert = prep(`INSERT INTO feedback_item (
			id, reviewId, gameId, ord, title, body, severity, category, momentIdsJson,
			mediaIdsJson, metricKeysJson, tSec, warningsJson, fix,
			impact, actionability, confidence, priority
		) VALUES (
			@id, @reviewId, @gameId, @ord, @title, @body, @severity, @category,
			@momentIdsJson, @mediaIdsJson, @metricKeysJson, @tSec, @warningsJson, @fix,
			@impact, @actionability, @confidence, @priority
		)`)
		review.items.forEach((item, ord) =>
			insert.run({
				id: item.id,
				reviewId: review.id,
				gameId: item.gameId ?? null,
				ord,
				title: item.title ?? "",
				body: item.body ?? "",
				severity: item.severity ?? "info",
				category: item.category ?? null,
				momentIdsJson: JSON.stringify(item.momentIds ?? []),
				mediaIdsJson: JSON.stringify(item.mediaIds ?? []),
				metricKeysJson: JSON.stringify(item.metricKeys ?? []),
				tSec: item.tSec ?? null,
				warningsJson: JSON.stringify(item.warnings ?? []),
				fix: item.fix ?? "",
				impact: item.impact ?? "medium",
				actionability: item.actionability ?? "medium",
				confidence: item.confidence ?? "medium",
				priority: item.priority ?? 0
			})
		)
	})
	return review.id
}

const loadItems = (reviewId: string): FeedbackItem[] =>
	prep("SELECT * FROM feedback_item WHERE reviewId = ? ORDER BY ord, id")
		.all(reviewId)
		.map(r => rowToFeedbackItem({ ...(r as Row) }))

/**
 * The newest review for a game whatever its status — used only to tell "failed" from "not yet".
 *
 * Deliberately separate from `getReview`, which promises a review worth SHOWING. Loosening that
 * one instead would let a failed row reach every caller that renders coaching.
 */
export const latestReviewOutcome = (gameId: number): { status: string; error: string | null } | null => {
	const row = plain(
		prep(
			`SELECT status, error FROM review WHERE gameId = ? AND kind = 'game'
			 ORDER BY createdMs DESC LIMIT 1`
		).get(gameId)
	)
	return row ? { status: str(row.status), error: row.error === null ? null : str(row.error) } : null
}

/** The newest successful review for a game, with its items. */
export const getReview = (gameId: number): Review | null => {
	const row = plain(
		prep(
			`SELECT * FROM review WHERE gameId = ? AND kind = 'game' AND status = 'ok'
			 ORDER BY createdMs DESC LIMIT 1`
		).get(gameId)
	)
	return row ? rowToReview(row, loadItems(str(row.id))) : null
}

/** The newest cross-game review. `null` before one has ever been generated. */
export const getTrendReview = (): Review | null => {
	const row = plain(
		prep(
			`SELECT * FROM review WHERE kind = 'trend' AND status = 'ok'
			 ORDER BY createdMs DESC LIMIT 1`
		).get()
	)
	return row ? rowToReview(row, loadItems(str(row.id))) : null
}

/** gameIds that already have a good review — for the list view's badge, in one query. */
export const gameIdsWithReviews = (): Set<number> =>
	new Set(
		prep(
			"SELECT DISTINCT gameId FROM review WHERE gameId IS NOT NULL AND kind = 'game' AND status = 'ok'"
		)
			.all()
			.map(r => num((r as Row).gameId))
	)

/**
 * Every game's review headline, in one query.
 *
 * The games list shows the headline under each row. Fetching it per game meant one full
 * `/api/games/:id` round trip each — thirty sequential requests to render one screen, and it
 * scaled with the history, not the viewport. The headline is one column; fetch them together.
 */
export const reviewHeadlines = (): Map<number, string> =>
	new Map(
		prep(
			`SELECT gameId, headline FROM review
			 WHERE gameId IS NOT NULL AND kind = 'game' AND status = 'ok'`
		)
			.all()
			.map(r => [num((r as Row).gameId), str((r as Row).headline)] as const)
	)

/** Whether a review with this exact prompt hash already exists — the reuse check. */
export const reviewExistsForPrompt = (
	gameId: number | null,
	promptHash: string
): boolean =>
	plain(
		prep(
			`SELECT id FROM review
			 WHERE ifnull(gameId, -1) = ifnull(?, -1) AND promptHash = ? AND status = 'ok'
			 LIMIT 1`
		).get(gameId, promptHash)
	) !== null

/** Every coaching item across recent games — the input to a trend review. */
export const recentFeedbackItems = (limit = 100): FeedbackItem[] =>
	prep(
		`SELECT fi.* FROM feedback_item fi
		 JOIN review r ON r.id = fi.reviewId
		 WHERE r.kind = 'game' AND r.status = 'ok'
		 ORDER BY r.createdMs DESC LIMIT ?`
	)
		.all(limit)
		.map(r => rowToFeedbackItem({ ...(r as Row) }))

/* ================================================================= media */

const rowToMedia = (row: Row): Media => ({
	id: str(row.id),
	gameId: num(row.gameId),
	momentId: nullableStr(row.momentId),
	kind: str(row.kind, "map") as Media["kind"],
	path: str(row.path),
	width: num(row.width),
	height: num(row.height),
	tSec: num(row.tSec),
	createdMs: num(row.createdMs),
	source: str(row.source, "generated") as Media["source"],
	durationSec: nullableNum(row.durationSec),
	bytes: nullableNum(row.bytes),
	mimeType: nullableStr(row.mimeType)
})

export const insertMedia = (media: Media): string => {
	prep(`INSERT INTO media (
		id, gameId, momentId, kind, path, width, height, tSec, durationSec, bytes, mimeType,
		source, createdMs
	) VALUES (
		@id, @gameId, @momentId, @kind, @path, @width, @height, @tSec, @durationSec, @bytes,
		@mimeType, @source, @createdMs
	)
	ON CONFLICT(id) DO UPDATE SET
		path = excluded.path, width = excluded.width, height = excluded.height,
		bytes = excluded.bytes, mimeType = excluded.mimeType, source = excluded.source`).run({
		id: media.id,
		gameId: media.gameId,
		momentId: media.momentId ?? null,
		kind: media.kind,
		path: media.path,
		width: media.width ?? 0,
		height: media.height ?? 0,
		tSec: media.tSec ?? 0,
		durationSec: media.durationSec ?? null,
		bytes: media.bytes ?? null,
		mimeType: media.mimeType ?? null,
		source: media.source ?? "generated",
		createdMs: media.createdMs ?? Date.now()
	})
	return media.id
}

export const getMedia = (id: string): Media | null => {
	const row = plain(prep("SELECT * FROM media WHERE id = ?").get(id))
	return row ? rowToMedia(row) : null
}

export const listMediaForGame = (gameId: number): Media[] =>
	prep("SELECT * FROM media WHERE gameId = ? ORDER BY tSec, createdMs")
		.all(gameId)
		.map(r => rowToMedia({ ...(r as Row) }))

export const listMediaForMoment = (momentId: string): Media[] =>
	prep("SELECT * FROM media WHERE momentId = ? ORDER BY createdMs")
		.all(momentId)
		.map(r => rowToMedia({ ...(r as Row) }))

/**
 * Fill in each feedback item's `mediaIds` from the media attached to the moments it cites.
 *
 * `mediaIds` is written by the capture pipeline, which may never run — and `media-generate`
 * can finish long after the coach did, so an item written first would keep an empty list
 * forever. Every moment does get a generated map SVG, and that picture is precisely what the
 * item is talking about, so resolving the join at READ time is what reliably puts an
 * illustration next to the feedback whatever order the jobs finished in. Ids the item already
 * carries win and keep their position; derived ones are appended.
 */
export const withMomentMedia = (review: Review | null): Review | null => {
	if (!review) return review
	return {
		...review,
		items: review.items.map(item => {
			const ids = [...item.mediaIds]
			for (const momentId of item.momentIds)
				for (const m of listMediaForMoment(momentId))
					if (!ids.includes(m.id)) ids.push(m.id)
			return ids.length === item.mediaIds.length ? item : { ...item, mediaIds: ids }
		})
	}
}

export const deleteMedia = (id: string): void => {
	prep("DELETE FROM media WHERE id = ?").run(id)
}

/** Per-game media counts for the whole list view, in one query. */
export const mediaCounts = (): Map<number, number> =>
	new Map(
		prep("SELECT gameId, count(*) AS c FROM media GROUP BY gameId")
			.all()
			.map(r => {
				const row = r as Row
				return [num(row.gameId), num(row.c)] as const
			})
	)

/** Per-game moment counts for the whole list view, in one query. */
export const momentCounts = (): Map<number, number> =>
	new Map(
		prep("SELECT gameId, count(*) AS c FROM moment GROUP BY gameId")
			.all()
			.map(r => {
				const row = r as Row
				return [num(row.gameId), num(row.c)] as const
			})
	)

/* ================================================================== jobs */

const rowToJob = (row: Row): Job => ({
	id: num(row.id),
	kind: str(row.kind) as JobKind,
	gameId: nullableNum(row.gameId),
	state: str(row.state, "queued") as JobState,
	intrusive: i2b(row.intrusive),
	attempts: num(row.attempts),
	maxAttempts: num(row.maxAttempts),
	priority: num(row.priority),
	lastError: nullableStr(row.lastError),
	notBeforeMs: num(row.notBeforeMs),
	deadlineMs: nullableNum(row.deadlineMs),
	leaseUntilMs: nullableNum(row.leaseUntilMs),
	payload: json<Record<string, unknown>>(row.payload, {}),
	createdMs: num(row.createdMs),
	updatedMs: num(row.updatedMs)
})

/**
 * Enqueue a job, or return the existing live one.
 *
 * A partial unique index guarantees at most one `queued`/`deferred`/`leased` job per
 * (kind, gameId), so double-clicking "review this game" cannot spawn two Claude runs.
 * Returns the id of whichever job is now live for that pair.
 */
export const enqueue = (req: JobRequest): number => {
	const now = Date.now()
	const gameId = req.gameId ?? null
	const existing = plain(
		prep(
			`SELECT id FROM job
			 WHERE kind = ? AND ifnull(gameId, -1) = ifnull(?, -1)
			   AND state IN ('queued', 'deferred', 'leased')
			 LIMIT 1`
		).get(req.kind, gameId)
	)
	if (existing) return num(existing.id)

	const result = prep(`INSERT INTO job (
		kind, gameId, state, intrusive, priority, attempts, maxAttempts, lastError,
		notBeforeMs, deadlineMs, leaseUntilMs, payload, createdMs, updatedMs
	) VALUES (
		@kind, @gameId, 'queued', @intrusive, @priority, 0, @maxAttempts, NULL,
		@notBeforeMs, @deadlineMs, NULL, @payload, @now, @now
	)`).run({
		kind: req.kind,
		gameId,
		intrusive: b2i(req.intrusive ?? false),
		priority: req.priority ?? JOB_PRIORITY[req.kind] ?? 100,
		maxAttempts: req.maxAttempts ?? JOB_MAX_ATTEMPTS[req.kind] ?? 5,
		notBeforeMs: req.notBeforeMs ?? 0,
		deadlineMs: req.deadlineMs ?? null,
		payload: JSON.stringify(req.payload ?? {}),
		now
	})
	return Number(result.lastInsertRowid)
}

export interface ClaimOptions {
	/**
	 * Whether intrusive jobs may be claimed right now. VESTIGIAL: `replay-capture` was the only
	 * intrusive kind, it and the gate that guarded it are deleted, and nothing written from here
	 * on carries `intrusive = 1`. The column and this flag stay because rows written before the
	 * removal still carry it, and this app does not rewrite a stored row to tidy a schema.
	 */
	allowIntrusive?: boolean
	/** Restrict to specific kinds — how a dedicated worker pool stays in its lane. */
	kinds?: readonly JobKind[]
	leaseMs?: number
	nowMs?: number
}

/**
 * Atomically claim the next runnable job, or return null.
 *
 * One `UPDATE ... RETURNING` with the selection inlined as a subquery: there is no window
 * between choosing a row and marking it leased, so two workers can never take the same job
 * even though they share the file. `deferred` jobs are eligible again as soon as their
 * `notBeforeMs` passes — the gate re-defers them if the world has not changed.
 *
 * A claimed job holds a LEASE rather than a lock; `reclaimExpiredLeases` returns work that a
 * crashed worker was holding, so a kill -9 costs one attempt, not the job.
 */
export const claimNextJob = (opts: ClaimOptions = {}): Job | null => {
	const now = opts.nowMs ?? Date.now()
	const leaseUntil = now + (opts.leaseMs ?? JOB_LEASE_MS)
	const allowIntrusive = opts.allowIntrusive ?? false
	const kinds = opts.kinds

	const kindFilter =
		kinds && kinds.length > 0
			? ` AND kind IN (${kinds.map(k => `'${k.replace(/'/g, "")}'`).join(",")})`
			: ""

	const rows = prep(`UPDATE job SET
			state = 'leased',
			attempts = attempts + 1,
			leaseUntilMs = @leaseUntil,
			updatedMs = @now
		WHERE id = (
			SELECT id FROM job
			WHERE state IN ('queued', 'deferred')
			  AND notBeforeMs <= @now
			  AND (deadlineMs IS NULL OR deadlineMs > @now)
			  AND (@allowIntrusive = 1 OR intrusive = 0)
			  ${kindFilter}
			ORDER BY priority ASC, id ASC
			LIMIT 1
		)
		RETURNING *`).all({
		now,
		leaseUntil,
		allowIntrusive: b2i(allowIntrusive)
	})

	const row = rows[0]
	return row ? rowToJob({ ...(row as Row) }) : null
}

export const completeJob = (id: number, note?: string): void => {
	prep(
		`UPDATE job SET state = 'done', leaseUntilMs = NULL, lastError = @note, updatedMs = @now
		 WHERE id = @id`
	).run({ id, note: note ?? null, now: Date.now() })
}

/**
 * Record a failure. Retries with exponential backoff until `maxAttempts`, then the job goes
 * terminal-`failed` with the error preserved so the UI can explain itself.
 */
export const failJob = (id: number, error: string): Job | null => {
	const now = Date.now()
	const current = getJob(id)
	if (!current) return null
	const exhausted = current.attempts >= current.maxAttempts
	const backoff = Math.min(
		JOB_RETRY_BASE_MS * 2 ** Math.max(0, current.attempts - 1),
		JOB_RETRY_MAX_MS
	)
	prep(
		`UPDATE job SET state = @state, lastError = @error, leaseUntilMs = NULL,
			notBeforeMs = @notBefore, updatedMs = @now
		 WHERE id = @id`
	).run({
		id,
		state: exhausted ? "failed" : "queued",
		error: error.slice(0, 4000),
		notBefore: exhausted ? current.notBeforeMs : now + backoff,
		now
	})
	return getJob(id)
}

/**
 * Put a job back to sleep because a gate said no. `reason` is stored in `lastError` — that is
 * the one place anyone looks to answer "why has this not run", so a deferral belongs there
 * even though it is not an error. Does NOT consume an attempt.
 */
export const deferJob = (id: number, reason: string, notBeforeMs?: number): void => {
	const now = Date.now()
	prep(
		`UPDATE job SET state = 'deferred', lastError = @reason, leaseUntilMs = NULL,
			attempts = max(0, attempts - 1), notBeforeMs = @notBefore, updatedMs = @now
		 WHERE id = @id`
	).run({
		id,
		reason: reason.slice(0, 1000),
		notBefore: notBeforeMs ?? now + 60_000,
		now
	})
}

/**
 * Terminal-`expired`. Only replay downloads reach this: the client drops a replay 30 minutes
 * after the game ends, and after that no amount of retrying will bring it back.
 */
export const expireJob = (id: number, reason = "deadline passed"): void => {
	prep(
		`UPDATE job SET state = 'expired', lastError = @reason, leaseUntilMs = NULL, updatedMs = @now
		 WHERE id = @id`
	).run({ id, reason, now: Date.now() })
}

/** Sweep every job whose hard deadline has passed. Call on each daemon tick. */
export const expireOverdueJobs = (nowMs: number = Date.now()): number =>
	prep(
		`UPDATE job SET state = 'expired', lastError = 'deadline passed',
			leaseUntilMs = NULL, updatedMs = @now
		 WHERE state IN ('queued', 'deferred', 'leased')
		   AND deadlineMs IS NOT NULL AND deadlineMs <= @now`
	).run({ now: nowMs }).changes as number

/** Return work a crashed worker was holding. Call on boot and on each tick. */
export const reclaimExpiredLeases = (nowMs: number = Date.now()): number =>
	prep(
		`UPDATE job SET state = 'queued', leaseUntilMs = NULL,
			lastError = coalesce(lastError, 'lease expired; worker vanished'), updatedMs = @now
		 WHERE state = 'leased' AND leaseUntilMs IS NOT NULL AND leaseUntilMs <= @now`
	).run({ now: nowMs }).changes as number

/**
 * Return EVERY leased job, regardless of how much lease is left.
 *
 * `reclaimExpiredLeases` is the right rule while the daemon is running — a lease is what stops
 * two live workers from taking the same job. It is the wrong rule at boot: a daemon that has
 * just started demonstrably holds nothing, so a `leased` row is by definition the residue of a
 * process that died, and waiting out the remaining lease (up to `JOB_LEASE_MS`, 10 minutes)
 * strands real work while the queue screen shows it as running.
 *
 * Only `queue.adoptOrphanedLeases()` should call this, and only once it has established that
 * no other daemon is alive on this database.
 */
export const reclaimAllLeases = (nowMs: number = Date.now()): number =>
	prep(
		`UPDATE job SET state = 'queued', leaseUntilMs = NULL,
			lastError = coalesce(lastError, 'daemon crashed while holding this job'),
			updatedMs = @now
		 WHERE state = 'leased'`
	).run({ now: nowMs }).changes as number

/**
 * Cancel from the UI. Lands in `failed` with an explicit `lastError` rather than adding a
 * seventh state — "why did this not run" then always has exactly one place to look.
 */
export const cancelJob = (id: number): boolean =>
	(
		prep(
			`UPDATE job SET state = 'failed', lastError = 'cancelled by user',
				leaseUntilMs = NULL, updatedMs = @now
			 WHERE id = @id AND state IN ('queued', 'deferred', 'leased')`
		).run({ id, now: Date.now() }).changes as number
	) > 0

/** Retry from the UI: reset attempts and make it runnable now. Expired jobs stay expired. */
export const retryJob = (id: number): boolean =>
	(
		prep(
			`UPDATE job SET state = 'queued', attempts = 0, lastError = NULL,
				leaseUntilMs = NULL, notBeforeMs = 0, updatedMs = @now
			 WHERE id = @id AND state IN ('failed', 'deferred', 'done')`
		).run({ id, now: Date.now() }).changes as number
	) > 0

export const getJob = (id: number): Job | null => {
	const row = plain(prep("SELECT * FROM job WHERE id = ?").get(id))
	return row ? rowToJob(row) : null
}

export interface ListJobsOptions {
	states?: readonly JobState[]
	kinds?: readonly JobKind[]
	gameId?: number
	limit?: number
}

/** Newest first. With no filter, returns the recent queue as the activity screen shows it. */
export const listJobs = (opts: ListJobsOptions = {}): Job[] => {
	const where: string[] = []
	const params: unknown[] = []
	if (opts.states && opts.states.length > 0) {
		where.push(`state IN (${opts.states.map(() => "?").join(",")})`)
		params.push(...opts.states)
	}
	if (opts.kinds && opts.kinds.length > 0) {
		where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`)
		params.push(...opts.kinds)
	}
	if (opts.gameId !== undefined) {
		where.push("gameId = ?")
		params.push(opts.gameId)
	}
	const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
	params.push(opts.limit ?? 100)
	return prep(`SELECT * FROM job ${clause} ORDER BY id DESC LIMIT ?`)
		.all(...(params as never[]))
		.map(r => rowToJob({ ...(r as Row) }))
}

/** How much work is outstanding — the number in the status banner. */
export const queueDepth = (): number =>
	num(
		plain(
			prep(
				"SELECT count(*) AS c FROM job WHERE state IN ('queued', 'deferred', 'leased')"
			).get()
		)?.c
	)

/**
 * Store a computed grade. Written by `analysis-run` alongside the metrics it was derived from,
 * so the two never disagree about which analysis produced which grade.
 */
export const setGameGrade = (
	gameId: number,
	grade: { score: number; rank: string } | null
): void => {
	prep("UPDATE game SET gradeScore = ?, gradeRank = ?, updatedMs = ? WHERE gameId = ?").run(
		grade?.score ?? null,
		grade?.rank ?? null,
		Date.now(),
		gameId
	)
}

/** Recent grades, newest first, for the rolling average and the sparkline. Ungraded games skipped. */
export const recentGrades = (limit = 20): { gameId: number; score: number; rank: string }[] =>
	prep(
		`SELECT gameId, gradeScore, gradeRank FROM game
		 WHERE gradeScore IS NOT NULL ORDER BY gameCreationMs DESC LIMIT ?`
	)
		.all(limit)
		.map(r => ({
			gameId: num((r as Row).gameId),
			score: num((r as Row).gradeScore),
			rank: str((r as Row).gradeRank)
		}))

/**
 * Per game: how many moments have a real frame to look at, and how many have been watched.
 *
 * Two counts rather than a boolean because they are three different states the user has to be
 * able to tell apart — nothing recorded, recorded but not looked at, and actually watched — and
 * each has a different next action.
 *
 * THE FRAMES COME FROM THE JOURNAL. This counted `media` rows with `source = 'replay'` until
 * now, which was the replay-capture pipeline's output: that feature is deleted, and it never
 * wrote a single row in the app's whole history (checked — zero, against 1157 generated maps).
 * So this count was structurally pinned at 0, the eye badge on the games list could only ever
 * show "data only", and the review screen's offer to watch a moment could never appear. The
 * journal is where the pictures actually are, and the panels above it already say so.
 */
export const visionCounts = (): Map<number, { frames: number; watched: number }> => {
	const out = new Map<number, { frames: number; watched: number }>()
	const bump = (gameId: number, key: "frames" | "watched", n: number): void => {
		const row = out.get(gameId) ?? { frames: 0, watched: 0 }
		row[key] += n
		out.set(gameId, row)
	}
	for (const r of prep(
		`SELECT m.gameId AS gameId, count(*) AS n FROM moment m
		  WHERE EXISTS (
		        SELECT 1 FROM journal_frame f
		          JOIN journal_session s ON s.id = f.sessionId
		         WHERE s.gameId = m.gameId
		           AND abs(f.tSec - m.tSec) <= ?)
		  GROUP BY m.gameId`
	).all(WATCH_FRAME_WINDOW_SEC))
		bump(num((r as Row).gameId), "frames", num((r as Row).n))
	for (const r of prep(
		"SELECT gameId, count(*) AS n FROM watch_note WHERE status = 'ok' GROUP BY gameId"
	).all())
		bump(num((r as Row).gameId), "watched", num((r as Row).n))
	return out
}

/** Housekeeping: forget terminal jobs older than `beforeMs`. */
export const pruneJobs = (beforeMs: number): number =>
	prep(
		`DELETE FROM job WHERE state IN ('done', 'failed', 'expired') AND updatedMs < ?`
	).run(beforeMs).changes as number

/* ============================================================= settings */

/** Settings merged over `DEFAULT_SETTINGS`, so a new field never needs a migration. */
export const getSettings = (): Settings => {
	const rows = prep("SELECT key, value FROM settings").all()
	const stored: Record<string, unknown> = {}
	for (const r of rows) {
		const row = r as Row
		stored[str(row.key)] = json<unknown>(row.value, undefined)
	}
	const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>
	for (const [k, v] of Object.entries(stored)) if (v !== undefined) merged[k] = v
	return merged as Settings
}

/** Write a partial update. Only the keys present are touched. Returns the merged result. */
export const putSettings = (patch: Partial<Settings>): Settings => {
	const now = Date.now()
	transact(() => {
		const upsert = prep(
			`INSERT INTO settings (key, value, updatedMs) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedMs = excluded.updatedMs`
		)
		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue
			upsert.run(k, JSON.stringify(v), now)
		}
	})
	return getSettings()
}

/* =================================================================== kv */

export const kvGet = <T>(key: string, fallback: T): T => {
	const row = plain(prep("SELECT value FROM kv WHERE key = ?").get(key))
	return row ? json<T>(row.value, fallback) : fallback
}

export const kvSet = (key: string, value: unknown): void => {
	prep(
		`INSERT INTO kv (key, value, updatedMs) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedMs = excluded.updatedMs`
	).run(key, JSON.stringify(value), Date.now())
}

export const kvDelete = (key: string): void => {
	prep("DELETE FROM kv WHERE key = ?").run(key)
}

/* =============================================================== events */

const rowToAppEvent = (row: Row): AppEvent => ({
	id: num(row.id),
	atMs: num(row.atMs),
	kind: str(row.kind),
	gameId: nullableNum(row.gameId),
	payload: json<Record<string, unknown>>(row.payload, {})
})

/**
 * Append to the notification feed. The returned id is the SSE `Last-Event-ID`, which is how a
 * browser tab that was closed for an hour catches up on exactly what it missed.
 */
export const appendEvent = (
	kind: string,
	payload: unknown = {},
	gameId: number | null = null
): number => {
	const result = prep(
		"INSERT INTO app_event (atMs, kind, gameId, payload) VALUES (?, ?, ?, ?)"
	).run(Date.now(), kind, gameId, JSON.stringify(payload ?? {}))
	return Number(result.lastInsertRowid)
}

/** Everything after `id`, oldest first — the order a client must replay them in. */
export const eventsSince = (id: number, limit = 200): AppEvent[] =>
	prep("SELECT * FROM app_event WHERE id > ? ORDER BY id ASC LIMIT ?")
		.all(id, limit)
		.map(r => rowToAppEvent({ ...(r as Row) }))

export const latestEventId = (): number =>
	num(plain(prep("SELECT max(id) AS m FROM app_event").get())?.m)

export const pruneEvents = (beforeMs: number): number =>
	prep("DELETE FROM app_event WHERE atMs < ?").run(beforeMs).changes as number

/* ================================================================== chat */

const rowToChatMessage = (row: Row): ChatMessage => ({
	id: str(row.id),
	gameId: num(row.gameId),
	role: str(row.role, "user") as ChatMessage["role"],
	content: str(row.content),
	model: nullableStr(row.model),
	costUsd: nullableNum(row.costUsd),
	citedMomentIds: json<string[]>(row.citedMomentIds, []),
	citedMetricKeys: json<string[]>(row.citedMetricKeys, []),
	status: str(row.status, "ok") as ChatMessage["status"],
	error: nullableStr(row.error),
	createdMs: num(row.createdMs)
})

/** Oldest first — a conversation reads top to bottom. */
export const listChatMessages = (gameId: number, limit = 200): ChatMessage[] =>
	prep(
		"SELECT * FROM chat_message WHERE gameId = ? ORDER BY createdMs ASC, rowid ASC LIMIT ?"
	)
		.all(gameId, limit)
		.map(r => rowToChatMessage({ ...(r as Row) }))

export const insertChatMessage = (m: ChatMessage): void => {
	prep(
		`INSERT OR REPLACE INTO chat_message
		 (id, gameId, role, content, model, costUsd, citedMomentIds, citedMetricKeys, status, error, createdMs)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		m.id,
		m.gameId,
		m.role,
		m.content,
		m.model,
		m.costUsd,
		JSON.stringify(m.citedMomentIds),
		JSON.stringify(m.citedMetricKeys),
		m.status,
		m.error,
		m.createdMs
	)
}

/** Clear one game's conversation. Returns how many turns were removed. */
export const clearChat = (gameId: number): number => {
	const before = num(
		plain(prep("SELECT count(*) AS c FROM chat_message WHERE gameId = ?").get(gameId))?.c
	)
	prep("DELETE FROM chat_message WHERE gameId = ?").run(gameId)
	return before
}

/* ============================================================ watch notes */

const rowToWatchNote = (row: Row): WatchNote => ({
	id: str(row.id),
	gameId: num(row.gameId),
	momentId: str(row.momentId),
	text: str(row.text),
	model: nullableStr(row.model),
	costUsd: nullableNum(row.costUsd),
	frameCount: num(row.frameCount),
	status: str(row.status, "ok") as WatchNote["status"],
	error: nullableStr(row.error),
	createdMs: num(row.createdMs)
})

export const listWatchNotes = (gameId: number): WatchNote[] =>
	prep("SELECT * FROM watch_note WHERE gameId = ? ORDER BY createdMs")
		.all(gameId)
		.map(r => rowToWatchNote({ ...(r as Row) }))

/** One note per (game, moment) — re-watching replaces rather than accumulates. */
export const upsertWatchNote = (n: WatchNote): void => {
	prep(
		`INSERT INTO watch_note (id, gameId, momentId, text, model, costUsd, frameCount, status, error, createdMs)
		 VALUES (@id, @gameId, @momentId, @text, @model, @costUsd, @frameCount, @status, @error, @createdMs)
		 ON CONFLICT(gameId, momentId) DO UPDATE SET
			text = excluded.text, model = excluded.model, costUsd = excluded.costUsd,
			frameCount = excluded.frameCount, status = excluded.status,
			error = excluded.error, createdMs = excluded.createdMs`
	).run({
		id: n.id,
		gameId: n.gameId,
		momentId: n.momentId,
		text: n.text,
		model: n.model,
		costUsd: n.costUsd,
		frameCount: n.frameCount,
		status: n.status,
		error: n.error,
		createdMs: n.createdMs
	})
}

/* =============================================================== journal */

/**
 * The frame journal. Sessions are keyed by session id, never by gameId — see
 * `daemon/journal.ts` for why the game arrives later, or not at all.
 */

export interface JournalSessionRow {
	id: string
	startedMs: number
	endedMs: number | null
	gameId: number | null
	claim: string
	championName: string | null
	riotId: string | null
	estimatedStartMs: number | null
	frameCount: number
}

export const insertJournalSession = (s: {
	id: string
	startedMs: number
	gameId: number | null
	championName: string | null
	riotId: string | null
	estimatedStartMs: number
	createdMs: number
}): void => {
	prep(
		`INSERT INTO journal_session
		   (id, startedMs, gameId, claim, championName, riotId, estimatedStartMs, frameCount, createdMs)
		 VALUES (@id, @startedMs, @gameId, @claim, @championName, @riotId, @estimatedStartMs, 0, @createdMs)`
	).run({
		id: s.id,
		startedMs: s.startedMs,
		gameId: s.gameId,
		// The LCU telling us mid-game is the fast path; everything else waits for the matcher.
		claim: s.gameId === null ? "unclaimed" : "lcu",
		championName: s.championName,
		riotId: s.riotId,
		estimatedStartMs: s.estimatedStartMs,
		createdMs: s.createdMs
	})
}

/** The session still being written to, if any. At most one is open at a time. */
export const openJournalSessionFor = (): JournalSessionRow | null => {
	const row = plain(
		prep("SELECT * FROM journal_session WHERE endedMs IS NULL ORDER BY startedMs DESC LIMIT 1").get()
	)
	return row ? (row as unknown as JournalSessionRow) : null
}

/**
 * Every session whose frames could belong to a window of wall clock.
 *
 * Overlap, not containment: a session that was already open when the game started, or still open
 * when it ended, holds that game's frames just as much as one that began and ended inside it. An
 * open session (`endedMs` null) is treated as reaching to the end of the window, which is the only
 * honest reading of "still being written to" — and is why `endOpenSession` exists to make that a
 * rare state rather than the permanent one it used to be.
 */
export const journalSessionsBetween = (
	fromMs: number,
	toMs: number
): JournalSessionRow[] =>
	prep(
		`SELECT * FROM journal_session
		  WHERE startedMs <= ? AND COALESCE(endedMs, ?) >= ?
		  ORDER BY startedMs`
	)
		.all(toMs, toMs, fromMs)
		.map(r => plain(r) as unknown as JournalSessionRow)

export const closeJournalSession = (id: string, endedMs: number): void => {
	prep("UPDATE journal_session SET endedMs = ? WHERE id = ?").run(endedMs, id)
}

export const insertJournalFrame = (f: {
	id: string
	sessionId: string
	tSec: number
	path: string
	atMs: number
	clock: string
	truthJson: string | null
	bytes: number
}): void => {
	prep(
		`INSERT INTO journal_frame (id, sessionId, tSec, path, atMs, clock, truthJson, bytes)
		 VALUES (@id, @sessionId, @tSec, @path, @atMs, @clock, @truthJson, @bytes)
		 ON CONFLICT(id) DO NOTHING`
	).run(f)
}

/** Kept on the session row so the UI can show progress without counting rows every poll. */
export const touchJournalSession = (id: string): void => {
	prep(
		"UPDATE journal_session SET frameCount = (SELECT count(*) FROM journal_frame WHERE sessionId = ?) WHERE id = ?"
	).run(id, id)
}

export const countJournalFrames = (sessionId: string): number =>
	num(plain(prep("SELECT count(*) AS c FROM journal_frame WHERE sessionId = ?").get(sessionId))?.c) ?? 0

/**
 * Every frame belonging to a game, oldest first.
 *
 * Joined through the session because that is where the gameId lives — a frame never carries one,
 * so a session claimed later brings all of its frames with it at once.
 */
export const framesForGame = (
	gameId: number
): { id: string; path: string; tSec: number; truthJson: string | null }[] =>
	prep(
		`SELECT f.id AS id, f.path AS path, f.tSec AS tSec, f.truthJson AS truthJson
		   FROM journal_frame f
		   JOIN journal_session s ON s.id = f.sessionId
		  WHERE s.gameId = ?
		  ORDER BY f.tSec ASC`
	).all(gameId) as unknown as { id: string; path: string; tSec: number; truthJson: string | null }[]

/** One frame, by id — for serving the picture beside a coaching point. */
export const journalFrameById = (id: string): { path: string; tSec: number } | null => {
	const row = plain(prep("SELECT path, tSec FROM journal_frame WHERE id = ?").get(id))
	return row ? (row as unknown as { path: string; tSec: number }) : null
}

/** Sessions with no game attached yet — the matcher's input, and the UI's "needs a claim" list. */
export const unclaimedJournalSessions = (): JournalSessionRow[] =>
	prep(
		"SELECT * FROM journal_session WHERE gameId IS NULL AND claim = 'unclaimed' ORDER BY startedMs DESC LIMIT 20"
	).all() as unknown as JournalSessionRow[]

export const claimJournalSession = (id: string, gameId: number, claim: string): void => {
	prep("UPDATE journal_session SET gameId = ?, claim = ? WHERE id = ?").run(gameId, claim, id)
}
