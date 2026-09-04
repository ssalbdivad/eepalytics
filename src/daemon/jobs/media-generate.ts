/**
 * `media-generate` — draw a Summoner's Rift SVG for every moment in a game.
 *
 * THIS JOB MUST NEVER FAIL. It is the reason the product works with the League client shut and
 * with the replay long expired. Every feedback item the coach writes cites a moment, and every
 * moment needs something to look at; since replay capture was removed, a generated map is not
 * the floor any more — it is the only illustration a past game will ever get.
 *
 * So: one moment failing to render skips that moment and keeps going, and the job reports what
 * it managed rather than throwing. The only thing that fails it is not being able to find the
 * game at all.
 *
 * NODE ONLY.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { MEDIA_DIR } from "../../shared/constants.ts"
import { fmtClock, gameSecToMs } from "../../shared/time.ts"
import { dist, lerpPos } from "../../shared/map.ts"
import type { Pos, TeamId } from "../../shared/map.ts"
import type { LcuFrame, LcuTimeline } from "../../shared/schema/lcu.ts"
import type { Media, Moment, ParticipantSummary } from "../../shared/schema/domain.ts"
import { BLOB_TIMELINE, readBlob } from "../../db/blobs.ts"
import {
	getGame,
	getMoments,
	getParticipants,
	insertMedia
} from "../../db/queries.ts"
import { publish } from "../bus.ts"
import { interpolationUncertainty, renderMomentSvg } from "../rift-svg.ts"
import type { PlayerDot } from "../rift-svg.ts"
import type { JobContext, JobOutcome } from "../context.ts"
import { errText } from "../log.ts"

/** Anyone within this many game units of the moment is drawn. ~14% of the map. */
const NEARBY_UNITS = 4200

export interface InterpolatedPosition {
	pos: Pos
	/** Game units of positional uncertainty. 0 = read straight off a frame. */
	uncertainty: number
}

/**
 * Where participant `pid` was at `tMs`, and how much we are guessing.
 *
 * Frames arrive once per minute. A moment that lands exactly on a frame boundary is observed;
 * everything else is a straight-line interpolation between the frames either side, and the
 * returned `uncertainty` is what makes that visible in the drawing instead of hiding it.
 */
export const positionAt = (
	frames: readonly LcuFrame[],
	pid: number,
	tMs: number
): InterpolatedPosition | null => {
	const key = String(pid)
	let before: LcuFrame | null = null
	let after: LcuFrame | null = null
	for (const frame of frames) {
		if (!frame.participantFrames[key]) continue
		if (frame.timestamp <= tMs) before = frame
		else {
			after = frame
			break
		}
	}

	if (before && after) {
		const a = before.participantFrames[key]!.position
		const b = after.participantFrames[key]!.position
		const span = after.timestamp - before.timestamp
		const f = span > 0 ? (tMs - before.timestamp) / span : 0
		return {
			pos: lerpPos(a, b, f),
			uncertainty: f <= 0.001 ? 0 : interpolationUncertainty(tMs)
		}
	}
	// Before the first frame or after the last: the nearest observation, flagged as such.
	const only = before ?? after
	if (!only) return null
	const pos = only.participantFrames[key]?.position
	if (!pos) return null
	const gap = Math.abs(tMs - only.timestamp)
	return { pos, uncertainty: gap < 1000 ? 0 : interpolationUncertainty(tMs) }
}

const labelFor = (p: ParticipantSummary | undefined, pid: number): string =>
	p?.championName && p.championName.length > 0 ? p.championName : `P${pid}`

/** Media id is deterministic, so re-running replaces the file instead of piling up copies. */
export const mapMediaId = (momentId: string): string => `${momentId}-map`

export const buildPlayerDots = (
	frames: readonly LcuFrame[],
	participants: readonly ParticipantSummary[],
	moment: Moment,
	userParticipantId: number
): PlayerDot[] => {
	const byId = new Map(participants.map(p => [p.participantId, p]))
	const focus: Pos = { x: moment.mapX, y: moment.mapY }
	const involved = new Set(moment.participantsInvolved)
	const dots: PlayerDot[] = []

	for (let pid = 1; pid <= 10; pid++) {
		const placed = positionAt(frames, pid, gameSecToMs(moment.tSec))
		if (!placed) continue
		const isUser = pid === userParticipantId
		const near = dist(placed.pos, focus) <= NEARBY_UNITS
		// Always draw the user and anyone the moment names; otherwise only the neighbourhood,
		// so the picture stays legible.
		if (!isUser && !involved.has(pid) && !near) continue
		const p = byId.get(pid)
		dots.push({
			participantId: pid,
			teamId: (p?.teamId ?? (pid <= 5 ? 100 : 200)) as TeamId,
			label: labelFor(p, pid),
			pos: placed.pos,
			isUser,
			uncertainty: placed.uncertainty
		})
	}
	return dots
}

export const runMediaGenerate = async (ctx: JobContext): Promise<JobOutcome> => {
	const gameId = ctx.job.gameId
	if (gameId === null) throw new Error("media-generate requires a gameId")

	const game = getGame(gameId)
	if (!game)
		return {
			defer: {
				reason: "waiting for match-ingest to write the game row",
				untilMs: Date.now() + 30_000
			}
		}

	const moments = getMoments(gameId)
	if (moments.length === 0)
		return { note: "no moments to illustrate yet" }

	const timeline = readBlob<LcuTimeline>(gameId, BLOB_TIMELINE)
	const frames = timeline?.frames ?? []
	const participants = getParticipants(gameId)
	const teamId = (game.teamId === 200 ? 200 : 100) as TeamId

	const dir = `${MEDIA_DIR}/${gameId}`
	mkdirSync(dir, { recursive: true })

	let written = 0
	const failures: string[] = []

	for (const moment of moments) {
		try {
			const dots = buildPlayerDots(frames, participants, moment, game.participantId)
			const svg = renderMomentSvg({
				gameId,
				tSec: moment.tSec,
				title: moment.title,
				kind: moment.kind,
				evidence: moment.evidence,
				focus: { x: moment.mapX, y: moment.mapY },
				camera: moment.cameraTarget,
				teamId,
				players: dots,
				subtitle:
					moment.costGold === null ?
						`confidence ${moment.confidence}`
					:	`${moment.costGold >= 0 ? "+" : ""}${moment.costGold}g · confidence ${moment.confidence}`
			})

			const id = mapMediaId(moment.id)
			const relPath = `media/${gameId}/${id}.svg`
			writeFileSync(`${dir}/${id}.svg`, svg, "utf8")

			const media: Media = {
				id,
				gameId,
				momentId: moment.id,
				kind: "map",
				path: relPath,
				width: 640,
				height: 640 + 74 + 58,
				tSec: moment.tSec,
				createdMs: Date.now(),
				source: "generated",
				bytes: Buffer.byteLength(svg, "utf8"),
				mimeType: "image/svg+xml"
			}
			insertMedia(media)
			written++
		} catch (err) {
			// One bad moment must not cost the other eleven their pictures.
			failures.push(`${moment.id} (${fmtClock(moment.tSec)}): ${errText(err)}`)
			ctx.log.warn("moment render failed", { moment: moment.id, err: errText(err) })
		}
	}

	if (frames.length === 0)
		ctx.log.warn("no timeline frames; maps drawn without player positions", { gameId })

	ctx.progress(`generated ${written} map image(s)`)
	publish("game", { gameId, stage: "media", mediaCount: written }, gameId)

	return {
		note:
			failures.length === 0 ?
				`${written} map images`
			:	`${written} map images, ${failures.length} skipped: ${failures[0]}`
	}
}

export default runMediaGenerate
