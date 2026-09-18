/**
 * IS THIS THING SET UP, and has it ever actually run?
 *
 * The app had no answer to either question. Every screen answered "what is in the database",
 * which for a person who has just installed it is an empty table — and an empty table is
 * indistinguishable from a broken one. The first-run path was never designed because there was
 * never a single place that knew what a first run WAS.
 *
 * So this is that place, and it is pure: three readings in, three steps out. Nothing here
 * fetches, retries, or renders — `components/FirstRun.tsx` draws it and `pages/Live.tsx` decides
 * whether the coach panel goes above or below it.
 *
 * ## The rule that matters: unknown is its own state
 *
 * A step is `done`, `todo` or `unknown`, and `unknown` never renders as `todo`. A page that has
 * not heard back from the daemon yet must not tell a man with 153 stored games that he has never
 * played one — that is the "silence looks like breakage" failure, pointed the other way, and it
 * would be the very first thing a returning user saw on every cold load. So `firstRun` is true
 * only when a games list has positively been READ and was EMPTY.
 *
 * "Empty library" rather than "no coached game in the recent window", and that is a correction
 * made against a screenshot: his last twenty games carry no journal frames, so the looser rule
 * put the getting-started card on the home screen of a 153-game install under the words "you
 * just have not finished a game with her watching yet" — which is false for him, since two
 * older games in the library have paired frames. A man with a library has already seen this
 * thing work. The per-row line on the History screen ("no journal frames … screen-share and the
 * next one will") is the right place for the narrower nudge, and it is already there.
 */

import type { GameListItem } from "../../shared/schema/api.ts"

export type StepState = "done" | "todo" | "unknown"

export interface ReadyStep {
	id: "client" | "voice" | "play"
	/** The imperative. What he would have to do. */
	title: string
	state: StepState
	/** One sentence: what this buys him, or what is currently true instead. */
	detail: string
}

export interface ReadinessInput {
	/**
	 * Can the daemon read the League client right now? `null` while unread.
	 *
	 * This is `GameflowGate.reachable` rather than `health.lcu`, for one reason: the gameflow
	 * poller is already running for the coach, shared and refcounted, so the first-run card costs
	 * no new request anywhere — including in the 380px popout, which has no health poll at all.
	 */
	clientReachable: boolean | null
	/** The recent games, or `null` while unread. Used only to ask whether ANY game was coached. */
	games: readonly GameListItem[] | null
	/** `GET /api/live/gemini/status`, or `null` while unread. */
	voice: { configured?: boolean; ok: boolean } | null
}

export interface Readiness {
	steps: ReadyStep[]
	/**
	 * The library is empty — positively established by reading it, never assumed from an
	 * unanswered fetch. This is what gates the first-run card.
	 */
	firstRun: boolean
	/** Every step reads `done`. Nothing is waiting on him. */
	allDone: boolean
}

/**
 * A game counts as COACHED when it has moments backed by real journal frames.
 *
 * Not `hasReview`: every ingested game gets a review whether or not anyone was watching, and a
 * review with no frames is the honest-but-thin tier the review prompt itself calls "there is
 * genuinely less to say about a game nobody watched". The thing a first run is trying to reach
 * is the OTHER tier, so that is what is counted.
 */
export const wasCoached = (g: GameListItem): boolean => (g.frameMoments ?? 0) > 0

export const readiness = ({ clientReachable, games, voice }: ReadinessInput): Readiness => {
	const coached = games === null ? null : games.some(wasCoached)

	const client: ReadyStep =
		clientReachable === null ?
			{
				id: "client",
				title: "Open the League client",
				state: "unknown",
				detail: "Still asking the daemon whether it can see the client."
			}
		: clientReachable ?
			{
				id: "client",
				title: "Open the League client",
				state: "done",
				detail: "Connected. Your finished games are read out of it automatically."
			}
		:	{
				id: "client",
				title: "Open the League client",
				state: "todo",
				detail: "Everything here is read out of the running client — the live feed during a game, the match afterwards."
			}

	const voiceStep: ReadyStep =
		voice === null ?
			{
				id: "voice",
				title: "Add the free voice key",
				state: "unknown",
				detail: "Checking whether a key is saved."
			}
		: voice.ok ?
			{
				id: "voice",
				title: "Add the free voice key",
				state: "done",
				detail: "Saved and working. She talks out loud, about a second behind your screen."
			}
		: voice.configured ?
			{
				id: "voice",
				title: "Add the free voice key",
				state: "todo",
				detail: "A key is saved but Google refused it — usually a partial copy. Paste it again below."
			}
		:	{
				id: "voice",
				title: "Add the free voice key",
				state: "todo",
				detail: "Free from aistudio.google.com/apikey, and it stays on this machine. Without it everything still records; she just cannot speak."
			}

	const play: ReadyStep =
		coached === null ?
			{
				id: "play",
				title: "Share your screen, then play",
				state: "unknown",
				detail: "Looking at what has been recorded so far."
			}
		: coached ?
			{
				id: "play",
				title: "Share your screen, then play",
				state: "done",
				detail: "A game has been recorded with the coach watching — that is the graded tier."
			}
		:	{
				id: "play",
				title: "Share your screen, then play",
				state: "todo",
				detail: "Share once and leave it. Nothing is sent between games: she wakes at champion select and goes quiet when the game ends."
			}

	const steps = [client, voiceStep, play]
	return {
		steps,
		firstRun: games !== null && games.length === 0,
		allDone: steps.every(s => s.state === "done")
	}
}
