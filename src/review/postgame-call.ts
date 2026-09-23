/**
 * THE CHEAP ARM: one post-game review call, with the pictures attached.
 *
 * ## Why this exists beside `claude.ts`
 *
 * `runCoach` drives the `claude` CLI over stdin. It is text only, and no amount of prompt work
 * changes that — a JPEG cannot go down that pipe. The 37 post-game items he graded 68% useful
 * were produced by arms that were handed SIXTEEN FRAMES of his own screen alongside the pack, so
 * shipping the graded thing means shipping a multimodal call.
 *
 * ## Why the cheap model, stated as a measurement rather than a preference
 *
 * Five models ran the identical frozen bundle (`data/eval/postgame-*.json`, 16 frames each) and
 * were indistinguishable on the blinded grading. They were not indistinguishable on the clock:
 *
 *     gemini flash   38-43 s     opus   330 s
 *     gemini pro      129 s      sonnet 155 s      gpt-5  161 s
 *
 * A debrief he has to wait five minutes for is a debrief he reads after the next game has
 * started. So the default is flash, and the model id is FREE TEXT via `EEPALYTICS_POSTGAME_MODEL`
 * — a default written during this work was refused as "no longer available to new users" inside a
 * minute, so a hardcoded dropdown is a bug that looks like a limitation.
 *
 * ## It returns `CoachResult`, unchanged
 *
 * Every guarantee downstream — `parseCoachOutput`, the citation allowlist, the stored failure row
 * — is keyed to that type, and none of it is re-implemented here. This module chooses a transport
 * and nothing else. It never throws: a provider outage degrades to `{ok: false}` and the caller
 * falls back to the CLI exactly as it would for a timeout.
 *
 * NODE ONLY — reads key files and frame JPEGs off disk.
 */

import { readFileSync, statSync } from "node:fs"
import { extractJson, logRun } from "./claude.ts"
import type { CoachMeta, CoachResult } from "./claude.ts"
import { modelHandleFor, providerById, providerKey } from "./live-providers.ts"
import type { GamePack, PackFrame } from "./pack.ts"
import { resolveJournalPath } from "../daemon/journal.ts"

/** Provider id and model for the automatic post-game pass. Free text, both of them. */
export const POSTGAME_PROVIDER = process.env.EEPALYTICS_POSTGAME_PROVIDER ?? "gemini-http"
export const POSTGAME_MODEL = process.env.EEPALYTICS_POSTGAME_MODEL ?? "gemini-3.6-flash"

/**
 * How many frames go up.
 *
 * SIXTEEN is what the graded bundle sent: at 1536x864 that is about 28K image tokens, already a
 * third of the turn, and the arms that scored 68% saw exactly this many. Lowering it is a change
 * to the thing that was measured, so it is a knob with the measured value as its default.
 */
export const POSTGAME_FRAME_CAP = Number(process.env.EEPALYTICS_POSTGAME_FRAMES ?? 16)

/**
 * How near a journal frame must be to a moment to be called that moment's picture.
 *
 * The browser POSTs a frame every five seconds of game clock — measured over all 2,580 beats in
 * this install's four screen-shared sessions the gap is p50 5.01s, p95 5.12s, and 98% are under
 * six. So six seconds is one beat plus slack and it finds a frame whenever one exists. A wider
 * window would hand the coach a picture of somewhere else and let it describe what it saw — which
 * is the fabrication-with-pictures failure the journal's own claim rules exist to prevent.
 */
export const FRAME_WINDOW_SEC = 6

/**
 * A DEATH IS THE ONE MOMENT WHERE THE FRAME AFTER IT IS WORTHLESS.
 *
 * Seconds after he dies the camera is on his corpse and the picture is a respawn timer. The one
 * worth attaching is the last frame BEFORE it, which still shows the fight. Compare the two real
 * frames around his 8:00 death on game 5639406342, 4.9 seconds apart:
 *
 *   07:57  Lillia mid-fight in the river, four enemies named on screen, 870/1130 HP, the whole
 *          minimap. Everything a coach would point at.
 *   08:02  a corpse, "BACK IN 15", and a scoreboard.
 *
 * So a death's window reaches back a beat and a half and NOT FORWARD AT ALL. The cost is stated
 * rather than hidden: where the beat before a death fell in the 1% of gaps over ten seconds, that
 * death gets no picture instead of a bad one. A respawn timer attached to "you died at 8:12" is
 * evidence of nothing and still spends the image tokens.
 */
const DEATH_WINDOW_BEFORE_SEC = 8
const DEATH_WINDOW_AFTER_SEC = 0

/**
 * A frame that is not a picture of the game being played is not evidence, however near it lands.
 *
 * Two tests, both from the journal's own metadata and neither from the pixels:
 *
 *   * **it carried a ground-truth block.** The block is a live-client read taken at the shutter,
 *     so a frame without one was shot when the client was not answering — the loading screen, a
 *     reconnect, or the moment the session opened. One of the 715 frames on game 5639406342 is
 *     like this, and it is the very first.
 *   * **the game clock was inside the game.** Before about forty seconds he is in the fountain or
 *     still loading; after `durationSec` the nexus has fallen and the screen is the end-of-game
 *     scoreboard. The last frame of that same game is at 1695.8s against a duration of 1694.
 *
 * WHAT THIS CANNOT SEE, said plainly because the alternative is a threshold nobody measured: he
 * shares his whole monitor, so if he alt-tabs mid-game the picture is his desktop while the block
 * reads normally. Nothing in the journal's metadata distinguishes that — file size does not (the
 * bytes of the 340 attributable frames run p05 128K to p95 194K with no second mode), and the
 * block's own clock does not (it trails the shutter by a median 11s and a maximum 21s, which is
 * the brief's cadence, not staleness). Detecting it needs the pixels, and until something reads
 * them the frame index's standing instruction carries it: the pack wins over the picture, and a
 * model that cannot see the game in a frame is told to say so.
 */
const FIRST_SHOWABLE_SEC = 40

export const frameIsShowable = (frame: PackFrame, durationSec: number): boolean =>
	frame.hasBlock && frame.tSec >= FIRST_SHOWABLE_SEC && frame.tSec <= durationSec

export interface ChosenFrame {
	frame: PackFrame
	/** The game clock the moment happened at — NOT the frame's own stamp. */
	momentSec: number
	/** What the pack says was happening. Travels with the picture so the two cannot drift apart. */
	because: string
	gapSec: number
}

/**
 * Pick the frames worth paying for, at DECISION MOMENTS rather than by even spacing.
 *
 * Even spacing puts a picture on the walk between two camps and misses the fight. The order here
 * is a claim about what a reviewer needs to SEE: his deaths first (the thing he most wants
 * explained), then the objectives the enemy took (the join the live path could never make), then
 * the ones his team took, then the minute marks.
 *
 * THE CAP IS SHARED OUT RATHER THAN SPENT IN ORDER, which is the one thing the old comment
 * promised and the old code did not do. Sixteen slots handed to a strict rank ordering go to
 * sixteen deaths in a game with sixteen deaths, and the review then has no picture of a single
 * objective — while its own doc string said a quiet minute beats a sixteenth death. So each tier
 * gets a share of the cap and the leftovers fall through to the next tier in the same order.
 *
 * PURE, so the choice can be tested without a database or a model.
 */

/**
 * At most this share of the cap per tier, before leftovers are handed on.
 *
 * At the default cap of 16: six deaths, four objectives conceded, three taken, three checkpoints.
 * A game with two deaths spends two and the other fourteen still get used, because an unfilled
 * tier gives its slots back.
 */
const TIER_SHARE = [0.4, 0.25, 0.2, 0.2]

interface WantedMoment {
	atSec: number
	because: string
	tier: number
	/** How far back and forward a frame may sit and still be this moment's picture. */
	before: number
	after: number
}

export const chooseFrames = (pack: GamePack, cap = POSTGAME_FRAME_CAP): ChosenFrame[] => {
	if (pack.frames.length === 0 || cap <= 0) return []
	const showable = pack.frames.filter(f => frameIsShowable(f, pack.durationSec))
	if (showable.length === 0) return []

	const wanted: WantedMoment[] = []
	for (const d of pack.deaths)
		wanted.push({
			atSec: d.tSec,
			because: `he died at ${d.clock} in ${d.zone ?? "an unknown zone"}${d.killer ? ` to ${d.killer}` : ""}`,
			tier: 0,
			before: DEATH_WINDOW_BEFORE_SEC,
			after: DEATH_WINDOW_AFTER_SEC
		})
	for (const o of pack.objectives)
		if (o.takenBy === "enemy" && o.what !== "building")
			wanted.push({
				atSec: o.tSec,
				because: `the enemy took ${o.what} at ${o.clock}${o.userZone ? `; the nearest frame puts him in ${o.userZone}` : ""}`,
				tier: 1,
				before: FRAME_WINDOW_SEC,
				after: FRAME_WINDOW_SEC
			})
	for (const o of pack.objectives)
		if (o.takenBy === "his")
			wanted.push({
				atSec: o.tSec,
				because: `his team took ${o.what} at ${o.clock}`,
				tier: 2,
				before: FRAME_WINDOW_SEC,
				after: FRAME_WINDOW_SEC
			})
	for (const c of pack.checkpoints)
		wanted.push({
			atSec: Number(c.clock.split(":")[0]) * 60 + Number(c.clock.split(":")[1]),
			because: `the ${c.askedClock} checkpoint${c.csDiff === null ? "" : ` — ${c.csDiff >= 0 ? "+" : ""}${c.csDiff} CS on his counterpart`}`,
			tier: 3,
			before: FRAME_WINDOW_SEC,
			after: FRAME_WINDOW_SEC
		})

	const taken = new Set<string>()
	const out: ChosenFrame[] = []

	/*
	 * Nearest UNUSED frame inside this moment's own window. Two items landing on one frame is not
	 * a near-miss, it is the same picture captioned twice — the second item takes the next frame
	 * along if one is still in the window, and otherwise goes without.
	 */
	const pick = (want: WantedMoment): ChosenFrame | null => {
		let best: PackFrame | null = null
		let bestGap = Infinity
		for (const f of showable) {
			if (taken.has(f.id)) continue
			const delta = f.tSec - want.atSec
			if (delta < -want.before || delta > want.after) continue
			const gap = Math.abs(delta)
			if (gap < bestGap) {
				bestGap = gap
				best = f
			}
		}
		if (best === null) return null
		taken.add(best.id)
		return {
			frame: best,
			momentSec: want.atSec,
			because: want.because,
			gapSec: Math.round(bestGap * 10) / 10
		}
	}

	let spare = 0
	for (let tier = 0; tier < TIER_SHARE.length; tier++) {
		const share = Math.floor(cap * (TIER_SHARE[tier] ?? 0)) + spare
		let used = 0
		for (const want of wanted.filter(w => w.tier === tier).sort((a, b) => a.atSec - b.atSec)) {
			if (used >= share || out.length >= cap) break
			const got = pick(want)
			if (got === null) continue
			out.push(got)
			used++
		}
		spare = share - used
	}
	// Whatever the shares left on the table goes back to the tiers in order, so a cap is a cap.
	if (out.length < cap)
		for (const want of wanted.sort((a, b) => a.tier - b.tier || a.atSec - b.atSec)) {
			if (out.length >= cap) break
			if (out.some(c => c.momentSec === want.atSec && c.because === want.because)) continue
			const got = pick(want)
			if (got !== null) out.push(got)
		}

	return out.sort((a, b) => a.momentSec - b.momentSec)
}

/** The index the model reads beside the images. Same order as the parts, or it is worthless. */
export const renderFrameIndex = (chosen: readonly ChosenFrame[]): string => {
	if (chosen.length === 0) return ""
	const L = [
		`## FRAMES ATTACHED — ${chosen.length} screenshots of his own screen, in this order`,
		"",
		`Each was recorded while he played and is placed on the game clock by a live-client read at the shutter, not by a browser timestamp. "gap" is how far the picture is from the moment it was chosen for.`,
		"",
		`A frame is EVIDENCE OF WHAT WAS ON HIS SCREEN. It is not a measurement: every figure still comes from the pack. If a picture and the pack disagree, the pack wins and you say so.`,
		""
	]
	chosen.forEach((c, i) => {
		L.push(`${i + 1}. ${c.frame.clock} (gap ${c.gapSec}s) — ${c.because}`)
	})
	L.push("")
	return L.join("\n")
}

/* ============================================================== the call */

/** Total bytes of frames we are willing to put in one turn. A guard, not a tuning knob. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024

const emptyMeta = (model: string, durationMs: number): CoachMeta => ({
	transport: "api",
	model,
	durationMs,
	attempts: 1,
	usage: {
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheCreationTokens: null,
		costUsd: null
	},
	sessionId: null,
	turns: null,
	warnings: []
})

export interface PostgameCallRequest {
	system: string
	user: string
	frames: readonly ChosenFrame[]
	provider?: string
	model?: string
	signal?: AbortSignal
	/** Generous on purpose: a tight cap does not shorten a reasoning model, it truncates one. */
	maxOutputTokens?: number
}

/** True when this machine can actually make the call. Checked before anything is built. */
export const postgameArmAvailable = (providerId = POSTGAME_PROVIDER): boolean => {
	const p = providerById(providerId)
	return p !== undefined && providerKey(p) !== null
}

/**
 * One call. Never throws.
 *
 * The frames are read off disk HERE rather than by the caller, through `resolveJournalPath`,
 * because `journal_frame.path` is stored absolute and 503 of this install's rows still point at
 * the directory the app had before it was renamed. A frame whose bytes cannot be read is DROPPED
 * and named in `meta.warnings` — a review with fourteen pictures is worth having; one that fails
 * because the fifteenth moved is not.
 */
export const runPostgameCoach = async (req: PostgameCallRequest): Promise<CoachResult> => {
	const started = Date.now()
	const providerId = req.provider ?? POSTGAME_PROVIDER
	const model = req.model ?? POSTGAME_MODEL
	const warnings: string[] = []

	const p = providerById(providerId)
	if (!p)
		return {
			ok: false,
			code: "no-transport",
			error: `no provider called ${providerId}`,
			text: null,
			meta: emptyMeta(model, Date.now() - started)
		}
	const key = providerKey(p)
	if (!key)
		return {
			ok: false,
			code: "no-transport",
			error: `no key for ${p.id} — put one in data/${p.keyFile}`,
			text: null,
			meta: emptyMeta(model, Date.now() - started)
		}

	const images: { type: "image"; image: Buffer; mediaType: string }[] = []
	let bytes = 0
	for (const c of req.frames) {
		const path = resolveJournalPath(c.frame.path)
		try {
			const size = statSync(path).size
			if (bytes + size > MAX_FRAME_BYTES) {
				warnings.push(`stopped attaching frames at ${images.length} — the turn hit ${MAX_FRAME_BYTES} bytes`)
				break
			}
			images.push({ type: "image", image: readFileSync(path), mediaType: "image/jpeg" })
			bytes += size
		} catch {
			warnings.push(`frame ${c.frame.id} (${c.frame.clock}) is no longer on disk`)
		}
	}
	// The index names pictures in order, so it must describe the ones that actually went.
	const attached = req.frames.slice(0, images.length)

	try {
		const { generateText } = await import("ai")
		const handle = await modelHandleFor(p, key, model)
		const result = await generateText({
			model: handle,
			system: req.system,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: req.user },
						...(attached.length > 0 ?
							[{ type: "text" as const, text: renderFrameIndex(attached) }]
						:	[]),
						...images
					]
				}
			],
			maxOutputTokens: req.maxOutputTokens ?? 32_000,
			...(req.signal ? { abortSignal: req.signal } : {})
		})
		const durationMs = Date.now() - started
		const usage = result.usage as { inputTokens?: number; outputTokens?: number } | undefined
		const meta: CoachMeta = {
			...emptyMeta(model, durationMs),
			usage: {
				inputTokens: usage?.inputTokens ?? null,
				outputTokens: usage?.outputTokens ?? null,
				cacheReadTokens: null,
				cacheCreationTokens: null,
				costUsd: null
			},
			warnings: [...warnings, `${images.length} frame(s) attached`]
		}
		/*
		 * THE SAME LINE THE CLI PATH WRITES, because this is the path that ships. `coach.jsonl` had
		 * not been appended to since 2026-09-18 — four days and six reviewed games — for no reason
		 * other than that the writer lived in `claude.ts` and reviews had moved here. A cost log
		 * that stops covering the shipped path is the same defect as a coverage record that is
		 * never written, and this evening found three of those.
		 */
		const text = result.text ?? ""
		if (text.trim() === "") {
			const failed: CoachResult = {
				ok: false,
				code: "empty-output",
				error: `${model} returned no text`,
				text: null,
				meta
			}
			logRun("postgame", failed)
			return failed
		}
		const data = extractJson(text)
		if (data === undefined) {
			const malformed: CoachResult = {
				ok: false,
				code: "malformed-json",
				error: `no JSON object could be recovered from ${text.length} chars`,
				text,
				meta
			}
			logRun("postgame", malformed)
			return malformed
		}
		const done: CoachResult = { ok: true, data, text, meta }
		logRun("postgame", done)
		return done
	} catch (err) {
		const durationMs = Date.now() - started
		const aborted = req.signal?.aborted === true
		const failed: CoachResult = {
			ok: false,
			code: aborted ? "aborted" : "api-error",
			error: String(err instanceof Error ? err.message : err),
			text: null,
			meta: { ...emptyMeta(model, durationMs), warnings }
		}
		// The outage is the case the bill and the latency history most need to carry.
		logRun("postgame", failed)
		return failed
	}
}
