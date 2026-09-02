/**
 * ArkType validators for the **Replay API** on `127.0.0.1:2999/replay/*`.
 *
 * These do not live in `src/shared/schema/` because their provenance is different from
 * everything there. The Live Client Data types were captured from a running game; these were
 * recovered by reading the Riot-signed `League of Legends.exe` (`replay-capture.md` §2.2) and
 * have **never been executed**, because `/replay/*` is only registered while a replay is
 * playing and the research phase was forbidden from launching one.
 *
 * So: field names and enum values are exact (they are shipped Riot strings), but response
 * shapes are unverified. Every field here is therefore optional and unknown keys pass
 * through. The first thing the capture unit should do once a replay is running is
 *
 *     GET https://127.0.0.1:2999/swagger/v3/openapi.json
 *
 * which returns the complete authoritative schema and resolves every UNVERIFIED note below in
 * one request.
 */

import { type } from "arktype"

/** The game's own 3-vector. League is Y-UP: the middle component is height. */
export const Vector3f = type({ "x?": "number", "y?": "number", "z?": "number" })
export type Vector3f = typeof Vector3f.infer

export const RgbaColor = type({
	"r?": "number",
	"g?": "number",
	"b?": "number",
	"a?": "number"
})
export type RgbaColor = typeof RgbaColor.infer

/** `GET /replay/game` — "Information about the game client process." */
export const ReplayGameInfo = type({ "processID?": "number" })
export type ReplayGameInfo = typeof ReplayGameInfo.infer

/**
 * `GET|POST /replay/playback`.
 *
 * `time` is **seconds since the beginning of the game**, the same clock as the LCU timeline's
 * `timestamp / 1000` and the Live Client Data `EventTime`. `seeking` is the flag that tells
 * you a scrub has finished — poll it, do not guess at a delay.
 */
export const ReplayPlayback = type({
	"paused?": "boolean",
	"seeking?": "boolean",
	"time?": "number",
	"length?": "number",
	"speed?": "number"
})
export type ReplayPlayback = typeof ReplayPlayback.infer

/** POST body. Riot: "All values are optional." */
export interface ReplayPlaybackPatch {
	paused?: boolean
	/** Seconds since game start. */
	time?: number
	/** 0.5 = half speed, 2.0 = double. */
	speed?: number
	seeking?: boolean
}

/**
 * `HudCameraMode`. `fps`, `tps` and `focus` were read verbatim out of the binary; `top` and
 * `path` ("Top down camera" / "Path following camera") are inferred from their descriptions
 * because those short words are string-pooled elsewhere. **Confirm against the runtime enum.**
 */
export const HUD_CAMERA_MODES = ["fps", "tps", "focus", "top", "path"] as const
export type HudCameraMode = (typeof HUD_CAMERA_MODES)[number]

/**
 * `GET|POST /replay/render` — camera, scene toggles, HUD toggles, fog, depth of field.
 *
 * The coaching-relevant ones: `fogOfWar:false` reveals what the enemy was doing (the one
 * thing a normal replay viewer cannot show you), `interfaceAll:false` gives a clean frame,
 * `selectionName` + `outlineSelect` puts a marker on the champion being discussed.
 */
export const ReplayRender = type({
	"cameraMode?": "string",
	"cameraPosition?": Vector3f,
	"cameraRotation?": Vector3f,
	"cameraAttached?": "boolean",
	"cameraLockX?": "boolean",
	"cameraLockY?": "boolean",
	"cameraLockZ?": "boolean",
	"cameraMoveSpeed?": "number",
	"cameraLookSpeed?": "number",
	"fieldOfView?": "number",
	"nearClip?": "number",
	"farClip?": "number",

	"selectionName?": "string",
	"selectionOffset?": Vector3f,

	"outlineSelect?": "boolean",
	"outlineHover?": "boolean",
	"floatingText?": "boolean",
	"fogOfWar?": "boolean",
	"navGridOffset?": "number",
	"simulateAllParticlesWhileOffScreen?": "boolean",
	"environment?": "boolean",
	"characters?": "boolean",
	"champions?": "boolean",
	"minions?": "boolean",
	"particles?": "boolean",
	"banners?": "boolean",
	"healthBarChampions?": "boolean",
	"healthBarStructures?": "boolean",
	"healthBarWards?": "boolean",
	"healthBarPets?": "boolean",
	"healthBarMinions?": "boolean",

	"interfaceAll?": "boolean",
	"interfaceReplay?": "boolean",
	"interfaceScore?": "boolean",
	"interfaceScoreboard?": "boolean",
	"interfaceFrames?": "boolean",
	"interfaceMinimap?": "boolean",
	"interfaceTimeline?": "boolean",
	"interfaceChat?": "boolean",
	"interfaceTarget?": "boolean",
	"interfaceQuests?": "boolean",
	"interfaceAnnounce?": "boolean",
	"interfaceKillCallouts?": "boolean",
	"interfaceNeutralTimers?": "boolean",

	"skyboxPath?": "string",
	"skyboxRotation?": "number",
	"skyboxRadius?": "number",
	"skyboxOffset?": "number",
	"sunDirection?": Vector3f,

	"depthFogEnabled?": "boolean",
	"depthFogStart?": "number",
	"depthFogEnd?": "number",
	"depthFogIntensity?": "number",
	"depthFogColor?": RgbaColor,
	"heightFogEnabled?": "boolean",
	"heightFogStart?": "number",
	"heightFogEnd?": "number",
	"heightFogIntensity?": "number",
	"heightFogColor?": RgbaColor,

	"depthOfFieldEnabled?": "boolean",
	"depthOfFieldDebug?": "boolean",
	"depthOfFieldCircle?": "number",
	"depthOfFieldWidth?": "number",
	"depthOfFieldNear?": "number",
	"depthOfFieldMid?": "number",
	"depthOfFieldFar?": "number"
})
export type ReplayRender = typeof ReplayRender.infer

/** POST body for `/replay/render`. Every value optional; send only what you want changed. */
export type ReplayRenderPatch = Partial<ReplayRender>

/**
 * `AVContainer`. **There is no `jpg` codec in 16.17** — the hexdump of the enum block is
 * exhaustive. `png` writes a FOLDER of frames, one file per frame, so a "screenshot" is a
 * one-frame render into a directory you then pick the single PNG out of.
 */
export const REPLAY_CODECS = ["webm", "png", "pngAndDepth"] as const
export type ReplayCodec = (typeof REPLAY_CODECS)[number]

/** `GET|POST /replay/recording`. Riot: "Poll this resource for progress on the output." */
export const ReplayRecording = type({
	"recording?": "boolean",
	"path?": "string",
	"codec?": "string",
	"startTime?": "number",
	"endTime?": "number",
	"currentTime?": "number",
	"width?": "number",
	"height?": "number",
	"framesPerSecond?": "number",
	"enforceFrameRate?": "boolean",
	"lossless?": "boolean",
	"replaySpeed?": "number"
})
export type ReplayRecording = typeof ReplayRecording.infer

/** POST body for `/replay/recording`. `path` must be a WINDOWS path. */
export interface ReplayRecordRequest {
	codec: ReplayCodec
	/** Windows path. A directory for `png`/`pngAndDepth`, a file for `webm`. */
	path: string
	/** Game-clock seconds. */
	startTime: number
	endTime: number
	width?: number
	height?: number
	framesPerSecond?: number
	/** True makes the encoder slow the replay down to hit the target fps exactly. */
	enforceFrameRate?: boolean
	lossless?: boolean
	replaySpeed?: number
}

/**
 * `GET /replay/objects` — undocumented by Riot, and the best camera-targeting source there is:
 * live world coordinates for every champion at the current replay time, versus the match
 * timeline's one frame per minute.
 *
 * Query params: `types` (comma-separated: hero,minion,monster,turret,ward,generic) and
 * `detail` (adds health, maxHealth, level, skinID, stealth).
 *
 * UNVERIFIED whether the response is `{objects:[…]}` or a bare array — `LiveClient.objects()`
 * accepts both.
 */
export const ReplayObject = type({
	"netId?": "number|string",
	"characterName?": "string",
	"nameHash?": "number|string",
	"position?": Vector3f,
	"direction?": Vector3f,
	"boundingBox?": "unknown",
	"alive?": "boolean",
	"health?": "number",
	"maxHealth?": "number",
	"level?": "number",
	"skinID?": "number",
	"stealth?": "boolean|number|string",
	"team?": "string"
})
export type ReplayObject = typeof ReplayObject.infer

export const ReplayObjectsResponse = type({ "objects?": ReplayObject.array() })
export type ReplayObjectsResponse = typeof ReplayObjectsResponse.infer

/**
 * `GET /replay/events` — undocumented. Riot: "the replay's pre-indexed look-ahead moment
 * events (kills, objectives, multikills, etc)." If it works as it reads, this is the cheapest
 * possible moment index; sample it first thing during runtime verification.
 */
export const ReplayMomentEvent = type({
	"kind?": "string",
	"moment?": "number",
	"teamId?": "number|string",
	"fromNameHash?": "number|string",
	"toNameHash?": "number|string",
	"fromCharacterName?": "string",
	"toCharacterName?": "string",
	"displayable?": "boolean",
	"spawn?": "boolean"
})
export type ReplayMomentEvent = typeof ReplayMomentEvent.infer

/**
 * `GET|POST /replay/sequence` — a keyframe animation applied to the replay. POST an empty
 * object to remove it. The envelope is probably
 * `{cameraPosition:[{time,blend,value},…], …}` but that is UNVERIFIED, so it is left untyped
 * rather than pinned to a guess.
 */
export type ReplaySequence = Record<string, unknown>

/** Tracks the sequence system can animate. `cameraMode` and every toggle are NOT animatable. */
export const SEQUENCE_TRACKS = [
	"playbackSpeed",
	"cameraPosition",
	"cameraRotation",
	"fieldOfView",
	"nearClip",
	"farClip",
	"navGridOffset",
	"skyboxRotation",
	"skyboxRadius",
	"skyboxOffset",
	"sunDirection",
	"depthFogEnabled",
	"depthFogStart",
	"depthFogEnd",
	"depthFogIntensity",
	"depthFogColor",
	"heightFogEnabled",
	"heightFogStart",
	"heightFogEnd",
	"heightFogIntensity",
	"heightFogColor",
	"depthOfFieldEnabled",
	"depthOfFieldCircle",
	"depthOfFieldWidth",
	"depthOfFieldNear",
	"depthOfFieldMid",
	"depthOfFieldFar",
	"selectionName",
	"selectionOffset"
] as const

export const EASING_TYPES = [
	"linear",
	"snap",
	"smoothStep",
	"smootherStep",
	"quadraticEaseIn",
	"quadraticEaseOut",
	"quadraticEaseInOut",
	"cubicEaseIn",
	"cubicEaseOut",
	"cubicEaseInOut",
	"quarticEaseIn",
	"quarticEaseOut",
	"quarticEaseInOut",
	"quinticEaseIn",
	"quinticEaseOut",
	"quinticEaseInOut",
	"sineEaseIn",
	"sineEaseOut",
	"sineEaseInOut",
	"circularEaseIn",
	"circularEaseOut",
	"circularEaseInOut",
	"exponentialEaseIn",
	"exponentialEaseOut",
	"exponentialEaseInOut",
	"elasticEaseIn",
	"elasticEaseOut",
	"elasticEaseInOut",
	"backEaseIn",
	"backEaseOut",
	"backEaseInOut",
	"bounceEaseIn",
	"bounceEaseOut",
	"bounceEaseInOut"
] as const
export type EasingType = (typeof EASING_TYPES)[number]
