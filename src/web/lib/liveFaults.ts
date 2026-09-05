/**
 * Everything that is currently wrong with the live coach, in sentences he can act on.
 *
 * ## Why this is one list and not fifteen catch blocks
 *
 * He turned the coach off mid-game and said, of nine lines that were all derivable from the
 * ground-truth block alone, that it looked like it was "not looking at the actual frames at all".
 * He was right, and the reason he had to GUESS is the point of this file: the frame grab, the
 * ground-truth fetch, the journal POST and the socket each failed into their own bare `catch`,
 * usually with a comment explaining that a blip is not worth interrupting a game for. Every one of
 * those comments is true about ONE failure and false about sixty of them. A dropped frame is
 * noise; a stream that has stopped producing pictures for five minutes is the whole feature being
 * broken, and the player is the last person who should have to infer it from the coach sounding
 * vague.
 *
 * So every path counts its own failures and hands the counts here, and this decides — in one
 * place, testably — what is worth saying and how loudly. That is also why the thresholds live
 * here rather than at each call site: "how many in a row is a fault" is the same judgement every
 * time, and it was previously made differently (or not at all) in four files.
 *
 * ## A blip must not shout, and a fault must not whisper
 *
 * Nothing here fires on a single failure except the ones that are already permanent by the time
 * they are observable (the share ending, the socket giving up). Everything transient needs a run
 * of consecutive failures, sized so the threshold is crossed at roughly the moment the player
 * would start to wonder — around ten to fifteen seconds of a feature being dead.
 *
 * ## These are STATUS, not toasts
 *
 * Every fault here describes a condition that is true *right now* and stops being rendered the
 * moment it stops being true. A toast that vanishes is exactly wrong for this: the failures worth
 * reporting last for minutes, and he is looking at the game, not at the panel, at the instant one
 * begins.
 */

/** `error` is "this half of the feature is not working". `warn` is "it is working worse". */
export type FaultLevel = "warn" | "error"

export interface Fault {
	/** Stable identity, so the UI and the tests can name a fault without matching on prose. */
	id: string
	level: FaultLevel
	/** What is wrong, in his words, with the number that makes it checkable. */
	text: string
	/** What he can do about it, or null when the only honest answer is "wait". */
	fix: string | null
	/** The same fault sized for the one-line compact strip. Keep it under ~40 characters. */
	short: string
}

/**
 * How the coach's voice is produced, which decides whether silent speakers are diagnosable.
 *
 * The Gemini socket returns audio, so "she has spoken lines and the player has played zero audio
 * chunks" is a real, checkable fault. A turn-based provider is spoken by `speechSynthesis`, which
 * this page never counts — reporting silence there would be a fault invented out of a number that
 * is always zero.
 */
export type CoachVoice = "socket" | "system"

export interface LiveFaultInput {
	/** Is a screen currently being shared at all? */
	sharing: boolean
	/** The share stopped without him asking — OS chrome, the browser, or the display going away. */
	shareEnded: boolean
	/** Why the last attempt to start sharing failed, already in plain words. */
	shareError: string | null
	/** Consecutive frame grabs that produced no picture. */
	framesMissed: number
	/** Consecutive frame grabs whose picture had not advanced since the one before. */
	framesStale: number
	/** Turns sent this session with no picture attached. */
	blindTurns: number
	/** Consecutive failed ground-truth reads. */
	truthFails: number
	/** Consecutive journal ticks that arrived far later than they were scheduled to. */
	throttledTicks: number
	/** Consecutive journal POSTs that did not store a frame. */
	journalFails: number
	/** The daemon's own words for why the last frame was refused, when it gave any. */
	journalReason: string | null
	/** Turns the socket dropped because it was not open. */
	droppedTurns: number
	/** Coach lines the daemon never acknowledged storing. */
	unsaved: number
	/** False when the DAEMON is unreachable — not the same as the League client being closed. */
	daemonReachable: boolean
	/** Consecutive failed attempts to ask the daemon whether the key works. */
	keyProbeFails: number
	coachStatus: "off" | "connecting" | "live" | "reconnecting" | "error"
	coachError: string | null
	voice: CoachVoice
	/** Coach lines spoken this session (hers, not his). */
	spokenLines: number
	/** Audio chunks actually handed to the speakers. */
	audioPlayed: number
	/** The browser is holding audio back until the page is clicked. */
	audioBlocked: boolean
}

/**
 * Three consecutive dead grabs.
 *
 * The journal grabs every 5s and a turn grabs every 10-40s, so three in a row is 10-15 seconds of
 * a coach with no eyes at the low end — long enough that it is not a scheduling hiccup, short
 * enough that he finds out during the fight rather than during the debrief.
 */
const MISSED_GRABS = 3

/** Same reasoning as {@link MISSED_GRABS}: a frozen picture is as blind as no picture. */
const STALE_GRABS = 3

/**
 * Two failed ground-truth reads.
 *
 * One is genuinely routine — the LCU bridge reconnects, the client is busy — and it costs exactly
 * one skipped turn, which is the designed behaviour rather than a fault. Two in a row is 20-80
 * seconds of a coach that has gone quiet, and silence with no explanation is the state he already
 * read as "broken" once.
 */
const TRUTH_FAILS = 2

/**
 * Three refused or failed frame POSTs, which is 15 seconds of a recording that is not recording.
 *
 * This is the number that decides whether the game gets graded afterwards, and the feature it
 * replaced — replay capture — ran for the app's entire life without completing once while nothing
 * on screen ever said so. Never again silently.
 */
const JOURNAL_FAILS = 3

/**
 * Three late ticks in a row, which at a throttled cadence is minutes of a half-speed feature.
 *
 * One late tick is a machine under load, which a machine running League always is. A run of them
 * is the browser deliberately slowing a background tab down, and that is worth saying because the
 * fix is his and it is trivial: put the window somewhere it can be seen.
 */
const SLOW_TICKS = 3

/**
 * Two failed key probes, which is twenty seconds of not knowing.
 *
 * The probe runs every ten seconds and one of them missing is a restart or a busy moment — the
 * next one will answer. Saying "can't reach eepalytics" over a daemon that is simply reloading is
 * the noise that teaches him to ignore this whole panel.
 */
const KEY_PROBE_FAILS = 2

export const liveFaults = (i: LiveFaultInput): Fault[] => {
	const out: Fault[] = []

	/*
	 * The share ending is first because it takes everything else with it: no picture for the coach,
	 * no frames for the journal, no graded review afterwards. The browser can end a whole-monitor
	 * capture on its own — a display going to sleep, a driver reset, the OS chrome's own stop
	 * button — and until this line existed the only symptom was the coach quietly getting vaguer.
	 */
	if (i.shareEnded && !i.sharing)
		out.push({
			id: "share-ended",
			level: "error",
			text: "Your screen share ended, so she can't see the game and nothing is being recorded.",
			fix: "Press “Share my screen” again and pick your whole display, not a single window.",
			short: "Screen share ended"
		})
	else if (i.shareError !== null && !i.sharing)
		out.push({
			id: "share-error",
			level: "error",
			text: i.shareError,
			fix: null,
			short: "Can't share the screen"
		})

	/*
	 * Sharing, but the picture is dead. These two are separated because the fix differs: a stream
	 * producing nothing is usually a share that needs restarting, while a stream producing the SAME
	 * frame forever is usually the source being suspended (a minimised window, a display asleep) and
	 * comes back on its own.
	 */
	if (i.sharing && i.framesMissed >= MISSED_GRABS)
		out.push({
			id: "frames-missed",
			level: "error",
			text: `The shared screen has produced no picture for ${i.framesMissed} tries — she is coaching from the numbers alone.`,
			fix: "Stop sharing and share again, picking your whole display rather than a window.",
			short: "No picture from the share"
		})
	else if (i.sharing && i.framesStale >= STALE_GRABS)
		out.push({
			id: "frames-stale",
			level: "error",
			text: `The shared screen hasn't changed across ${i.framesStale} check-ins — she is looking at a frozen picture.`,
			fix: "If you shared a window rather than a whole display, re-share and pick the display.",
			short: "Shared screen is frozen"
		})

	/*
	 * The count that names the reported failure exactly. It is kept separate from the two above
	 * because it survives them: he can fix the share and still want to know that the last eleven
	 * things she said were said with her eyes shut.
	 */
	if (i.blindTurns > 0)
		out.push({
			id: "blind-turns",
			level: "warn",
			text: `${i.blindTurns} check-in${i.blindTurns === 1 ? " was" : "s were"} sent with no picture — she was coaching from the numbers alone.`,
			fix: i.sharing && i.framesMissed === 0 ? null : "Re-share your screen and pick a display rather than a window.",
			short: `${i.blindTurns} blind check-in${i.blindTurns === 1 ? "" : "s"}`
		})

	if (i.truthFails >= TRUTH_FAILS)
		out.push({
			id: "truth-unreachable",
			level: "error",
			text: `Can't read the game data (${i.truthFails} tries) — she is holding off rather than guessing from the picture.`,
			fix: "Nothing to do if you're mid-game; she picks straight back up when it returns.",
			short: "No game data"
		})

	if (i.journalFails >= JOURNAL_FAILS)
		out.push({
			id: "journal-failing",
			level: "error",
			text:
				`${i.journalFails} frames in a row weren't saved, so this game may not be graded afterwards` +
				(i.journalReason === null ? "." : ` — ${i.journalReason}.`),
			fix: i.daemonReachable ? null : "Check eepalytics is still running.",
			short: "Frames aren't saving"
		})

	/*
	 * Nothing has failed here — it is all just happening far too slowly to be the feature he thinks
	 * he switched on. That is why it is a warning with a count rather than an error: frames are
	 * still being saved and she still speaks, at perhaps a twelfth of the rate, and every other
	 * line on this panel would go on reading as healthy.
	 */
	if (i.throttledTicks >= SLOW_TICKS)
		out.push({
			id: "tab-throttled",
			level: "warn",
			text: `${i.throttledTicks} frames in a row arrived far later than scheduled — a browser slows a tab down when it's hidden behind the game, and the recording and her check-ins slow with it.`,
			fix: "Put this window somewhere a corner of it stays visible, or use a second monitor.",
			short: "Window is being throttled"
		})

	if (i.coachStatus === "error")
		out.push({
			id: "coach-error",
			level: "error",
			text: i.coachError ?? "The coach stopped and could not restart itself.",
			fix: "Press “Start coaching” to try again.",
			short: "Coach stopped"
		})

	/*
	 * Dropped because the socket was not open at the instant the timer fired. One is a reconnect
	 * landing badly; a run of them means the heartbeat is firing into a closed socket, which looks
	 * from the outside exactly like a coach with nothing to say.
	 */
	if (i.droppedTurns >= 2)
		out.push({
			id: "turns-dropped",
			level: "warn",
			text: `${i.droppedTurns} check-ins were never sent because the connection wasn't open.`,
			fix: null,
			short: `${i.droppedTurns} check-ins lost`
		})

	/*
	 * She is talking and nothing is coming out. Only diagnosable on the socket path, where the page
	 * counts the chunks it plays; `audioBlocked` has its own button and its own explanation, so it
	 * is excluded rather than reported twice.
	 */
	if (i.voice === "socket" && !i.audioBlocked && i.spokenLines >= 2 && i.audioPlayed === 0)
		out.push({
			id: "audio-silent",
			level: "warn",
			text: `She has said ${i.spokenLines} things and none of them reached your speakers.`,
			fix: "Check this tab isn't muted, and that your output device is the one you're listening to.",
			short: "No sound is playing"
		})

	if (i.unsaved > 0)
		out.push({
			id: "lines-unsaved",
			level: "warn",
			text: `${i.unsaved} line${i.unsaved === 1 ? "" : "s"} couldn't be saved, so ${i.unsaved === 1 ? "it is" : "they are"} only on this screen — they won't appear in “What she said, earlier”.`,
			fix: "Check eepalytics is still running.",
			short: `${i.unsaved} line${i.unsaved === 1 ? "" : "s"} not saved`
		})

	/*
	 * The key probe failing is NOT a missing key, and the difference is the whole message. With the
	 * daemon down, the panel used to render the full "One-time setup: get a free Google key" flow at
	 * someone who already had one — a setup errand for a problem that was not his.
	 */
	if (i.keyProbeFails >= KEY_PROBE_FAILS)
		out.push({
			id: "key-unknown",
			level: "warn",
			text: "Can't reach eepalytics to check your Gemini key, so the voice coach can't start.",
			fix: "Check the daemon is running; this fixes itself when it comes back.",
			short: "Can't check the key"
		})

	/*
	 * Errors above warnings, and otherwise in the order they were pushed.
	 *
	 * The panel renders this list top to bottom, and the push order above is grouped by SUBJECT
	 * (the share, then the frames, then the daemon, then the socket) rather than by severity — so
	 * without this sort, "6 check-ins were sent with no picture" (a warning) printed above "can't
	 * read the game data" and "frames aren't saving" (both errors). Measured, not assumed: with
	 * blindTurns 6, truthFails 4, journalFails 5 and throttledTicks 4 the list came out
	 * `warn:blind-turns | error:truth-unreachable | error:journal-failing | warn:tab-throttled`,
	 * which puts the mildest thing wrong at the top of a list he is reading between fights.
	 *
	 * `sort` is stable in every engine this ships to, so the subject grouping survives inside each
	 * level — which is what makes the two frame faults still read next to the share fault.
	 */
	return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
}

/** The loudest thing currently wrong, for the one-line strip. Null when nothing is. */
export const topFault = (faults: Fault[]): Fault | null =>
	faults.find(f => f.level === "error") ?? faults[0] ?? null
