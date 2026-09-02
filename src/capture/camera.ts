/**
 * Camera math and render presets for replay capture. PURE — no I/O, no DB, no clients, so
 * every number in here is unit-testable and every number is a knob you can re-derive.
 *
 * ## Honesty about what is measured
 *
 * `.research/replay-capture.md` §5.2 establishes, from the live OpenAPI doc, that
 * `Render.cameraPosition` is a `Vector3f {x,y,z}` and that League's engine is Y-up, so the
 * expected mapping from a timeline world coordinate is
 *
 *     timeline (x, y)  ->  cameraPosition { x, y: <height>, z: y }
 *
 * That mapping, the Euler component order of `cameraRotation`, the sign of pitch, and every
 * default height/FOV below are **[UNVERIFIED-NEEDS-RUNTIME-TEST]**. They are collected into
 * a single `CameraCalibration` object precisely so that the runtime-verification pass can
 * measure them once (§5.2's recipe: compare `/replay/render.cameraPosition` against
 * `/replay/objects?types=hero` while the directed camera follows someone) and write the
 * measured values into one place instead of hunting through the code.
 *
 * Prefer `selectionName` targeting when a champion name is known: it needs no coordinate
 * math at all, and it keeps the subject in frame while they move during a clip.
 */

import type { Moment, MomentKind } from "../shared/schema/domain.ts"
import type { Pos } from "../shared/map.ts"

export interface Vector3f {
	x: number
	y: number
	z: number
}

/**
 * Everything about pointing the camera that we have NOT measured yet.
 * `verified` is false until a runtime pass confirms it; the UI and the README both say so.
 */
export interface CameraCalibration {
	/**
	 * Which camera component carries height.
	 * `y-up`: {x: world.x, y: height, z: world.y}  <- expected, per the engine being Y-up
	 * `z-up`: {x: world.x, y: world.y, z: height}
	 */
	heightAxis: "y-up" | "z-up"
	/** Euler component order of `cameraRotation` (Riot's prose says yaw,pitch,roll; struct is x,y,z). */
	rotationOrder: "pitch-yaw-roll" | "yaw-pitch-roll"
	/** Degrees below the horizon the camera looks. 90 = straight down. */
	pitchDeg: number
	/** +1 if "looking down" is a positive pitch component; -1 if negative. Unmeasured. */
	pitchSign: 1 | -1
	/** Compass yaw, degrees. 0 = camera sits at lower world-y and looks toward higher y. */
	yawDeg: number
	rollDeg: number
	/** Riot's documented default is 45. */
	fieldOfView: number
	/** Set true only once a runtime pass has actually confirmed these. */
	verified: boolean
}

export const DEFAULT_CAMERA_CALIBRATION: CameraCalibration = {
	heightAxis: "y-up",
	rotationOrder: "pitch-yaw-roll",
	pitchDeg: 60,
	pitchSign: 1,
	yawDeg: 0,
	rollDeg: 0,
	fieldOfView: 45,
	verified: false
}

/** kv key the daemon should store a measured calibration under. */
export const CALIBRATION_KV_KEY = "capture.cameraCalibration"

/**
 * How high above the ground to put the camera, per moment kind, in world units.
 * The map is ~14,800 units across, so 1800 units frames roughly a skirmish and 3200 frames
 * a full teamfight plus its approach. Tune once at runtime; these are reasoned, not measured.
 */
export const CAMERA_HEIGHT_BY_KIND: Record<MomentKind, number> = {
	death: 2000,
	kill: 2000,
	objective: 2600,
	objective_missed: 3400,
	gold_swing: 2600,
	tempo: 3400,
	cs_gap: 1800,
	positioning: 2600,
	vision: 2200,
	teamfight: 3200,
	recall: 1800,
	other: 2400
}

export const cameraHeightFor = (kind: MomentKind): number =>
	CAMERA_HEIGHT_BY_KIND[kind] ?? 2400

/* ============================================================ projection */

const DEG = Math.PI / 180

/** Place a world ground point into camera space at the given height. */
export const worldToCameraPosition = (
	pos: Pos,
	height: number,
	cal: CameraCalibration = DEFAULT_CAMERA_CALIBRATION
): Vector3f =>
	cal.heightAxis === "y-up" ?
		{ x: noNegZero(pos.x), y: noNegZero(height), z: noNegZero(pos.y) }
	:	{ x: noNegZero(pos.x), y: noNegZero(pos.y), z: noNegZero(height) }

/**
 * Horizontal distance the camera must sit *behind* its subject so the subject lands in the
 * middle of frame: with the camera `height` above the ground looking `pitchDeg` below the
 * horizon, its sight line hits the ground `height / tan(pitch)` units ahead of it.
 * At pitch 90 (straight down) that is 0, which is correct.
 */
export const groundOffsetForPitch = (height: number, pitchDeg: number): number => {
	const p = Math.min(90, Math.max(0.1, pitchDeg))
	return noNegZero(height / Math.tan(p * DEG))
}

/** -0 is a real value in JS and it leaks into JSON as `-0`. Normalise it away. */
const noNegZero = (n: number): number => (n === 0 ? 0 : n)

/** Unit ground vector the camera faces. yaw 0 => +worldY (toward red side). */
export const yawToGroundVector = (yawDeg: number): Pos => ({
	x: noNegZero(Math.sin(yawDeg * DEG)),
	y: noNegZero(Math.cos(yawDeg * DEG))
})

export const eulerFor = (cal: CameraCalibration): Vector3f => {
	const pitch = cal.pitchDeg * cal.pitchSign
	return cal.rotationOrder === "pitch-yaw-roll" ?
			{ x: pitch, y: cal.yawDeg, z: cal.rollDeg }
		:	{ x: cal.yawDeg, y: pitch, z: cal.rollDeg }
}

export interface CameraShot {
	cameraPosition: Vector3f
	cameraRotation: Vector3f
	fieldOfView: number
	/** The world point the camera is aimed at. Kept for provenance/debugging. */
	target: Pos
	/** Horizontal pull-back applied, in world units. */
	groundDistance: number
}

/** Frame `target` from `height` units up, per the calibration. */
export const cameraForTarget = (
	target: Pos,
	height: number,
	cal: CameraCalibration = DEFAULT_CAMERA_CALIBRATION
): CameraShot => {
	const back = groundOffsetForPitch(height, cal.pitchDeg)
	const dir = yawToGroundVector(cal.yawDeg)
	const ground: Pos = { x: target.x - dir.x * back, y: target.y - dir.y * back }
	return {
		cameraPosition: worldToCameraPosition(ground, height, cal),
		cameraRotation: eulerFor(cal),
		fieldOfView: cal.fieldOfView,
		target,
		groundDistance: back
	}
}

/**
 * `selectionOffset` equivalent of the same framing: "camera location = selection location +
 * this offset". Same pull-back, expressed relative to the subject rather than absolutely.
 */
export const selectionOffsetFor = (
	height: number,
	cal: CameraCalibration = DEFAULT_CAMERA_CALIBRATION
): Vector3f => {
	const back = groundOffsetForPitch(height, cal.pitchDeg)
	const dir = yawToGroundVector(cal.yawDeg)
	return worldToCameraPosition({ x: -dir.x * back, y: -dir.y * back }, height, cal)
}

/* =========================================================== render body */

/**
 * The subset of `POST /replay/render` this app sets. Field names are [VERIFIED-BINARY];
 * every one of them is optional in Riot's own schema ("All values are optional").
 */
export interface RenderSettings {
	cameraMode?: "fps" | "tps" | "focus" | "top" | "path"
	cameraPosition?: Vector3f
	cameraRotation?: Vector3f
	cameraAttached?: boolean
	fieldOfView?: number
	selectionName?: string
	selectionOffset?: Vector3f
	outlineSelect?: boolean
	outlineHover?: boolean
	floatingText?: boolean
	fogOfWar?: boolean
	environment?: boolean
	characters?: boolean
	champions?: boolean
	minions?: boolean
	particles?: boolean
	banners?: boolean
	healthBarChampions?: boolean
	healthBarStructures?: boolean
	healthBarWards?: boolean
	healthBarPets?: boolean
	healthBarMinions?: boolean
	interfaceAll?: boolean
	interfaceReplay?: boolean
	interfaceScore?: boolean
	interfaceScoreboard?: boolean
	interfaceFrames?: boolean
	interfaceMinimap?: boolean
	interfaceTimeline?: boolean
	interfaceChat?: boolean
	interfaceTarget?: boolean
	interfaceQuests?: boolean
	interfaceAnnounce?: boolean
	interfaceKillCallouts?: boolean
	interfaceNeutralTimers?: boolean
	depthFogEnabled?: boolean
	depthOfFieldEnabled?: boolean
}

/**
 * Scene setup applied once per session, before any capture.
 *
 * `fogOfWar: false` is the coaching feature a normal replay watcher cannot get — it shows
 * what the enemy was actually doing while you could not see them. Every screenshot the coach
 * produces is therefore a *God's-eye* view, and the UI must label it as such so the user
 * never mistakes it for what was on their screen at the time.
 *
 * NOTE: `interfaceAll: false` and the individual `interface*` flags are sent in the same POST
 * and Riot does not document precedence. `applySceneSetup` in launcher.ts sends the master
 * switch first, in its own request, then the individual flags, so the outcome is defined
 * regardless.
 */
export const HUD_OFF: RenderSettings = {
	interfaceAll: false
}

export const COACHING_SCENE: RenderSettings = {
	fogOfWar: false,
	outlineSelect: true,
	outlineHover: false,
	floatingText: false,
	environment: true,
	characters: true,
	champions: true,
	minions: true,
	particles: true,
	banners: false,
	healthBarChampions: true,
	healthBarStructures: true,
	healthBarWards: true,
	healthBarPets: false,
	healthBarMinions: false,
	depthFogEnabled: false,
	depthOfFieldEnabled: false,
	// Keep the two overlays that carry coaching information; drop the rest.
	interfaceMinimap: true,
	interfaceScore: true,
	interfaceReplay: false,
	interfaceScoreboard: false,
	interfaceFrames: false,
	interfaceTimeline: false,
	interfaceChat: false,
	interfaceTarget: false,
	interfaceQuests: false,
	interfaceAnnounce: false,
	interfaceKillCallouts: false,
	interfaceNeutralTimers: true
}

export interface FrameMomentOptions {
	cal?: CameraCalibration
	/**
	 * Champion the moment is about, as `/replay/objects` reports it in `characterName`.
	 * When present we aim with `selectionName` + `selectionOffset` (robust, tracks movement);
	 * when absent we fall back to absolute `cameraPosition`.
	 */
	selectionName?: string | null
	/** Override the per-kind height. */
	heightOverride?: number | null
}

/**
 * Turn a `Moment` into the render body that frames it.
 *
 * `moment.cameraTarget` wins over `mapX/mapY` — that is exactly what it is for: "look at the
 * dragon pit you were NOT at", where the event position and the thing to look at differ.
 */
export const frameMoment = (
	moment: Moment,
	opts: FrameMomentOptions = {}
): RenderSettings => {
	const cal = opts.cal ?? DEFAULT_CAMERA_CALIBRATION
	const height = opts.heightOverride ?? cameraHeightFor(moment.kind)
	const target: Pos = moment.cameraTarget ?? { x: moment.mapX, y: moment.mapY }

	if (opts.selectionName) {
		return {
			cameraMode: "focus",
			selectionName: opts.selectionName,
			selectionOffset: selectionOffsetFor(height, cal),
			fieldOfView: cal.fieldOfView,
			outlineSelect: true
		}
	}

	const shot = cameraForTarget(target, height, cal)
	return {
		cameraMode: "fps",
		cameraAttached: false,
		cameraPosition: shot.cameraPosition,
		cameraRotation: shot.cameraRotation,
		fieldOfView: shot.fieldOfView
	}
}
