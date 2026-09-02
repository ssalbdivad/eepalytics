/**
 * Summoner's Rift geometry, established empirically in `.research/analytics.md` §1.
 * Pure functions only — imported by the daemon, the analysis layer and the browser.
 *
 * ## Axes, and the one thing everybody gets wrong
 *
 * The game's origin `(0,0)` is the BLUE (team 100) fountain in the south-west corner.
 * `+x` runs east toward the red base, `+y` runs NORTH — i.e. UP the minimap.
 * Screen/SVG coordinates run the other way: `top` grows DOWNWARD. So every world->screen
 * conversion must FLIP y:
 *
 *     top% = 100 * (1 - (y - minY) / (maxY - minY))
 *
 * `toMinimapPct` below is the only place that flip should ever be written. If a heatmap
 * looks mirrored, it is because something else re-implemented this and forgot.
 */

import { MAP, TEAM_BLUE, TEAM_RED } from "./constants.ts"

export interface Pos {
	x: number
	y: number
}

export interface UV {
	/** Progression along the blue->red diagonal. Blue nexus ~2000, river ~7420, red nexus ~12840. */
	u: number
	/** Lane offset perpendicular to that. v > 0 = TOP side, v < 0 = BOT side, v ~ 0 = MID. */
	v: number
}

export type TeamId = 100 | 200

export type Lane = "TOP" | "MID" | "BOT"

export type Zone =
	| "OWN_BASE"
	| "ENEMY_BASE"
	| "DRAGON_PIT"
	| "BARON_PIT"
	| "LANE_TOP"
	| "LANE_MID"
	| "LANE_BOT"
	| "RIVER_TOP"
	| "RIVER_BOT"
	| "OWN_JUNGLE_TOP"
	| "OWN_JUNGLE_BOT"
	| "ENEMY_JUNGLE_TOP"
	| "ENEMY_JUNGLE_BOT"

export type Half = "own" | "enemy" | "neutral"

/* ------------------------------------------------------------------ anchors */

/**
 * Structure coordinates read straight out of `BUILDING_KILL.position`. The spread across
 * 22 games is EXACTLY ZERO for every turret except nexus turrets (there are two per base),
 * so these are the game's own constants, not estimates.
 */
export const TURRETS = {
	BLUE_NEXUS: { x: 1962, y: 2038 },
	BLUE_MID_BASE: { x: 3651, y: 3696 },
	BLUE_MID_INNER: { x: 5048, y: 4812 },
	BLUE_MID_OUTER: { x: 5846, y: 6396 },
	BLUE_MID_INHIB: { x: 3210, y: 3217 },
	BLUE_TOP_BASE: { x: 1169, y: 4287 },
	BLUE_TOP_INNER: { x: 1512, y: 6699 },
	BLUE_TOP_OUTER: { x: 981, y: 10441 },
	BLUE_TOP_INHIB: { x: 1172, y: 3583 },
	BLUE_BOT_BASE: { x: 4281, y: 1253 },
	BLUE_BOT_INNER: { x: 6919, y: 1483 },
	BLUE_BOT_OUTER: { x: 10504, y: 1029 },
	BLUE_BOT_INHIB: { x: 3468, y: 1230 },
	RED_NEXUS: { x: 12843, y: 12836 },
	RED_MID_BASE: { x: 11134, y: 11207 },
	RED_MID_INNER: { x: 9767, y: 10113 },
	RED_MID_OUTER: { x: 8955, y: 8510 },
	RED_MID_INHIB: { x: 11593, y: 11669 },
	RED_TOP_BASE: { x: 10481, y: 13650 },
	RED_TOP_INNER: { x: 7943, y: 13411 },
	RED_TOP_OUTER: { x: 4318, y: 13875 },
	RED_TOP_INHIB: { x: 11275, y: 13657 },
	RED_BOT_BASE: { x: 13624, y: 10572 },
	RED_BOT_INNER: { x: 13327, y: 8226 },
	RED_BOT_OUTER: { x: 13866, y: 4505 },
	RED_BOT_INHIB: { x: 13599, y: 11319 }
} as const satisfies Record<string, Pos>

/**
 * Mean of `ELITE_MONSTER_KILL.position` (the kill lands near, not exactly on, the pit).
 * Baron / Rift Herald / voidgrubs all share the NORTH-WEST (top) river pit;
 * dragon is the SOUTH-EAST (bot) river pit.
 */
export const PITS = {
	BARON: { x: 5012, y: 10470 },
	HERALD: { x: 4806, y: 10111 },
	GRUBS: { x: 4835, y: 10233 },
	DRAGON: { x: 9973, y: 4578 }
} as const satisfies Record<string, Pos>

export const NEXUS = {
	100: TURRETS.BLUE_NEXUS,
	200: TURRETS.RED_NEXUS
} as const satisfies Record<TeamId, Pos>

/**
 * Side lanes are L-shaped, so `v` alone cannot identify them — measure distance to a polyline.
 * Every vertex except the four corner/base interpolations is an exact structure coordinate.
 */
export const LANE_POLYLINES: Record<Lane, ReadonlyArray<readonly [number, number]>> = {
	TOP: [
		[1500, 1800],
		[1169, 4287],
		[1512, 6699],
		[981, 10441],
		[1600, 12900],
		[4318, 13875],
		[7943, 13411],
		[10481, 13650],
		[12800, 12900]
	],
	MID: [
		[1962, 2038],
		[3651, 3696],
		[5048, 4812],
		[5846, 6396],
		[8955, 8510],
		[9767, 10113],
		[11134, 11207],
		[12843, 12836]
	],
	BOT: [
		[1800, 1500],
		[4281, 1253],
		[6919, 1483],
		[10504, 1029],
		[12900, 1600],
		[13866, 4505],
		[13327, 8226],
		[13624, 10572],
		[12900, 12800]
	]
}

export const LANES: readonly Lane[] = ["TOP", "MID", "BOT"]

/* ------------------------------------------------------------- basic vector */

export const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y)

export const dist2 = (a: Pos, b: Pos): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** Shortest distance from `p` to the segment `a`-`b`. */
export const distToSegment = (p: Pos, a: Pos, b: Pos): number => {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const len2 = dx * dx + dy * dy
	if (len2 === 0) return dist(p, a)
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
	t = t < 0 ? 0 : t > 1 ? 1 : t
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Shortest distance from `p` to a lane's polyline, in game units. */
export const distToLane = (p: Pos, lane: Lane): number => {
	const pts = LANE_POLYLINES[lane]
	let best = Infinity
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]!
		const b = pts[i + 1]!
		const d = distToSegment(p, { x: a[0], y: a[1] }, { x: b[0], y: b[1] })
		if (d < best) best = d
	}
	return best
}

/** The closest lane and how far away it is. */
export const nearestLane = (p: Pos): { lane: Lane; distance: number } => {
	let lane: Lane = "MID"
	let distance = Infinity
	for (const l of LANES) {
		const d = distToLane(p, l)
		if (d < distance) {
			distance = d
			lane = l
		}
	}
	return { lane, distance }
}

/* ------------------------------------------------------------ rotated basis */

/**
 * The single most useful derivation in the research: a 45-degree rotation that turns
 * "how far along the map" and "which lane" into two independent scalars.
 *
 * Because the basis is rotated AND scaled by sqrt(2), a real perpendicular distance `D`
 * from the river centreline is `du = D / Math.SQRT2` in `u` — remember the sqrt(2) whenever
 * you convert a band width in `u` back into game units.
 */
export const toUV = (p: Pos): UV => ({ u: (p.x + p.y) / 2, v: (p.y - p.x) / 2 })

export const fromUV = (uv: UV): Pos => ({ x: uv.u - uv.v, y: uv.u + uv.v })

/** Game units per unit of `u` or `v`. Multiply a `u`-band by this to get real distance. */
export const UV_SCALE = Math.SQRT2

/**
 * Which team's territory a point sits in, relative to `teamId`.
 *
 * Both objective pits sit essentially ON the river (u = 7276 and 7741 vs a centre of 7420),
 * so a naive binary split misclassifies every river fight. Points within `MAP.neutralU`
 * of the centreline are reported as `"neutral"` — with the default band the user's 112 deaths
 * split NEUTRAL 54 / OWN 38 / ENEMY 20. Always report which band you used.
 */
export const half = (
	p: Pos,
	teamId: TeamId,
	neutralU: number = MAP.neutralU
): Half => {
	const { u } = toUV(p)
	const d = u - MAP.centerU
	if (Math.abs(d) < neutralU) return "neutral"
	const inBlueHalf = d < 0
	const isBlue = teamId === TEAM_BLUE
	return inBlueHalf === isBlue ? "own" : "enemy"
}

/** Which team's HALF of the map a point is in, ignoring the observer. */
export const sideOf = (p: Pos): "blue" | "red" =>
	toUV(p).u < MAP.centerU ? "blue" : "red"

/** Top half or bottom half of the map, by lane offset. */
export const quadrantOf = (p: Pos): "top" | "bot" => (toUV(p).v >= 0 ? "top" : "bot")

/* ------------------------------------------------------------------- zoning */

/**
 * Classify a position into a team-relative zone. Precedence matters: a point standing in
 * mid lane at the river must classify as `LANE_MID`, not river.
 *
 *   1. within `baseRadius` of a nexus       -> OWN_BASE / ENEMY_BASE
 *   2. within `pitRadius` of the dragon pit -> DRAGON_PIT
 *   3. within `pitRadius` of the baron pit  -> BARON_PIT   (herald + grubs share it)
 *   4. within `laneHalfWidth` of a lane     -> LANE_*
 *   5. |u - centerU| < riverHalfU, |v| < 4200 -> RIVER_TOP / RIVER_BOT
 *   6. otherwise                            -> {OWN,ENEMY}_JUNGLE_{TOP,BOT}
 *
 * All five tuning constants live in `MAP` and are calibrated, not physical.
 */
export const classifyZone = (
	p: Pos,
	teamId: TeamId,
	tuning: {
		baseRadius?: number
		pitRadius?: number
		laneHalfWidth?: number
		riverHalfU?: number
	} = {}
): Zone => {
	const baseRadius = tuning.baseRadius ?? MAP.baseRadius
	const pitRadius = tuning.pitRadius ?? MAP.pitRadius
	const laneHalfWidth = tuning.laneHalfWidth ?? MAP.laneHalfWidth
	const riverHalfU = tuning.riverHalfU ?? MAP.riverHalfU

	const own = teamId === TEAM_BLUE ? NEXUS[100] : NEXUS[200]
	const enemy = teamId === TEAM_BLUE ? NEXUS[200] : NEXUS[100]
	if (dist(p, own) < baseRadius) return "OWN_BASE"
	if (dist(p, enemy) < baseRadius) return "ENEMY_BASE"

	if (dist(p, PITS.DRAGON) < pitRadius) return "DRAGON_PIT"
	if (dist(p, PITS.BARON) < pitRadius) return "BARON_PIT"

	const near = nearestLane(p)
	if (near.distance < laneHalfWidth) return `LANE_${near.lane}` as Zone

	const { u, v } = toUV(p)
	if (Math.abs(u - MAP.centerU) < riverHalfU && Math.abs(v) < 4200)
		return v >= 0 ? "RIVER_TOP" : "RIVER_BOT"

	const inBlueHalf = u < MAP.centerU
	const isOwn = inBlueHalf === (teamId === TEAM_BLUE)
	const quad = v >= 0 ? "TOP" : "BOT"
	return `${isOwn ? "OWN" : "ENEMY"}_JUNGLE_${quad}` as Zone
}

/**
 * A prose zone name, the thing that ends up in a coaching sentence and in Claude's prompt.
 * `teamId` is optional: without it, jungle quadrants are named by map side
 * (`"blue-side jungle (top)"`) instead of ownership (`"enemy blue-side jungle (top)"`).
 *
 *   zoneOf({x:9973,y:4578})            -> "dragon pit"
 *   zoneOf({x:7420,y:7420})            -> "mid lane"
 *   zoneOf({x:11000,y:9000}, 100)      -> "enemy red-side jungle (top)"
 *   zoneOf({x:5500,y:9000})            -> "river (top)"
 */
export const zoneOf = (p: Pos, teamId?: TeamId): string => {
	const team: TeamId = teamId ?? TEAM_BLUE
	const zone = classifyZone(p, team)
	switch (zone) {
		case "OWN_BASE":
			return teamId === undefined ? `${sideOf(p)}-side base` : "own base"
		case "ENEMY_BASE":
			return teamId === undefined ? `${sideOf(p)}-side base` : "enemy base"
		case "DRAGON_PIT":
			return "dragon pit"
		case "BARON_PIT":
			return "baron pit"
		case "LANE_TOP":
			return "top lane"
		case "LANE_MID":
			return "mid lane"
		case "LANE_BOT":
			return "bot lane"
		case "RIVER_TOP":
			return "river (top)"
		case "RIVER_BOT":
			return "river (bot)"
		default: {
			const side = sideOf(p)
			const quad = quadrantOf(p)
			const ownership =
				teamId === undefined ? "" : zone.startsWith("OWN_") ? "own " : "enemy "
			return `${ownership}${side}-side jungle (${quad})`
		}
	}
}

/** Short label for a chip/badge: `"drake"`, `"mid"`, `"e.jgl"`. */
export const zoneShortLabel = (zone: Zone): string =>
	({
		OWN_BASE: "base",
		ENEMY_BASE: "e.base",
		DRAGON_PIT: "drake",
		BARON_PIT: "baron",
		LANE_TOP: "top",
		LANE_MID: "mid",
		LANE_BOT: "bot",
		RIVER_TOP: "river+",
		RIVER_BOT: "river-",
		OWN_JUNGLE_TOP: "jgl+",
		OWN_JUNGLE_BOT: "jgl-",
		ENEMY_JUNGLE_TOP: "e.jgl+",
		ENEMY_JUNGLE_BOT: "e.jgl-"
	})[zone]

/* --------------------------------------------------------------- rendering */

/**
 * World -> minimap percentages, for absolutely-positioned SVG/HTML overlays.
 *
 * `left` grows with `x` (east is right). `top` is FLIPPED, because the game's `+y` points
 * north while a screen's `top` points south. Verified visually: rendering the 14 turret and
 * pit anchors through this transform lands blue nexus bottom-left, red nexus top-right,
 * baron upper-left river, dragon lower-right river.
 *
 * Bounds are Riot's canonical `(-120,-120)..(14870,14980)`, accurate to about +/-150 units.
 */
export const toMinimapPct = (p: Pos): { left: number; top: number } => {
	const left = ((p.x - MAP.minX) / (MAP.maxX - MAP.minX)) * 100
	const top = (1 - (p.y - MAP.minY) / (MAP.maxY - MAP.minY)) * 100
	return { left: clampPct(left), top: clampPct(top) }
}

/** Same transform against a pixel canvas of `size` px (square, e.g. the 512px DDragon map). */
export const toMinimapPx = (p: Pos, size = 512): { px: number; py: number } => {
	const pct = toMinimapPct(p)
	return { px: (pct.left / 100) * size, py: (pct.top / 100) * size }
}

/** Inverse of `toMinimapPct` — for click-to-place interactions. */
export const fromMinimapPct = (left: number, top: number): Pos => ({
	x: MAP.minX + (left / 100) * (MAP.maxX - MAP.minX),
	y: MAP.minY + (1 - top / 100) * (MAP.maxY - MAP.minY)
})

const clampPct = (n: number): number => (n < 0 ? 0 : n > 100 ? 100 : n)

/** Clamp a world position into the observed playable bounds. */
export const clampToMap = (p: Pos): Pos => ({
	x: Math.min(Math.max(p.x, MAP.minX), MAP.maxX),
	y: Math.min(Math.max(p.y, MAP.minY), MAP.maxY)
})

/** Straight-line interpolation between two 1-minute frames. See the caveat below. */
export const lerpPos = (a: Pos, b: Pos, t: number): Pos => ({
	x: a.x + (b.x - a.x) * t,
	y: a.y + (b.y - a.y) * t
})

/**
 * Frames are 60s apart and the median displacement between them is 4082 units — about 28%
 * of the map. Anything derived from an interpolated position is a GUESS: presence detection
 * built on it tops out around 65% sensitivity. Callers must degrade confidence accordingly
 * and phrase claims as "likely", never "you were".
 */
export const INTERPOLATION_IS_A_GUESS = true

/** Whether the team that owns `teamId` is the blue side. */
export const isBlue = (teamId: number): boolean => teamId === TEAM_BLUE

/** The other team. */
export const otherTeam = (teamId: TeamId): TeamId =>
	teamId === TEAM_BLUE ? TEAM_RED : TEAM_BLUE

/** participantId 1-5 => 100, 6-10 => 200. Verified 220/220 against the end-of-game payload. */
export const teamOfParticipant = (participantId: number): TeamId =>
	participantId <= 5 ? TEAM_BLUE : TEAM_RED
