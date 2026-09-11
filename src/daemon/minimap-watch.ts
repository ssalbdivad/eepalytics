/**
 * READING THE MINIMAP ON THE JOURNAL BEAT, off the coach's thread entirely.
 *
 * ## The measurement this exists for
 *
 * A position read is only worth anything while it is young. Measured on the 94 stored games, by
 * pairing a once-a-minute participant frame with a later event carrying its own millisecond stamp
 * (2,602 pairs, chance agreement 31.8%), a read still names the right HALF of the map on 96.2% of
 * pairs at 0-5s and 67.3% at 25-30s — and then one five-second bucket costs fifteen points and the
 * curve is flat at a coin flip out to a minute. `CARRY_MAX_SEC` in `server/routes/live.ts` is that
 * knee and is where the brief stops printing a position at all.
 *
 * Supply, not carry, was the binding constraint. The read used to be taken ONLY in front of a
 * coaching turn, and a reactive turn — 42% of the event-driven turns on the graded run of game
 * 5639406342 — deliberately skips it, because a death's premise is 40% stale at one second. So the
 * median reactive turn sat 136 seconds from the last accepted read: past the knee, past
 * `CARRY_MAX_SEC`, and therefore silent about where he was on exactly the turns where where-he-is
 * decides the sentence.
 *
 * The browser already POSTs a journal frame every five seconds while he is sharing. That beat is
 * four times denser than the ranked modes' twenty-second one and it runs whether or not a turn is
 * being taken, so reading the minimap off it is the only way most turns can have a read at all.
 *
 * MEASURED, by replaying that game's 340 real frames through this exact schedule and the shipped
 * reader, then asking the stored 38-turn graded run's own turn times how old their read would have
 * been (`scripts/minimap-watch-replay.ts`; 340 reads, 196 past the fence, 193 placed him):
 *
 *                                            shipped           on the journal beat
 *     turns with a position at all          17 of 38  44.7%      30 of 38  78.9%
 *     turns with one inside FRAME_FRESH_SEC 17 of 38  44.7%      24 of 38  63.2%
 *     median age of the read                        0-2s                  4.8s
 *     paid for on the turn's critical path   p50 1,510ms                     0ms
 *
 * The shipped column is not an estimate: it is counted out of the payloads stored in
 * `data/eval/stream-kayn-events2-20260910.json`, 21 of which say "no usable position" in full.
 * A read is a little OLDER here and there are far more of them, which is the trade the measured
 * decay curve says to take — 92.3% of reads still name the right half at ten seconds.
 *
 * ## Three properties, and each of them is a rule rather than a nicety
 *
 * 1. **A read never costs a line.** `offerFrame` returns synchronously and never throws. The model
 *    call runs detached. A slow read, a failed read, a missing `ffmpeg`, a missing key — every one
 *    of them costs a POSITION, and the coach says exactly what it says today.
 * 2. **The fence is untouched.** `readMinimap` is imported, not reimplemented, and it is handed the
 *    same five-field `FrameTruth` the POST path builds — derived from the very `allgamedata` poll
 *    that stamped this frame's game clock, so it is the truth AT THE SHUTTER rather than the truth
 *    at the last coaching turn. A refused read stores nothing and clears nothing. 44% of reads on
 *    the graded game were refused and the fence was right every time.
 * 3. **Nothing queues.** At most one read is in flight. A frame arriving while one is running is
 *    DROPPED, not buffered: the next frame is five seconds away and is a better picture than the
 *    one that was waiting. An unbounded queue during a game is how a 28-minute game ends with a
 *    backlog of reads about minute four.
 *
 * ## Rate, and why the cadence is a knob rather than "every frame"
 *
 * Every journal frame is one flash-tier call. MEASURED on `gemini-3.1-flash-lite`, one read is
 * 1,321 prompt tokens (1,089 of them the image — a 288px crop and a 1152px one are padded to the
 * same tile budget, which is why upscaling is free) and 123 output tokens. At the standard tier's
 * $0.25/M in and $1.50/M out that is **$0.000515 a read**: **$0.175 for a 28-minute game** and
 * **$0.37 an hour of play**, at 339 reads a game. The cadence floor below is on the GAME clock, so
 * it is the same number of reads for the same game however the browser's wall-clock beat drifts,
 * and a paused game pays nothing.
 *
 * NODE ONLY — spawns `ffmpeg` and holds the API key's call.
 */

import { execFile } from "node:child_process"
import { MINIMAP_REGION, coarseOf } from "../review/frame-read.ts"
import type { Coarse, FrameRead, FrameReadXY, FrameTruth } from "../review/frame-read.ts"
import type { Zone } from "../shared/map.ts"
import { readMinimap } from "../review/read-minimap.ts"
import { makeLogger } from "./log.ts"

const log = makeLogger("minimap-watch")

/**
 * The floor between two reads, ON THE GAME CLOCK.
 *
 * FOUR, AND NOT FIVE, AND THE DIFFERENCE IS JITTER RATHER THAN CADENCE. The browser's journal beat
 * IS five seconds — over the 340 frames of game 5639406342 the gap between stored frames is p50
 * 5.01s — but it wobbles around it: p10 4.96s, and **117 of 339 gaps fall just UNDER five**. A floor
 * set at the nominal beat therefore refuses a third of the frames for being a few hundredths of a
 * second early, and the delivered cadence collapses to ~7s. Measured, by replaying the shipped
 * reader over every one of those frames and asking the two stored graded runs' own turn times how
 * old their read would have been (`scripts/minimap-watch-replay.ts`, 38-turn run):
 *
 *     floor   reads   read <= 10s   read <= 30s   median age
 *       0s     340      63.2%         78.9%          4.8s
 *       4s     339      63.2%         78.9%          4.8s     <- here
 *       5s     243      52.6%         68.4%          9.5s
 *      10s     145      44.7%         60.5%         13.5s
 *      15s     101      15.8%         52.6%         22.1s
 *
 * So four seconds buys every frame the browser sends — 339 of 340, the one refusal being a genuine
 * 1.52s burst — while five seconds costs eleven points of present-tense coverage for a 28% saving on
 * a bill that is 37 cents an hour. The cliff between 10s and 15s is the same knee `CARRY_MAX_SEC` is drawn at,
 * arriving from the other direction: past a ten-second cadence there is almost no turn left with a
 * read that is a statement about the present.
 *
 * It is a FLOOR and not a target. The browser's beat drifts, a frame is dropped while a read is in
 * flight, and a paused game stops the clock — all three make the real cadence sparser than this,
 * never denser, which is the direction that spends less money.
 */
export const WATCH_EVERY_SEC = Number(process.env.EEPALYTICS_MINIMAP_EVERY_SEC ?? 4)

/** Off switch. Any value but the empty string and `0` leaves the watcher running. */
const ENABLED = (process.env.EEPALYTICS_MINIMAP_WATCH ?? "1") !== "0"

/**
 * How many accepted reads are kept.
 *
 * TWELVE, which is a minute of the 5s beat. The history is here because two reads ten seconds apart
 * say which way he is MOVING and either one alone does not — "topside ten seconds ago, river now"
 * is a different fact from either half of it. A minute is as far back as that stays interesting:
 * past `CARRY_MAX_SEC` a single read is a coin flip about his half, and a pair of coin flips is not
 * a direction.
 */
const TRACK_MAX = 12

/**
 * After a refusal the model itself made, wait this long before paying for another one.
 *
 * A 429 is the only outcome here that gets WORSE when it is retried, so it is the only one that
 * earns a real backoff. Transport failures get the same treatment on the cheap argument: whatever
 * broke will still be broken five seconds from now, and this is a nice-to-have running inside a
 * live game.
 *
 * THERE IS NO RETRY. Not once, not on the next frame with the same picture. A retry is how a
 * harness launders a wrong read into a right one, and here it is also how a rate limit becomes a
 * rate-limit storm.
 */
const COOLDOWN_MS = 30_000
const RATE_LIMIT_COOLDOWN_MS = 120_000

/**
 * Long enough for the crop, short enough that the whole read cannot outlive two beats.
 *
 * MEASURED on this machine: the crop above runs in 125ms per frame (five in 626ms, 1536x864 JPEG,
 * 4x lanczos). A second and a half is twelve times that, and it is chosen so that the worst case
 * for a whole read — a hung `ffmpeg` plus `MINIMAP_TIMEOUT_MS` — is 4.5s against a 4s floor. The
 * cost of blowing that is ONE dropped frame, because a frame arriving while a read is in flight is
 * dropped rather than queued; the reason to bound it anyway is that an unbounded one would drop
 * every frame after it.
 */
const CROP_TIMEOUT_MS = 1500

/** Four times native — what every accuracy figure quoted in `read-minimap.ts` was measured at. */
const UPSCALE = 4
/** The quality `scripts/minimap-track.ts` read at, so these pixels are those pixels. */
const CROP_QUALITY = "3"

export interface WatchedRead {
	/** The read that passed the fence. Never a refused one, never a repaired one. */
	read: FrameRead
	/**
	 * The same read as POINTS, before the zone labels. Carried because a distance to a pit cannot
	 * be taken from a zone label — `analysis/reachability.ts` needs the point, and the watcher is
	 * the only place on the journal beat that ever holds one.
	 */
	xy: FrameReadXY
	/**
	 * The GAME clock the picture was taken at — the journal's own stamp, made from a live-client
	 * read at the instant the frame arrived. Not when the model answered: the reader costs a
	 * measured p50 1,239ms, and stamping on the way out would spend an eighth of `CARRY_MAX_SEC`
	 * on the act of looking.
	 */
	atSec: number
	/** Wall clock the read was accepted. Diagnostics only; nothing downstream ages on it. */
	atMs: number
	/** What the read cost, so a report can quote the real distribution rather than the estimate. */
	ms: number
	/** The journal session, so a read from the previous game can be recognised and dropped. */
	sessionId: string
}

export interface WatchStatus {
	enabled: boolean
	/** Reads offered, read, accepted and refused since the last reset. All four, or none of them. */
	offered: number
	started: number
	accepted: number
	refused: number
	/** Frames dropped because a read was already in flight — the queue that is not a queue. */
	skippedBusy: number
	/** Frames dropped because the cadence floor said no. */
	skippedPaced: number
	/** Frames dropped while backing off after a refusal the model made. */
	skippedCooldown: number
	inFlight: boolean
	lastReason: string | null
	sessionId: string | null
}

let track: WatchedRead[] = []
/** Accepted reads that `server/routes/live.ts` has not landed yet. Drained, never read twice. */
let pending: WatchedRead[] = []
let inFlight = false
let cooldownUntilMs = 0
let lastReadSec: number | null = null
let session: string | null = null
let counts = {
	offered: 0,
	started: 0,
	accepted: 0,
	refused: 0,
	skippedBusy: 0,
	skippedPaced: 0,
	skippedCooldown: 0
}
let lastReason: string | null = null

const zeroCounts = (): typeof counts => ({
	offered: 0,
	started: 0,
	accepted: 0,
	refused: 0,
	skippedBusy: 0,
	skippedPaced: 0,
	skippedCooldown: 0
})

/**
 * Forget the track. A new journal session, or a clock that has gone backwards, is a new game.
 *
 * A position belongs to the game it was taken in as hard as a roster does: game N's topside read
 * would gate game N+1's first objective call, which is the same class of bug as a socket spanning
 * two games.
 *
 * `inFlight` is deliberately NOT cleared. A call is still out there, and its answer is dropped on
 * arrival by the session check rather than by pretending it was never made — clearing the flag
 * would let a second call start beside the first, which is the one thing this module promises never
 * to do.
 */
export const resetMinimapWatch = (): void => {
	track = []
	pending = []
	lastReadSec = null
	session = null
	lastReason = null
	cooldownUntilMs = 0
	counts = zeroCounts()
}

/** Every accepted read still in the window, oldest first. The caller may not mutate it. */
export const minimapTrack = (): readonly WatchedRead[] => track

/** The freshest accepted read, or null. */
export const latestMinimapRead = (): WatchedRead | null => track.at(-1) ?? null

/**
 * Take the accepted reads that have not been landed yet, oldest first, and clear them.
 *
 * A DRAIN rather than a getter because the consumer's rules are stateful: `observationFrom` doubts
 * a read that disagrees with the one before it, so reads have to arrive in order and exactly once.
 */
export const takeMinimapReads = (): WatchedRead[] => {
	const out = pending
	pending = []
	return out
}

export const minimapWatchStatus = (): WatchStatus => ({
	enabled: ENABLED,
	...counts,
	inFlight,
	lastReason,
	sessionId: session
})

/**
 * WHICH WAY HE IS MOVING, from the two ends of the window — or null when the track cannot say.
 *
 * This is the thing a HISTORY buys that a latest-value does not. One read is a point; two reads ten
 * seconds apart are a vector, and "topside ten seconds ago, river now" is a different fact from
 * either half of it — it is the difference between a coach that knows he is already walking to the
 * pit and one that tells him to start.
 *
 * PURE, AND NOT WIRED INTO ANY PAYLOAD. A direction is a new FACT, and a new fact belongs in
 * `buildFacts` behind its own measurement — the reader's own half-of-the-map accuracy is 17 of 18,
 * so a direction built from two reads is right about 89% of the time at best, and nothing has
 * measured what that does to a sentence. It is exported so that the measurement can be made
 * without building the mechanism twice.
 *
 * Null whenever there is nothing honest to say: fewer than two placed reads inside the window, or
 * two reads that agree — standing still is not a direction.
 */
export const minimapDrift = (
	entries: readonly WatchedRead[],
	nowSec: number,
	withinSec = 20
): { from: Coarse; to: Coarse; overSec: number } | null => {
	const placed = entries.filter(e => e.read.you !== null && nowSec - e.atSec <= withinSec)
	const first = placed[0]
	const last = placed.at(-1)
	if (!first || !last || first === last) return null
	const from = coarseOf(first.read.you as Zone)
	const to = coarseOf(last.read.you as Zone)
	if (from === to) return null
	return { from, to, overSec: Math.round((last.atSec - first.atSec) * 10) / 10 }
}

/**
 * WHETHER THIS FRAME GETS READ, as a pure decision over the state it depends on.
 *
 * Separated out because every one of these branches is a way the watcher can silently spend nothing
 * or spend everything, and none of them can be exercised through `offerFrame` without a live game,
 * an API key and a five-second wait. The stateful half below is then a dispatch and a counter.
 *
 * `"new-game"` is a read as well as a reset: the first frame of a game is the one turn of that game
 * on which nothing at all is known about where he is.
 */
export type Admission = "read" | "new-game" | "busy" | "cooldown" | "paced" | "off"

/**
 * Whether a verdict may actually START a read, given whether one is already out.
 *
 * `admit` answers a different question from this one, deliberately: it answers "what IS this
 * frame", and it tests the game boundary ABOVE every gate because a new session has to roll the
 * track even when the watcher is busy, cooling down or inside its cadence floor. That is right, and
 * on its own it broke the promise one line of this module's docblock makes and one comment in
 * `resetMinimapWatch` repeats: at most one read is ever in flight.
 *
 * The path: a read for game N is out when game N+1's first frame arrives. `admit` says `new-game`,
 * `offerFrame` resets the track — correctly — and then falls straight through to `inFlight = true`
 * and a SECOND `run`. The first one to finish clears the flag while the other is still running, so
 * the next frame four seconds later starts a third beside it, and the steady state from there is
 * two paid reads in flight for the rest of the game.
 *
 * Two concurrent reads is not only twice the bill. They can RESOLVE OUT OF ORDER, and every rule
 * downstream of `takeMinimapReads` is written on the premise that they do not: `observationFrom`
 * doubts a read that disagrees with "the one before it", `landRead` overwrites the carry
 * unconditionally, and `drainMinimapReads`'s own docblock calls the ordering load-bearing. An older
 * read landing last replaces a newer carry with a staler one and can flip `lastFrameSide`
 * backwards, which manufactures the `low` verdict that means silence.
 *
 * So the reset and the read are two decisions. The boundary is still noticed on the frame it
 * arrives on — the track is rolled, the cooldown cleared, game N's reads dropped — and the READ
 * waits for the next frame, which is four seconds away and is a better picture anyway. That is the
 * same trade `"busy"` already makes on every other frame.
 */
export const startsRead = (verdict: Admission, inFlight: boolean): boolean =>
	(verdict === "read" || verdict === "new-game") && !inFlight

export const admit = (
	state: {
		enabled: boolean
		inFlight: boolean
		cooldownUntilMs: number
		lastReadSec: number | null
		sessionId: string | null
	},
	frame: { tSec: number; sessionId: string },
	nowMs: number,
	everySec: number = WATCH_EVERY_SEC
): Admission => {
	if (!state.enabled) return "off"
	/*
	 * THE GAME BOUNDARY IS TESTED FIRST, above every gate that could swallow it.
	 *
	 * A new session or a clock that went backwards has to reset the track even when the watcher is
	 * busy, cooling down or inside its cadence floor — otherwise game N's last read survives into
	 * game N+1 for as long as whichever gate fired stays true, which for the 120-second rate-limit
	 * backoff is most of the first two minutes of the new game.
	 */
	if (frame.sessionId !== state.sessionId) return "new-game"
	if (state.lastReadSec !== null && frame.tSec < state.lastReadSec) return "new-game"
	if (state.inFlight) return "busy"
	if (nowMs < state.cooldownUntilMs) return "cooldown"
	if (state.lastReadSec !== null && frame.tSec - state.lastReadSec < everySec) return "paced"
	return "read"
}

/**
 * Offer one journal frame to the reader. Returns immediately, always, and never throws.
 *
 * THE SYNCHRONOUS RETURN IS THE POINT. This is called from the journal's write path, which runs on
 * every beat of a live game and must not be able to be slowed, blocked or interrupted by a model
 * call. Everything below the dispatch happens on its own.
 */
export const offerFrame = (input: {
	/** The stored frame on disk. `ffmpeg` reads the file rather than a pipe — one less moving part. */
	framePath: string
	/** The journal's own game-clock stamp for this frame. */
	tSec: number
	sessionId: string
	/** The five facts the fence checks, from the poll that stamped this frame. */
	truth: FrameTruth
}): void => {
	try {
		const verdict = admit(
			{ enabled: ENABLED, inFlight, cooldownUntilMs, lastReadSec, sessionId: session },
			input,
			Date.now()
		)
		if (verdict === "off") return
		if (verdict === "new-game") {
			resetMinimapWatch()
			session = input.sessionId
		}
		counts.offered++
		if (verdict === "busy") return void counts.skippedBusy++
		if (verdict === "cooldown") return void counts.skippedCooldown++
		if (verdict === "paced") return void counts.skippedPaced++
		/*
		 * The boundary has been taken; the READ still has to wait for the wire. See `startsRead` —
		 * a `new-game` frame that arrives while game N's read is still out would otherwise start a
		 * second one beside it, which is the one thing this module promises never to do.
		 */
		if (!startsRead(verdict, inFlight)) return void counts.skippedBusy++

		inFlight = true
		lastReadSec = input.tSec
		counts.started++
		const forSession = input.sessionId
		void run(input).then(
			out => {
				inFlight = false
				if (out === null) return
				// The game may have rolled while the call was out. A read stamped in the previous
				// game is not evidence about this one.
				if (forSession !== session) return
				counts.accepted++
				const entry: WatchedRead = {
					read: out.read,
					xy: out.xy,
					atSec: input.tSec,
					atMs: Date.now(),
					ms: out.ms,
					sessionId: forSession
				}
				track = [...track, entry].slice(-TRACK_MAX)
				pending = [...pending, entry].slice(-TRACK_MAX)
			},
			() => {
				// `run` cannot reject. This is the belt to its braces: an unhandled rejection inside
				// a live game would take the daemon down for a nice-to-have.
				inFlight = false
			}
		)
	} catch (err) {
		inFlight = false
		log.warn(`offer failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/** Crop the minimap out of a stored frame and hand it back base64. Null on any failure. */
const cropMinimap = (framePath: string): Promise<string | null> =>
	new Promise(resolve => {
		/*
		 * FRACTIONS, not the pixel rectangle `minimapRect` computes, so this never has to know how
		 * big the frame is. They are the same numbers: `MINIMAP_REGION` is that rectangle over the
		 * shipped 1536x864 grab, and `iw*1246/1536` is 1246. A frame at another size gets the same
		 * proportional crop instead of a rectangle measured for a screen it does not have.
		 */
		const filter =
			`crop=iw*${MINIMAP_REGION.width}:ih*${MINIMAP_REGION.height}:` +
			`iw*${MINIMAP_REGION.left}:ih*${MINIMAP_REGION.top},` +
			`scale=iw*${UPSCALE}:ih*${UPSCALE}:flags=lanczos`
		execFile(
			"ffmpeg",
			["-y", "-loglevel", "error", "-i", framePath, "-vf", filter, "-q:v", CROP_QUALITY, "-f", "mjpeg", "pipe:1"],
			{ timeout: CROP_TIMEOUT_MS, maxBuffer: 8_000_000, encoding: "buffer" },
			(err, stdout) => {
				if (err || !stdout || stdout.length === 0) return resolve(null)
				resolve(stdout.toString("base64"))
			}
		)
	})

/**
 * One whole read, from a file on disk to a fenced answer. NEVER rejects.
 *
 * A refusal is not an error and is not retried: `fenced` and `schema` are ANSWERS about this
 * picture, and the next picture is five seconds away.
 */
const run = async (input: {
	framePath: string
	tSec: number
	truth: FrameTruth
}): Promise<{ read: FrameRead; xy: FrameReadXY; ms: number } | null> => {
	try {
		const crop = await cropMinimap(input.framePath)
		if (crop === null) {
			counts.refused++
			lastReason = "crop-failed"
			// No `ffmpeg`, or no readable frame. Neither gets better in five seconds, so back off
			// rather than spawning a doomed process on every beat for the rest of the game.
			cooldownUntilMs = Date.now() + COOLDOWN_MS
			return null
		}
		const out = await readMinimap({ jpegBase64: crop, truth: input.truth })
		if (!out.read) {
			counts.refused++
			lastReason = out.reason
			/*
			 * Only the model's own transport failures earn a wait. `fenced`, `schema` and a read
			 * that simply could not place him are normal outcomes at this cadence — 44% of reads on
			 * the graded game were refused and the fence was right every time — and pausing on them
			 * would turn the reader off for two minutes every time he stood in a bush.
			 */
			if (out.reason === "http-429") cooldownUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS
			else if (out.reason.startsWith("http-5") || out.reason === "no-key")
				cooldownUntilMs = Date.now() + COOLDOWN_MS
			return null
		}
		lastReason = null
		return { read: out.read, xy: out.xy, ms: out.ms }
	} catch (err) {
		counts.refused++
		lastReason = "error"
		log.warn(`read failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}
