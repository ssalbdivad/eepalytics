/**
 * `match-ingest` — pull one game's match + timeline out of the League client, gzip them into
 * blobs, write the `game` and `participant` rows, and queue what comes next.
 *
 * Idempotent: re-running it overwrites the blobs and upserts the rows. `upsertGame`
 * deliberately does not reset `analysisVersion` / `reviewVersion`, so re-ingesting a game
 * never silently invalidates work already done on it.
 *
 * NODE ONLY.
 */

import {
	PLATFORM_ID,
	SMITE_SPELL_ID,
	USER_PUUID,
	patchOf
} from "../../shared/constants.ts"
import {
	findParticipantIdByPuuid,
	identityMap,
	isListEntry,
	riotIdOf,
	teamWon
} from "../../shared/schema/lcu.ts"
import { uncoachableReason } from "../../shared/coachable.ts"
import type { LcuGame, LcuParticipant } from "../../shared/schema/lcu.ts"
import type { ParticipantSummary } from "../../shared/schema/domain.ts"
import { BLOB_MATCH, BLOB_TIMELINE, contentHash, writeBlob } from "../../db/blobs.ts"
import {
	getGame,
	setGameBlobs,
	upsertGame,
	upsertParticipants
} from "../../db/queries.ts"
import type { ParticipantUpsert } from "../../db/queries.ts"
import { publish } from "../bus.ts"
import { championName, refreshChampionNames } from "../champions.ts"
import { fetchGame, fetchTimeline, getCreds } from "../lcu.ts"
import { enqueueAnalysis, enqueueReplayDownload, replayWindowOpen } from "../queue.ts"
import type { JobContext, JobOutcome } from "../context.ts"

/**
 * Smite is how a jungler is identified: exactly one holder per team in 44/44 team-games. The
 * LCU's own `timeline.lane`/`.role` are garbage (four of ten players labelled JUNGLE in one
 * game), so they are never read.
 *
 * This is a PLACEHOLDER, not the real inference: `src/analysis/` owns role assignment from
 * frame positions and overwrites these rows via `setGameRole`. Marking the Smite holder gives
 * the game list something true to show before analysis has run; everyone else stays UNKNOWN
 * rather than guessed.
 */
const provisionalRole = (
	p: LcuParticipant
): { role: ParticipantSummary["role"]; roleConfidence: ParticipantSummary["roleConfidence"] } =>
	p.spell1Id === SMITE_SPELL_ID || p.spell2Id === SMITE_SPELL_ID ?
		{ role: "JGL", roleConfidence: "medium" }
	:	{ role: "UNKNOWN", roleConfidence: "low" }

const toParticipantRows = (game: LcuGame): ParticipantUpsert[] => {
	const identities = identityMap(game)
	return game.participants.map(p => {
		const player = identities.get(p.participantId)
		const { role, roleConfidence } = provisionalRole(p)
		const items = [
			p.stats.item0,
			p.stats.item1,
			p.stats.item2,
			p.stats.item3,
			p.stats.item4,
			p.stats.item5,
			p.stats.item6
		].filter((i): i is number => typeof i === "number")
		return {
			gameId: game.gameId,
			participantId: p.participantId,
			teamId: p.teamId,
			puuid: player?.puuid ?? "",
			riotId: player ? riotIdOf(player) : "",
			championId: p.championId,
			championName: championName(p.championId),
			role,
			roleConfidence,
			isUser: player?.puuid === USER_PUUID,
			kills: p.stats.kills,
			deaths: p.stats.deaths,
			assists: p.stats.assists,
			cs: p.stats.totalMinionsKilled,
			jungleCs: p.stats.neutralMinionsKilled,
			gold: p.stats.goldEarned,
			visionScore: p.stats.visionScore,
			champLevel: p.stats.champLevel,
			damageToChampions: p.stats.totalDamageDealtToChampions,
			win: p.stats.win,
			spell1Id: p.spell1Id,
			spell2Id: p.spell2Id,
			items,
			summonerId: player?.summonerId ?? null,
			// Keep the whole ~118-field stat block verbatim: anything we did not model is still
			// there for a future metric without a re-fetch.
			stats: p.stats
		}
	})
}

/**
 * Only chase a replay we do not already have.
 *
 * `match-ingest` re-runs every time reconcile finds an incomplete game, and a game the client
 * never finishes assembling (a stub) is re-ingested on every tick forever. Without this guard
 * each of those re-runs queued another `replay-download` for a `.rofl` that was already on
 * disk — measured at 15 no-op download jobs in two and a half minutes on one stub game.
 * `absent` is the only state worth a download; `downloading` already has a job, and
 * `available`/`expired`/`pruned` are all settled.
 */
const needsReplay = (gameId: number): boolean => {
	const row = getGame(gameId)
	return !row || row.replayState === "absent"
}

export const runMatchIngest = async (ctx: JobContext): Promise<JobOutcome> => {
	const gameId = ctx.job.gameId
	if (gameId === null) throw new Error("match-ingest requires a gameId")

	if (!getCreds())
		return { defer: { reason: "League client is closed", untilMs: Date.now() + 60_000 } }

	// Cheap and cached; without it every scoreboard row reads "champion 876".
	await refreshChampionNames()

	const game = await fetchGame(gameId)
	if (!game)
		// A game that has only just ended is not in the client's match history yet. That is a
		// timing fact, not a failure, so it must not burn an attempt.
		return {
			defer: {
				reason: "the client does not have this game yet",
				untilMs: Date.now() + 30_000
			}
		}

	if (isListEntry(game)) {
		/*
		 * A game that has only just ended comes back in the LIST shape: full game metadata,
		 * but ONLY the queried summoner among the participants. Observed live, ten minutes
		 * after a game ended.
		 *
		 * Deferring alone would be a trap. `replay-download` needs `gameVersion`, `queueId`
		 * and the end time to create the client's local metadata record, and the replay is
		 * deleted THIRTY MINUTES after the game ends — so waiting for the other nine
		 * participants to show up can cost the user the replay entirely.
		 *
		 * So: write a stub row from the real fields we do have, which unblocks the download
		 * immediately, and deliberately write NO blobs — `gamesNeedingIngest` keys off a null
		 * `matchBlob`, so reconcile re-queues this game until the full match arrives.
		 */
		const stubMe = game.participants[0]
		if (stubMe) {
			const endedAt = game.gameCreation + game.gameDuration * 1000
			upsertGame({
				gameId,
				platformId: game.platformId || PLATFORM_ID,
				queueId: game.queueId,
				gameMode: game.gameMode,
				gameType: game.gameType,
				mapId: game.mapId,
				gameVersion: game.gameVersion,
				patch: patchOf(game.gameVersion),
				gameCreationMs: game.gameCreation,
				gameDurationSec: game.gameDuration,
				endedAtMs: endedAt,
				participantId: stubMe.participantId,
				teamId: stubMe.teamId,
				championId: stubMe.championId,
				championName: championName(stubMe.championId),
				...provisionalRole(stubMe),
				win: stubMe.stats.win,
				kills: stubMe.stats.kills,
				deaths: stubMe.stats.deaths,
				assists: stubMe.stats.assists,
				cs: stubMe.stats.totalMinionsKilled,
				jungleCs: stubMe.stats.neutralMinionsKilled,
				gold: stubMe.stats.goldEarned,
				visionScore: stubMe.stats.visionScore,
				champLevel: stubMe.stats.champLevel,
				damageToChampions: stubMe.stats.totalDamageDealtToChampions
			})
			ctx.progress(
				`stub row written for ${gameId} so the replay download can start; waiting for the full match`
			)
			if (replayWindowOpen(endedAt) && needsReplay(gameId))
				enqueueReplayDownload(gameId, endedAt)
		}
		/*
		 * A Practice Tool or custom game never completes. The LCU returns one participant and
		 * keeps doing so, so this deferred every thirty seconds for the life of the daemon —
		 * measured at 103 deferrals in 52 minutes — and dragged a stuck analysis and a stuck
		 * review along behind it.
		 */
		const why = uncoachableReason(game)
		if (why !== null) return { note: `${why} — not waiting for a match that will not arrive` }

		return {
			defer: {
				reason: `only ${game.participants.length} participant(s) returned; the client is still assembling this match`,
				untilMs: Date.now() + 30_000
			}
		}
	}

	const participantId = findParticipantIdByPuuid(game, USER_PUUID)
	if (participantId === null)
		// Never store a game the user did not play; every metric downstream assumes "you".
		throw new Error(`${USER_PUUID} is not a participant in game ${gameId}`)

	const me = game.participants.find(p => p.participantId === participantId)
	if (!me) throw new Error(`participant ${participantId} missing from game ${gameId}`)

	const timeline = await fetchTimeline(gameId)
	if (!timeline)
		ctx.log.warn("no timeline available; storing the match anyway", { gameId })

	const matchBlob = writeBlob(gameId, BLOB_MATCH, game)
	const timelineBlob = timeline ? writeBlob(gameId, BLOB_TIMELINE, timeline) : null

	const endedAtMs = game.gameCreation + game.gameDuration * 1000
	const team = game.teams?.find(t => t.teamId === me.teamId)
	const win = team ? teamWon(team) : me.stats.win
	const { role, roleConfidence } = provisionalRole(me)
	// Do not downgrade a role the analysis unit already established.
	const existing = getGame(gameId)

	upsertGame({
		gameId,
		platformId: game.platformId || PLATFORM_ID,
		queueId: game.queueId,
		gameMode: game.gameMode,
		gameType: game.gameType,
		mapId: game.mapId,
		gameVersion: game.gameVersion,
		patch: patchOf(game.gameVersion),
		gameCreationMs: game.gameCreation,
		gameDurationSec: game.gameDuration,
		endedAtMs,
		participantId,
		teamId: me.teamId,
		championId: me.championId,
		championName: championName(me.championId),
		role: existing && existing.role !== "UNKNOWN" ? existing.role : role,
		roleConfidence:
			existing && existing.role !== "UNKNOWN" ? existing.roleConfidence : roleConfidence,
		win,
		kills: me.stats.kills,
		deaths: me.stats.deaths,
		assists: me.stats.assists,
		cs: me.stats.totalMinionsKilled,
		jungleCs: me.stats.neutralMinionsKilled,
		gold: me.stats.goldEarned,
		visionScore: me.stats.visionScore,
		champLevel: me.stats.champLevel,
		damageToChampions: me.stats.totalDamageDealtToChampions,
		matchBlob,
		timelineBlob
	})

	upsertParticipants(gameId, toParticipantRows(game))
	setGameBlobs(gameId, { matchBlob, timelineBlob, contentHash: contentHash(gameId) })

	ctx.progress(
		`ingested ${game.gameMode} ${gameId}: ${timeline ? `${timeline.frames.length} frames` : "no timeline"}`
	)
	publish("game", { gameId, stage: "ingested", hasTimeline: timeline !== null }, gameId)

	/* ---- chain the next steps ---- */

	// URGENT and first: the client deletes the .rofl 30 minutes after the game ends.
	if (replayWindowOpen(endedAtMs) && needsReplay(gameId))
		enqueueReplayDownload(gameId, endedAtMs)
	else ctx.log.debug("replay window closed; skipping download", { gameId })

	if (timeline) enqueueAnalysis(gameId)

	return {
		note: `${game.participants.length} participants, ${timeline?.frames.length ?? 0} frames`
	}
}

export default runMatchIngest
