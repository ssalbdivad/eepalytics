/**
 * Reading the MINIMAP — the one thing on screen that no other channel in this app can supply.
 *
 * ## Why this exists
 *
 * Measured on the real socket with real stored frames, on the same night, two results that only
 * make sense together:
 *
 *   A. **The model reads the frame perfectly.** Asked for the game clock in the corner: 6/6 exact,
 *      1100 image tokens a turn. Asked with no image attached: 0/6, and it invented a plausible
 *      number 6 times out of 6.
 *   B. **And it ignores the frame completely when coaching.** Two arms, n=14 turns each, identical
 *      blocks and the shipped prompt, differing only in whether the JPEG was attached. The
 *      speak-or-PASS decision matched on 13 of 14 turns, and where both spoke the lines were
 *      near-verbatim paraphrases. Every spoken line in both arms was derivable from the block.
 *
 * That was not a model failing, it was this repo's architecture of the time working exactly as
 * written. `analysis/live-facts.ts` computed and RANKED every candidate line in TypeScript and the
 * prompt let the model speak only from that list — an empty list meant PASS. Not one ranked fact
 * was computed from pixels, so the picture could not reach the coach's mouth, by construction. The
 * owner spent ten games concluding the coach was not looking at his screen. It was looking, and it
 * had nowhere to put what it saw.
 *
 * THE FENCE IS GONE (`shared/live-coach-mode.ts`, default `trusted`) and this module outlived it,
 * for a reason the ablation did not change: a model reading two-pixel dots off a whole downscaled
 * frame lands a median 43% of the map's width from the truth, i.e. at chance. Position has to come
 * from a dedicated, magnified, CONSTRAINED read whether or not anything downstream is a menu. What
 * changed is where the answer goes — it is rendered into the brief as prose and as a structured
 * `PositionFix`, rather than being converted into ranked facts.
 *
 * ## What the frame knows that the client does not
 *
 * The Live Client Data API gives the roster, everyone's CS and level, his gold, items, deaths and
 * the clock. It does not give **where anybody is** — there are no positions in it at all. The
 * minimap has them: wards and champions standing in his team's vision render as icons, and that is
 * the single highest-value live fact for a jungler.
 *
 * ## "Not visible" means NOT IN HIS ATTENTION, and that distinction is deliberate
 *
 * `AGENTS.md` gates every spoken line on two tests: not visible (could he have got it by looking at
 * his screen?) and not generic. The minimap is, strictly, rendered on his monitor, so a literal
 * reading of the first test bans everything here.
 *
 * That reading is wrong and it is worth saying why in code rather than leaving it to be
 * rediscovered. A jungler's eyes are on his champion; the minimap is 6% of the screen in the far
 * corner, and the whole reason a coach sits beside a player is to read it out for him — "he's
 * topside, take drake" is the oldest useful sentence in the game. The bar stays high, and it is the
 * bar this file enforces rather than a mood: a sighting earns a sentence only when it is something
 * he is plausibly not tracking AND it changes a decision. Everything else is a HUD readout with a
 * new source, which is the failure `live-facts.ts` spent months gating out.
 *
 * ## MEASURED: what it can read, and what it cannot
 *
 * `scripts/probe-minimap.ts` — 20 frames from five real games, each with a ground-truth block
 * written within three seconds of the picture, read three times each by `gemini-3.1-flash-lite` over
 * HTTPS. Four conditions, varying how the frame is cut and whether the answer is a zone NAME out of
 * thirteen or a POSITION the code then names:
 *
 *                                    whole frame        minimap crop, 4x
 *                                    name      xy       name      xy
 *   agrees with itself on the zones    8%      17%       47%      48%
 *   enemy count exact                  0%       0%       78%      44%
 *   enemy count within one            39%      17%      100%      89%
 *   his own zone, exactly             11%       6%       39%      83%
 *   his own HALF of the map           44%      33%       78%      94%
 *   per icon, right zone                —      21%         —      63%
 *   median position error               —      43%         —       3%   (% of the map's width)
 *   image tokens per read           1,100   1,100     1,089   1,089
 *
 * Agreement is over all 60 reads; everything scored against a human is over the 18 reads of the six
 * hand-labelled frames, which is a small n and is stated as one wherever it is quoted. Every row
 * above is re-derivable: the runs are kept in `data/eval/minimap/`, and the probe replays the same
 * frames from the journal.
 *
 * **1. The frame this app actually sends is BLIND to the minimap.** Given the whole 1536x864
 * screenshot the model does not read the minimap, it CONFABULATES a League game: a median position
 * error of 43% of the map's width is a randomly chosen point, the counts settle at four and five,
 * and the zones come back as top lane, mid lane, bot lane. It agreed with its own previous answer
 * about where the enemies were on 5 of 60 pairs of reads of the same picture. That is the same
 * behaviour the retired `probe-vision.ts` found by removing the image entirely — a plausible
 * answer, six times out of six. So the coach was never going to say anything true about position from the
 * frame it is being sent, however the prompt were written.
 *
 * **2. Cropping to the minimap and upscaling it is what makes it see, and it is FREE.** Gemini bills
 * 1,089 image tokens for the 288px crop and for the same crop at 1152px, against 1,100 for the whole
 * frame: a small image is padded up to the same tile budget as a large one. There is no accuracy /
 * cost trade-off here to reason about. The only cost is that the crop has no HUD in it, so anything
 * read off the main viewport has to come from a second look at the whole frame.
 *
 * **3. Asking WHERE beats asking WHICH ZONE, by a lot.** Same crop, same model: his own position was
 * right to the zone 39% of the time when the model had to pick a zone name, and 83% when it pointed
 * at a spot and `zoneAtMinimapPct` did the geography. Naming a zone asks the model to hold a 13-way
 * taxonomy of a map it is looking at; pointing asks it to point. It is the app's own rule arriving
 * somewhere new: the model observes, the code decides what the observation means.
 *
 * **4. A bigger model localises better and counts no better.** The same 20 frames and the same
 * crop through `gemini-3.6-flash`, twice each: per icon the right zone 77% (up from 63%) and the
 * right half of the map 88% (up from 71%), his own zone 92% (n=12), median error 2%. But the enemy
 * COUNT went the other way — exactly right 33%, within one 83% — and self-agreement about the zones
 * only reached 70%. Whatever is failing is not the model's eyesight for a position; it is deciding
 * how many rings are on the map and which of them are red. It also took **12.3 seconds a read
 * against 1.1**, which is most of a twenty-second coaching turn for a pre-pass that is supposed to
 * run before the turn starts.
 *
 * ## The verdict, plainly: enemy positions are NOT SHIPPABLE
 *
 * On the best condition, an enemy sighting lands in the right zone 63% of the time (22 of 35 matched
 * icons), the count is exactly right 44% of the time, and two reads of the same picture agree about
 * the zones 48% of the time. "There is an enemy in your topside jungle" would therefore be wrong
 * about a third of the time it was said, and a wrong one is not a dull line — it sends him somewhere.
 * Nothing in this file turns a sighting into a spoken fact, and nothing should until those numbers
 * are much better.
 *
 * Two more results that close doors rather than open them:
 *
 * - **Champion identity is worse than it first looked, and the first look was a bug in the
 *   measurement.** See `championChoices`: with his own champion first in the enum the reader named it
 *   correctly on 56 of 60 reads, which would have been evidence it can identify a portrait. Sorted,
 *   the same question on the same frames gives 38 right, 10 refusals and 12 outright WRONG. A
 *   portrait is 12 pixels of JPEG; the author could not name one either. Enemy sightings therefore
 *   carry no name at all — which is also what makes them safe, since a sighting with no champion in
 *   it cannot fabricate one.
 * - **The crop cannot tell you what he is DOING, and neither can the frame reliably.** Every
 *   condition placed his icon on the map while the client said he was on the respawn screen, on all
 *   6 of the reads where that applied. The crop has no respawn timer in it to know better, and even
 *   the whole frame only called it 3 times in 6. `frameReadFaults` catches this one for free, which
 *   is the argument for the fence: the client already knows, so the read never has to be trusted
 *   about it.
 *
 * The identity result held on the bigger model, which is the strongest evidence that it is the
 * pixels rather than the reader: `gemini-3.6-flash` named his own champion right 21 times out of 40
 * and WRONG 17 times, slightly worse than the small model on the same frames.
 *
 * ## What IS defensible today
 *
 * One thing: **where HE is, coarsened to a half of the map** — 94% over 18 reads (17 of 18), and
 * 3% median error on the position it points at. And it should be used as a GATE rather than as a
 * claim. A wrong gate costs a line that would have been said; a wrong claim costs a decision, and
 * this app's whole design is the observation that those two are not close in price. "Do not offer
 * him the drake window while he is topside" is worth having and is not a sentence. "Ahri is topside"
 * is a sentence, and it is not earned yet.
 *
 * ## Why every answer is CLOSED
 *
 * A model choosing from an enumeration cannot invent a champion. Free prose about a screenshot is
 * how this app got *"clear faster, you need to use more abilities"* said to someone using abilities
 * on cooldown. So the reader is asked for a zone out of thirteen, a count, and one enum — never a
 * sentence — and `parseFrameRead` drops anything outside those sets rather than trusting the schema
 * to have held.
 *
 * Pure and browser-safe: the crop geometry is here because the browser does the cropping, and the
 * prompt is here because the probe and any caller must send byte-identical text.
 */

import { type } from "arktype"
import { TEAM_BLUE } from "../shared/constants.ts"
import { classifyZone, fromMinimapPct, zoneOf } from "../shared/map.ts"
import type { Pos, TeamId, Zone } from "../shared/map.ts"
import type { VisionState } from "../shared/live-state.ts"

/* ============================================================ the crop */

/**
 * Where the minimap sits in a frame, as fractions of the frame.
 *
 * MEASURED on the shipped grab size (1536x864, JPEG q0.72, the size `useScreenShare` produces): the
 * minimap's terrain square runs x 1250..1530 and y 578..858, i.e. 280px on a side. The rectangle
 * below is that with a 4px margin on every edge, because the minimap's own scale is a user setting
 * and a crop that clips the map is worse than one that carries a little furniture.
 *
 * The frame is 1,327,104 pixels and the minimap's square is 78,400 of them: **5.9% of the picture**,
 * and every champion icon on it is about 18 pixels across with a portrait of about 12 inside the
 * ring. That ratio is the reason cropping is worth measuring rather than assumed — see
 * `scripts/probe-minimap.ts`, which sends the same frame four ways and finds that it decides
 * everything.
 */
export const MINIMAP_REGION = {
	left: 1246 / 1536,
	top: 574 / 864,
	width: 288 / 1536,
	height: 288 / 864
} as const

/** The crop rectangle in pixels for a frame of this size. Rounded, never fractional. */
export const minimapRect = (
	frameW: number,
	frameH: number
): { x: number; y: number; w: number; h: number } => ({
	x: Math.round(MINIMAP_REGION.left * frameW),
	y: Math.round(MINIMAP_REGION.top * frameH),
	w: Math.round(MINIMAP_REGION.width * frameW),
	h: Math.round(MINIMAP_REGION.height * frameH)
})

/**
 * Where the map itself sits INSIDE that crop, and how the two were measured.
 *
 * The crop above carries a little of the minimap's frame so that a different minimap scale still
 * lands inside it. The playable square is the inner 280 pixels, offset 4 from the crop's own origin,
 * measured by drawing a percentage grid over `MINIMAP_REGION` and checking it against the map's
 * landmarks — blue's nexus in the bottom-left corner, red's in the top-right, baron's pit in the
 * top-left river and the dragon pit in the bottom-right.
 *
 * That calibration is what makes `zoneAtMinimapPct` possible, and `zoneAtMinimapPct` is what makes
 * the probe's hand labels reproducible: a label is a PIXEL somebody clicked, and the zone it means
 * is computed by `map.ts` rather than typed out by the person clicking.
 */
export const MINIMAP_TERRAIN = { offset: 4, size: 280 } as const

/**
 * A point on the minimap, as percentages across the playable square, to a zone.
 *
 * Blue-relative, always: `TEAM_BLUE` is passed so `OWN_*` means the blue half whoever is playing.
 * `forTeam` turns that into his own half when a sentence is built. Rounds through `fromMinimapPct`,
 * which is `map.ts`'s own inverse transform and the only place the y-flip is written.
 */
export const zoneAtMinimapPct = (leftPct: number, topPct: number): Zone =>
	classifyZone(fromMinimapPct(leftPct, topPct), TEAM_BLUE)

/* ============================================================ the zones */

/**
 * The thirteen zones, and the ONE place their names come from.
 *
 * Reused rather than reinvented: `shared/map.ts` already names these for the review pipeline, and a
 * second vocabulary would mean the live coach and the post-game review describing the same patch of
 * ground with different words. The labels below are not typed out — they are produced by calling
 * `zoneOf` on a point inside each zone, so a rename in `map.ts` renames these too and the test pins
 * that every canonical point really classifies as the zone it is filed under.
 */
export const READ_ZONES: readonly Zone[] = [
	"OWN_BASE",
	"ENEMY_BASE",
	"OWN_JUNGLE_TOP",
	"OWN_JUNGLE_BOT",
	"ENEMY_JUNGLE_TOP",
	"ENEMY_JUNGLE_BOT",
	"LANE_TOP",
	"LANE_MID",
	"LANE_BOT",
	"RIVER_TOP",
	"RIVER_BOT",
	"DRAGON_PIT",
	"BARON_PIT"
]

/**
 * A point inside each zone.
 *
 * Structures and pits are the game's own coordinates out of `map.ts`; the open-ground zones are
 * hand-picked and VERIFIED by the test, which is the only thing that makes them safe — a point that
 * drifted into a neighbouring zone would silently relabel a whole enum entry.
 *
 * `Zone` is a team-relative type, so these are filed under the BLUE team's names: `OWN_*` is the
 * blue half and `ENEMY_*` is the red half, always. Nothing here ever asks the model which half is
 * his, and `forTeam` below is where that becomes his again.
 */
const ANCHOR: Record<Zone, Pos> = {
	OWN_BASE: { x: 1962, y: 2038 },
	ENEMY_BASE: { x: 12843, y: 12836 },
	DRAGON_PIT: { x: 9973, y: 4578 },
	BARON_PIT: { x: 5012, y: 10470 },
	LANE_TOP: { x: 981, y: 10441 },
	LANE_MID: { x: 7420, y: 7420 },
	LANE_BOT: { x: 10504, y: 1029 },
	RIVER_TOP: { x: 3620, y: 11220 },
	RIVER_BOT: { x: 11220, y: 3620 },
	OWN_JUNGLE_TOP: { x: 3000, y: 8000 },
	OWN_JUNGLE_BOT: { x: 8000, y: 3000 },
	ENEMY_JUNGLE_TOP: { x: 6000, y: 11000 },
	ENEMY_JUNGLE_BOT: { x: 11000, y: 6000 }
}

/**
 * The prose name for a zone, ABSOLUTE — "blue-side jungle (top)", never "your jungle".
 *
 * This is `zoneOf` called without a team, which `map.ts` already supports and documents, and using
 * it here is a deliberate narrowing of what the model is asked to know.
 *
 * The reason is that the minimap DOES NOT ROTATE. Blue's base is in the bottom-left corner and
 * red's in the top-right in every frame opened while building this — about twenty-five of them,
 * spanning five different games across two recorded sessions, with him on the blue side in some and
 * the red side in others — and only the icon colours tell you which base is his. So an absolute answer is something the picture can
 * settle on its own, while "your jungle" would require the reader to first work out his side from
 * the ring colours and then mirror the whole map. That is an extra inference with no ground truth
 * attached, and getting it wrong would flip every jungle answer into its opposite while still
 * looking like a confident read.
 *
 * (League has a "rotate minimap" setting. If he ever turns it on, every zone answer inverts. That is
 * a real failure mode with no cheap detector, and it is written here rather than discovered later.)
 */
export const zoneLabel = (zone: Zone): string => zoneOf(ANCHOR[zone])

/**
 * The same zone, labelled for the side he is ACTUALLY ON. This is what a sentence uses.
 *
 * `zoneLabel` is absolute and must stay that way — the reader answers about a picture and the
 * minimap does not rotate, so "blue-side jungle (top)" is something the pixels can settle and
 * "your jungle" is not. But absolute is not what a coaching line means. On a red-side game
 * `- You: blue-side jungle (top)` is a man standing in the ENEMY jungle, and nothing in the live
 * payload resolves it: the delta carries no team side at all and the full brief says only
 * `side ORDER` / `side CHAOS` with no ORDER-is-blue mapping anywhere. So the one distinction a
 * jungler's whole death-location coaching turns on was left to the model to guess, and half the
 * time the guess inverts.
 *
 * `forTeam` documents this flip as happening "exactly once, here, where his team id is known from
 * the client" — and it never happened at all: `forTeam`'s only callers were its own tests. This is
 * that flip, done where the team id is known, and it goes through `zoneOf` rather than `forTeam` so
 * the ownership word and the side word come from one call and cannot disagree.
 *
 *   zoneLabelForTeam("ENEMY_JUNGLE_TOP", TEAM_BLUE) -> "enemy red-side jungle (top)"
 *   zoneLabelForTeam("ENEMY_JUNGLE_TOP", TEAM_RED)  -> "own red-side jungle (top)"
 *
 * The absolute half is KEPT in the string. It is the part the picture verified, and dropping it
 * would leave a label nothing can be checked against later.
 */
export const zoneLabelForTeam = (zone: Zone, teamId: TeamId): string => zoneOf(ANCHOR[zone], teamId)

/** Every zone label, in enum order — the exact answer set handed to the model. */
export const zoneLabels = (): string[] => READ_ZONES.map(zoneLabel)

/** The label back to the zone. Unknown text is not coerced — it is refused. */
export const zoneFromLabel = (label: string): Zone | null =>
	READ_ZONES.find(z => zoneLabel(z) === label) ?? null

/**
 * The blue-relative zone the reader answered, expressed for the side he is actually on.
 *
 * The read is absolute; a coaching sentence is not. "You are in the enemy jungle with no vision" is
 * the line a jungler needs and it means opposite halves of the map depending on his side, so the
 * flip happens exactly once, here, where his team id is known from the client rather than guessed
 * from the picture. Lanes, river and both pits are shared ground and never flip.
 */
export const forTeam = (zone: Zone, teamId: TeamId): Zone => {
	if (teamId === TEAM_BLUE) return zone
	const flipped: Partial<Record<Zone, Zone>> = {
		OWN_BASE: "ENEMY_BASE",
		ENEMY_BASE: "OWN_BASE",
		OWN_JUNGLE_TOP: "ENEMY_JUNGLE_TOP",
		OWN_JUNGLE_BOT: "ENEMY_JUNGLE_BOT",
		ENEMY_JUNGLE_TOP: "OWN_JUNGLE_TOP",
		ENEMY_JUNGLE_BOT: "OWN_JUNGLE_BOT"
	}
	return flipped[zone] ?? zone
}

/** Exposed for the test, which asserts every anchor really lands in the zone it is filed under. */
export const anchorZone = (zone: Zone): Zone => classifyZone(ANCHOR[zone], TEAM_BLUE)

/* ============================================================ the answers */

/**
 * What he is doing, from the main viewport rather than the minimap.
 *
 * Deliberately seven words and no free text. `dead` and `shopping` are the two the block is
 * structurally blind to in opposite directions — it knows he is dead and does not know the shop is
 * open over the game — and both change whether a sentence should be said at all.
 */
export const ACTIVITIES = [
	"fighting",
	"clearing",
	"recalling",
	"shopping",
	"dead",
	"moving",
	"unclear"
] as const

export type Activity = (typeof ACTIVITIES)[number]

/**
 * One read of one frame. Everything is an enum, a count or null.
 *
 * `enemiesOnMinimap` is one entry per red-ringed icon, so its length is the count and there is no
 * separate number to disagree with itself.
 */
export interface FrameRead {
	enemiesOnMinimap: Zone[]
	alliesOnMinimap: number
	/** Where his own (white-ringed) icon is, or null when he could not find it. */
	you: Zone | null
	activity: Activity
	/**
	 * Which champion the reader thinks the white-ringed icon is.
	 *
	 * NOT a fact anybody needs — the client says what he is playing. It is a CANARY, and it is the
	 * reason a champion enum appears in this file at all. His own icon is the easiest identification
	 * on the map: it is the one the camera box is centred on and the one whose portrait he has seen
	 * ten thousand times. A reader that gets it wrong has not identified anybody, and
	 * `frameReadFaults` throws the whole read away rather than trusting the zones that came with it.
	 */
	youChampion: string | null
}

/**
 * The wire shape, checked before anything semantic.
 *
 * ArkType at the boundary, the same as every other place a model's output enters this app. The
 * schema below is deliberately loose about VALUES — any string passes here — because a constrained
 * decode can still hand back a zone label from a different game's team colours, and refusing that
 * belongs with the roster, in `parseFrameRead`.
 */
export const RawFrameRead = type({
	enemiesOnMinimap: "string[]",
	alliesOnMinimap: "number",
	"you?": "string | null",
	activity: "string",
	"youChampion?": "string | null"
})

/** The answer for "I could not find it". A word, not an empty string, so a refusal is legible. */
export const NOT_VISIBLE = "not visible"
/** The answer for "I cannot tell which champion that is". Offered so guessing is never the only move. */
export const UNSURE = "unsure"

/**
 * The champions the reader may answer with, in an order that carries no hint.
 *
 * MEASURED, and it nearly produced a false finding. The canary was first written with his own
 * champion FIRST in the enum, and it came back right on 56 of 60 reads from a crop containing no HUD
 * at all — which would have said the model identifies minimap portraits. It says nothing of the
 * kind: the first value of an enum is where a model that does not know goes. Sorted, the answer
 * carries no positional prior and `unsure` sits with the rest, so a correct answer has to have come
 * from the picture.
 */
const championChoices = (opts: { myChampion: string; enemyChampions: readonly string[] }): string[] =>
	[opts.myChampion, ...opts.enemyChampions, UNSURE].sort()

/**
 * The JSON schema handed to the model, built from the same enums the parser checks against.
 *
 * One source, on purpose. A schema typed out beside an enum is a schema that drifts from it, and
 * the drift shows up as the model answering correctly and the parser dropping it.
 */
export const frameReadSchema = (opts: {
	enemyChampions: readonly string[]
	myChampion: string
}): Record<string, unknown> => ({
	type: "object",
	properties: {
		enemiesOnMinimap: {
			type: "array",
			description:
				"One entry for each RED-ringed champion icon you can see on the minimap right now. Empty if none.",
			items: { type: "string", enum: zoneLabels() }
		},
		alliesOnMinimap: {
			type: "integer",
			description: "How many BLUE-ringed champion icons are on the minimap, not counting yourself."
		},
		you: {
			type: "string",
			description: "Where the WHITE-ringed icon is. Use 'not visible' if you cannot find one.",
			enum: [...zoneLabels(), NOT_VISIBLE]
		},
		activity: { type: "string", enum: [...ACTIVITIES] },
		youChampion: {
			type: "string",
			description: "Which champion the WHITE-ringed minimap icon is.",
			enum: championChoices(opts)
		}
	},
	required: ["enemiesOnMinimap", "alliesOnMinimap", "you", "activity", "youChampion"]
})

/* ============================================================ the prompt */

/**
 * The reader's instructions.
 *
 * Short, and every sentence in it is a fence rather than a style note. It says what the ring colours
 * mean because that is the only thing separating an ally from an enemy at this size; it says to
 * answer `not visible` and `unsure` because a model with no refusal available will guess; and it
 * says nothing at all about coaching, because this call produces facts and not sentences.
 *
 * Two notes for whoever edits it next. The numbers in the header were measured against THIS text, so
 * changing a word invalidates the table and the probe has to be re-run — that is the deal everywhere
 * else in this repo and it applies here. And the white-ring sentence is the shakiest claim in it: an
 * ally's ring and his own are both pale at 18 pixels, and the reason "where is he" is the most
 * accurate answer in the whole read is far more likely to be the white camera RECTANGLE, which is
 * large, than the ring, which is not.
 */
export const FRAME_READ_SYSTEM = `You are reading the MINIMAP of a League of Legends game from a screenshot.

On this minimap:
- YOUR team's champion icons have BLUE rings.
- The ENEMY team's champion icons have RED rings.
- The player's own champion has a WHITE ring and the white camera rectangle is usually around it.
- Only champions your team can currently SEE are drawn. Anyone not visible is simply absent.

Report only what you can actually see. If you cannot find an icon, say "${NOT_VISIBLE}". If you
cannot tell which champion a portrait is, say "${UNSURE}". Guessing is worse than saying you do not
know: a wrong position is acted on, and a refusal is not.

Answer with JSON only.`

/**
 * The question, with the map's orientation stated rather than asked.
 *
 * Blue's base is bottom-left and red's is top-right in every frame, because the minimap does not
 * rotate — see `zoneLabel`. Stating it costs nine words and removes the one inference in this whole
 * read that has no ground truth attached.
 */
export const frameReadQuestion = (): string =>
	`The blue side's base is in the BOTTOM-LEFT corner of the minimap and the red side's base is in the TOP-RIGHT corner. Baron's pit is in the top-left river, the dragon pit is in the bottom-right river.

Which zone is each icon in? Choose from exactly these names:
${zoneLabels().map(l => `- ${l}`).join("\n")}`

/* ============================================================ the same read, as coordinates */

/**
 * The other way to ask, and the reason there are two.
 *
 * MEASURED, and it is the finding this file exists to record. Asked for a zone NAME out of the
 * thirteen above, the reader gets the count right and the place wrong: over the hand-labelled
 * frames, 0 of 12 reads placed every enemy in the right zone, and the errors were not random — they
 * piled into `top lane`, `mid lane`, `bot lane`, which is what a League game looks like when you
 * are guessing rather than looking.
 *
 * So this variant asks for something a vision model is actually good at — WHERE on the square, in
 * percentages — and lets `zoneAtMinimapPct` do the geography in TypeScript. It is the same split
 * this whole app is built on: the model observes, the code decides what the observation means. A
 * percentage is also scorable as a distance, so the error has a size rather than only a right or
 * wrong, and a coarse answer ("topside") can be taken from a position that was never accurate
 * enough to name a camp.
 */
/**
 * One icon's position, in Gemini's OWN pointing units: 0-1000 down and across the image.
 *
 * MEASURED, and it cost a run to find out. Asked for "percentages", the model answered in PIXELS of
 * the image it had been sent — `427,574` for a 1152px crop — on 21 of 24 sightings, and every one of
 * them was refused by the parser as out of range. Reported as a score that looked like blindness:
 * enemy count exact fell to 4/12 while the eight readings that did arrive in the right units were
 * within 2% of the map. The model was seeing perfectly and answering in a unit nobody had agreed on.
 *
 * 0-1000 is the convention Google documents for pointing and the one this model is trained to emit,
 * so it is the one asked for. `pctOf` converts once, here, and nothing downstream sees a thousandth.
 *
 * One approximation is left in deliberately. The model points at the CROP, which carries a 4px
 * margin on each side, while `zoneAtMinimapPct` and the probe's hand clicks are percentages of the
 * 280px playable SQUARE inside it — so a reading is shifted by up to 1.4% of the map and scaled by
 * 2.9%. Both are well inside the 3% median error measured against hand labels, and correcting them
 * after the fact would change every number in the header without any of them having been re-run.
 * Correct it and re-run the probe together, or not at all.
 */
export interface Sighting {
	/** 0 = left edge of the image, 1000 = right edge. */
	x: number
	/** 0 = top edge, 1000 = bottom edge. */
	y: number
}

/** A sighting as percentages of the minimap square, which is what `zoneAtMinimapPct` wants. */
export const pctOf = (p: Sighting): { left: number; top: number } => ({
	left: p.x / 10,
	top: p.y / 10
})

export const RawFrameReadXY = type({
	enemiesOnMinimap: type({ x: "number", y: "number" }).array(),
	alliesOnMinimap: "number",
	"you?": type({ x: "number", y: "number" }).or("null"),
	activity: "string",
	"youChampion?": "string | null"
})

export const frameReadSchemaXY = (opts: {
	enemyChampions: readonly string[]
	myChampion: string
}): Record<string, unknown> => ({
	type: "object",
	properties: {
		enemiesOnMinimap: {
			type: "array",
			description:
				"One entry for each RED-ringed champion icon on the minimap. Give its position as y and x normalised to 0-1000 over the image, the same way you would point at something. Empty if none.",
			items: {
				type: "object",
				properties: { x: { type: "number" }, y: { type: "number" } },
				required: ["x", "y"]
			}
		},
		alliesOnMinimap: {
			type: "integer",
			description: "How many BLUE-ringed champion icons are on the minimap, not counting yourself."
		},
		you: {
			type: "object",
			description: "Where the WHITE-ringed icon is, as y and x normalised to 0-1000. Null if you cannot find one.",
			nullable: true,
			properties: { x: { type: "number" }, y: { type: "number" } },
			required: ["x", "y"]
		},
		activity: { type: "string", enum: [...ACTIVITIES] },
		youChampion: {
			type: "string",
			description: "Which champion the WHITE-ringed minimap icon is.",
			enum: championChoices(opts)
		}
	},
	required: ["enemiesOnMinimap", "alliesOnMinimap", "you", "activity", "youChampion"]
})

/** The coordinate question. No zone list at all — the geography is not the model's job here. */
export const FRAME_READ_QUESTION_XY = `The blue side's base is in the BOTTOM-LEFT corner of the minimap and the red side's base is in the TOP-RIGHT corner.

Point at each champion icon: give y and x normalised to 0-1000 over the image, where y=0 is the top edge and x=0 is the left edge.`

/** A read in coordinates, plus the zones the code derived from them. */
export interface FrameReadXY {
	enemies: Sighting[]
	enemyZones: Zone[]
	alliesOnMinimap: number
	you: Sighting | null
	youZone: Zone | null
	activity: Activity
	youChampion: string | null
}

export const parseFrameReadXY = (
	raw: unknown,
	ctx: { myChampion: string; enemyChampions: readonly string[] }
): { read: FrameReadXY | null; rejected: FrameReadRejection | null; dropped: string[] } => {
	const dropped: string[] = []
	if (raw === null || raw === undefined) return { read: null, rejected: "empty", dropped }
	const checked = RawFrameReadXY(raw)
	if (checked instanceof type.errors) return { read: null, rejected: "schema", dropped }
	/*
	 * A percentage outside the square is dropped rather than clamped. Clamping would turn "I put an
	 * icon at 140%" into a confident sighting on the right-hand edge of the map, which is a
	 * fabricated position produced by the parser rather than by the model.
	 */
	const inside = (p: Sighting) => p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000
	const enemies: Sighting[] = []
	for (const p of checked.enemiesOnMinimap) {
		if (inside(p)) enemies.push(p)
		else dropped.push(`xy:${Math.round(p.x)},${Math.round(p.y)}`)
	}
	const you = checked.you !== null && checked.you !== undefined && inside(checked.you) ? checked.you : null
	const activity: Activity =
		(ACTIVITIES as readonly string[]).includes(checked.activity) ? (checked.activity as Activity) : "unclear"
	const named = checked.youChampion ?? UNSURE
	const known = named === ctx.myChampion || ctx.enemyChampions.includes(named)
	if (!known && named !== UNSURE) dropped.push(`champion:${named}`)
	return {
		read: {
			enemies,
			enemyZones: enemies.map(p => zoneAtMinimapPct(pctOf(p).left, pctOf(p).top)),
			alliesOnMinimap: Math.max(0, Math.min(4, Math.round(checked.alliesOnMinimap))),
			you,
			youZone: you === null ? null : zoneAtMinimapPct(pctOf(you).left, pctOf(you).top),
			activity,
			youChampion: known ? named : null
		},
		rejected: null,
		dropped
	}
}

/** The coordinate read in the shape the fence and the agreement checks already understand. */
export const asFrameRead = (r: FrameReadXY): FrameRead => ({
	enemiesOnMinimap: r.enemyZones,
	alliesOnMinimap: r.alliesOnMinimap,
	you: r.youZone,
	activity: r.activity,
	youChampion: r.youChampion
})

/* ============================================================ coarse ground */

/**
 * The granularity a jungler's decision actually turns on.
 *
 * "He is topside" changes whether to take drake; "he is in the raptor camp rather than the wolf
 * camp" does not, and asking for that precision is how a read that was directionally right gets
 * scored as wrong — and, far worse, how a read that is directionally WRONG gets spoken as though it
 * named a camp. Zones are kept because the review pipeline already speaks them; this is what a live
 * sentence should be built from until the fine-grained accuracy is there.
 */
export type Coarse = "topside" | "botside" | "mid" | "base"

export const coarseOf = (zone: Zone): Coarse => {
	if (zone === "OWN_BASE" || zone === "ENEMY_BASE") return "base"
	if (zone === "LANE_MID") return "mid"
	return zone.endsWith("_TOP") || zone === "BARON_PIT" ? "topside" : "botside"
}

/* ============================================================ parsing */

export type FrameReadRejection =
	/** Nothing came back, or it was not JSON. */
	| "empty"
	/** JSON, but not the shape. */
	| "schema"

export interface ParsedFrameRead {
	read: FrameRead | null
	rejected: FrameReadRejection | null
	/** Values that were thrown away rather than coerced. Counted by the probe. */
	dropped: string[]
}

/**
 * Model output to a `FrameRead`, dropping anything outside the enumerations.
 *
 * Nothing here coerces. A zone label that is not one of the thirteen is not fuzzy-matched to the
 * nearest one — it is dropped and counted, because the whole claim of a closed question is that an
 * answer outside the set never reaches a sentence, and a near-miss repaired quietly is exactly how
 * that claim stops being true.
 */
export const parseFrameRead = (
	raw: unknown,
	ctx: { myChampion: string; enemyChampions: readonly string[] }
): ParsedFrameRead => {
	const dropped: string[] = []
	if (raw === null || raw === undefined) return { read: null, rejected: "empty", dropped }
	const checked = RawFrameRead(raw)
	if (checked instanceof type.errors) return { read: null, rejected: "schema", dropped }

	const enemiesOnMinimap: Zone[] = []
	for (const label of checked.enemiesOnMinimap) {
		const zone = zoneFromLabel(label)
		if (zone === null) dropped.push(`zone:${label}`)
		else enemiesOnMinimap.push(zone)
	}

	const youLabel = checked.you ?? NOT_VISIBLE
	const you = youLabel === NOT_VISIBLE ? null : zoneFromLabel(youLabel)
	if (you === null && youLabel !== NOT_VISIBLE) dropped.push(`zone:${youLabel}`)

	const activity: Activity =
		(ACTIVITIES as readonly string[]).includes(checked.activity) ?
			(checked.activity as Activity)
		:	"unclear"
	if (activity === "unclear" && checked.activity !== "unclear") dropped.push(`activity:${checked.activity}`)

	const named = checked.youChampion ?? UNSURE
	const known = named === ctx.myChampion || ctx.enemyChampions.includes(named)
	if (!known && named !== UNSURE) dropped.push(`champion:${named}`)
	const youChampion = known ? named : null

	return {
		read: {
			enemiesOnMinimap,
			alliesOnMinimap: Math.max(0, Math.min(4, Math.round(checked.alliesOnMinimap))),
			you,
			activity,
			youChampion
		},
		rejected: null,
		dropped
	}
}

/* ============================================================ the fence */

/**
 * The part of the truth this fence needs, and nothing else.
 *
 * Deliberately smaller than `VisionState`. The probe scores stored blocks that were written weeks
 * before this file existed and has only the rendered text; the daemon has the whole state. Both can
 * produce these five fields, so both run the same checks — and a fence that only one caller can
 * build is a fence that only one caller uses.
 */
export interface FrameTruth {
	myChampion: string
	meDead: boolean
	/** Enemies alive right now. An icon per living enemy is the ceiling on what can be seen. */
	enemiesAlive: number
	/** Allies alive right now, NOT counting him. */
	alliesAlive: number
	enemyChampions: readonly string[]
}

/** The daemon's path: the live state it already holds, narrowed to what the fence checks. */
export const truthFromState = (s: VisionState): FrameTruth => ({
	myChampion: s.me.champion,
	meDead: s.me.dead === true,
	enemiesAlive: s.enemies.filter(p => !p.dead).length,
	alliesAlive: s.allies.filter(p => !p.dead).length,
	enemyChampions: s.enemies.map(p => p.champion)
})

export type FrameReadFaultCode =
	/** More red rings reported than there are living enemies. At least one is invented. */
	| "more-enemies-than-alive"
	/** More blue rings than living allies. */
	| "more-allies-than-alive"
	/** His icon placed on the map while the client says he is on the respawn screen. */
	| "you-visible-while-dead"
	/** Read his own champion as somebody else — the canary. */
	| "wrong-self-champion"

export interface FrameReadFault {
	code: FrameReadFaultCode
	detail: string
}

/**
 * Every check the CLIENT can settle, run against the read before any of it becomes a sentence.
 *
 * This is the half of the measurement that does not depend on anybody's eyesight. Nothing here
 * needs a human to have looked at the frame: how many enemies are alive, whether he is dead, and
 * what he is playing are all in the ground-truth block, computed on the other side of the process
 * from the picture. A read that contradicts them is not a hard read, it is a wrong one.
 *
 * `wrong-self-champion` is the strictest and the cheapest. It is the only identification in the
 * whole read whose answer is known for free, so it is the one that gets to speak for all of them.
 */
export const frameReadFaults = (read: FrameRead, truth: FrameTruth): FrameReadFault[] => {
	const faults: FrameReadFault[] = []
	if (read.enemiesOnMinimap.length > truth.enemiesAlive)
		faults.push({
			code: "more-enemies-than-alive",
			detail: `${read.enemiesOnMinimap.length} seen, ${truth.enemiesAlive} alive`
		})
	if (read.alliesOnMinimap > truth.alliesAlive)
		faults.push({
			code: "more-allies-than-alive",
			detail: `${read.alliesOnMinimap} seen, ${truth.alliesAlive} alive`
		})
	if (truth.meDead && read.you !== null)
		faults.push({ code: "you-visible-while-dead", detail: `placed in ${read.you}` })
	if (read.youChampion !== null && read.youChampion !== truth.myChampion)
		faults.push({
			code: "wrong-self-champion",
			detail: `${read.youChampion} for ${truth.myChampion}`
		})
	return faults
}

/** A read the client has not contradicted. Anything else is thrown away whole, never repaired. */
export const isTrustworthy = (read: FrameRead, truth: FrameTruth): boolean =>
	frameReadFaults(read, truth).length === 0

/* ============================================================ agreement */

/**
 * How much two reads of the SAME frame agree.
 *
 * The headline number of `scripts/probe-minimap.ts`, and the one that needs no ground truth at all.
 * A reader that cannot reproduce its own answer on an identical image has no accuracy worth
 * measuring — the disagreement is a floor on the error rate, whatever the truth turns out to be.
 * Reported per question because the questions fail differently and averaging them hides that.
 */
export interface ReadAgreement {
	enemyCount: boolean
	enemyZones: boolean
	you: boolean
	activity: boolean
	youChampion: boolean
}

export const agreementOf = (a: FrameRead, b: FrameRead): ReadAgreement => {
	const sorted = (z: Zone[]) => [...z].sort().join(",")
	return {
		enemyCount: a.enemiesOnMinimap.length === b.enemiesOnMinimap.length,
		enemyZones: sorted(a.enemiesOnMinimap) === sorted(b.enemiesOnMinimap),
		you: a.you === b.you,
		activity: a.activity === b.activity,
		youChampion: a.youChampion === b.youChampion
	}
}
