/**
 * Settings, after the 2026-09-18 audit.
 *
 * ## What this screen was
 *
 * Fourteen fields across four panels, every one of them on the first screen, each with a
 * paragraph of evidence under it. Polling intervals in milliseconds sat beside the one knob he
 * has asked for in every session. He has asked five times for the interface to be
 * non-overwhelming, and this screen grew every week of the campaign, because a new knob always
 * had an obvious place to go and never an obvious place to be REFUSED.
 *
 * ## The rule that replaced "add a field, add a control"
 *
 * `shared/schema/settings.ts` now files every field under `SIMPLE`, `ADVANCED` or `UNEXPOSED`,
 * the three lists partition the schema, and the suite fails if a new field is filed nowhere. So
 * the refusal is mechanical rather than a matter of taste, and the argument for each one is
 * written next to it there.
 *
 * Two controls are on the first screen: how often she speaks, and how she talks. Seven are one
 * disclosure down. Five have no control at all.
 *
 * ## Deleting a control is not deleting a value, and the difference is the whole lesson
 *
 * A stored row outranks the code default forever. `autoReviewNewGames: false`, written once on
 * 2026-09-04, switched off the only tier of this product a human has graded — for eight days,
 * while the checkbox rendered `false` and looked exactly like a field nobody had touched. Taking
 * the checkbox away does not fix that; it would HIDE it.
 *
 * So the override banner is now the load-bearing part of this screen rather than a footnote: any
 * field that disagrees with the code default is named, whether or not it has a control, and each
 * one has a button that puts it back. You cannot set the hidden knobs. You can always see that
 * one of them is set, and undo it in a click.
 */

import { useEffect, useMemo, useState } from "react"
import type { HealthResponse } from "../../shared/schema/api.ts"
import type { Settings, SettingsPatch } from "../../shared/schema/settings.ts"
import {
	DEFAULT_SETTINGS,
	INTENSITY_STOPS,
	MODEL_CHOICES,
	clampSettings,
	nearestIntensityStop,
	settingsOverrides
} from "../../shared/schema/settings.ts"
import { LIVE_COACH_MODES } from "../../shared/live-coach-mode.ts"
import { SPEAK_LEVELS } from "../../analysis/live-events.ts"
import { api } from "../lib/api.ts"
import { useAction, useNow, useResource } from "../lib/hooks.ts"
import { cls, fmtAgo, phaseWord } from "../lib/format.ts"
import { Broken, Loading } from "../components/States.tsx"

export interface SettingsPageProps {
	health: HealthResponse | null
	onSaved: () => void
}

export const SettingsPage = ({ health, onSaved }: SettingsPageProps) => {
	const loaded = useResource(signal => api.settings(signal), [])
	const [draft, setDraft] = useState<Settings | null>(null)
	/** Typed but not yet saved. Never populated from the server — keys are write-only. */
	const [providerKeyDraft, setProviderKeyDraft] = useState("")
	const providers = useResource(
		signal =>
			fetch("/api/live/coach/providers", { signal }).then(
				r =>
					r.json() as Promise<{
						providers: {
							id: string
							label: string
							available: boolean
							note: string
							defaultModel: string
						}[]
						/** Socket ids this app has actually opened — suggestions, not an allowlist. */
						socketModels?: { id: string; note: string }[]
					}>
			),
		[]
	)
	/*
	 * Checking the key is a live call to Google, so it is a button rather than something that
	 * fires on every keystroke. Someone pasting a bad key should find out here, not mid-game.
	 */
	const [gemini, setGemini] = useState<{
		ok: boolean
		error?: string | null
		hint?: string
		configured?: boolean
	} | null>(null)
	/*
	 * Held apart from `draft` because the key does not live in settings — it is written straight
	 * to a 0600 file by its own write-only endpoint, so it never comes back in `GET /api/settings`
	 * and never sits in this page's state after a reload.
	 */
	const [geminiKeyInput, setGeminiKeyInput] = useState("")
	/**
	 * `null` = nobody has said either way, so the panel decides: open when there is no working
	 * key, closed when there is. A plain `false` here made the auto-opened box impossible to
	 * shut — the toggle flipped `false` to `true` and the box was open on both, under a button
	 * that said "Hide".
	 */
	const [keyOpen, setKeyOpen] = useState<boolean | null>(null)

	const readGemini = async () => {
		try {
			const r = await fetch("/api/live/gemini/status")
			setGemini((await r.json()) as { ok: boolean; error?: string | null; hint?: string })
		} catch (e) {
			setGemini({ ok: false, error: e instanceof Error ? e.message : String(e) })
		}
	}
	useEffect(() => {
		void readGemini()
	}, [])

	const saveGeminiKey = async (key: string) => {
		setGemini(null)
		try {
			const r = await fetch("/api/live/gemini/key", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key })
			})
			const j = (await r.json()) as { configured?: boolean; works?: boolean; error?: string | null }
			setGeminiKeyInput("")
			setGemini({ ok: Boolean(j.works), error: j.error, configured: j.configured })
			if (j.configured) await readGemini()
		} catch (e) {
			setGemini({ ok: false, error: e instanceof Error ? e.message : String(e) })
		}
	}
	const now = useNow(30_000)

	useEffect(() => {
		if (loaded.data) setDraft(loaded.data)
	}, [loaded.data])

	const changed = useMemo<SettingsPatch>(() => {
		if (!draft || !loaded.data) return {}
		const clamped = clampSettings(draft)
		const patch: Record<string, unknown> = {}
		for (const key of Object.keys(clamped) as (keyof Settings)[])
			if (clamped[key] !== loaded.data[key]) patch[key] = clamped[key]
		return patch as SettingsPatch
	}, [draft, loaded.data])

	const dirty = Object.keys(changed).length > 0

	const save = useAction(async () => {
		const next = await api.saveSettings(changed)
		setDraft(next)
		loaded.reload()
		onSaved()
	})

	/** Put one field back on its code default. The only way to reach an unexposed field. */
	const resetOne = useAction(async (key: keyof Settings) => {
		const next = await api.saveSettings({ [key]: DEFAULT_SETTINGS[key] } as SettingsPatch)
		setDraft(next)
		loaded.reload()
		onSaved()
	})

	if (!draft)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Settings</h1>
				</div>
				{loaded.error ?
					<Broken
						title="Couldn't load settings."
						message={loaded.error}
						actions={<button onClick={loaded.reload}>Retry</button>}
					/>
				:	<Loading rows={1} height={320} label="Loading settings" />}
			</div>
		)

	const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
		setDraft(d => (d === null ? d : { ...d, [key]: value }))

	const knownModel = MODEL_CHOICES.some(m => m.id === draft.model)
	const intensityStop = nearestIntensityStop(draft.coachIntensity)
	const voiceWorking = gemini?.ok === true
	const showKeyBox = keyOpen ?? (gemini !== null && !voiceWorking)

	/*
	 * Every field this install has moved off its code default, named out loud — and now the only
	 * route to the five that have no control. See the file header: removing a control removes the
	 * ability to SET a value, and the eight-day outage came from being unable to SEE one.
	 */
	const overrides = settingsOverrides(loaded.data ?? draft)
	/** Warnings the daemon is reporting right now. Never silent, whatever screen you are on. */
	const warnings = health?.warnings ?? []

	return (
		<div className="page">
			<div className="page-head">
				<h1>Settings</h1>
				<div className="sub">
					Two choices here. Everything else runs on a default that was measured — the rest is one
					disclosure down, with the measurement beside it.
				</div>
			</div>

			{warnings.length > 0 ?
				<div className="notice warn">
					<span className="icon">⚠</span>
					<div>
						<strong>
							The daemon is reporting {warnings.length} problem{warnings.length === 1 ? "" : "s"}.
						</strong>
						<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
							{warnings.map((w, i) => (
								<li key={i}>{w}</li>
							))}
						</ul>
					</div>
				</div>
			:	null}

			{overrides.length > 0 ?
				<div className="notice warn">
					<span className="icon">⚠</span>
					<div>
						<strong>
							{overrides.length} setting{overrides.length === 1 ? " is" : "s are"} off the default.
						</strong>{" "}
						A stored value outranks the code default forever, including for the fields that no
						longer have a control. This is the only place that says so.
						<ul className="overrides">
							{overrides.map(o => (
								<li key={String(o.key)}>
									<code className="mono">{String(o.key)}</code> is{" "}
									<b>{JSON.stringify(o.value)}</b>, not {JSON.stringify(o.default)}
									<button
										className="btn btn-sm"
										disabled={resetOne.pending}
										onClick={() => resetOne.run(o.key)}
									>
										Put it back
									</button>
								</li>
							))}
						</ul>
						{resetOne.error ?
							<div className="band-bad" style={{ fontSize: "var(--fs-2)" }}>
								{resetOne.error}
							</div>
						:	null}
					</div>
				</div>
			:	null}

			{/* ============================================================ the voice */}

			{/*
			 * The key is not a setting — it is the one piece of setup without which the flagship
			 * feature cannot speak. So it renders as a STATE, collapsed to a line while it works,
			 * and opens itself when it does not. It was previously a password box and two
			 * paragraphs sitting permanently between two real settings.
			 */}
			<div className="panel panel-pad">
				<div className="setting-row">
					<div>
						<div className="label">Her voice</div>
						<div className="help" style={{ margin: 0 }}>
							{gemini === null ?
								"Checking the saved key…"
							: voiceWorking ?
								<>
									Working{gemini.hint ? ` (${gemini.hint})` : ""}. She speaks over a held-open
									socket, about a second behind your screen.
								</>
							: gemini.configured ?
								"A key is saved but Google refused it — usually a partial copy."
							:	"No key yet. Everything still records and every game is still graded afterwards; she just cannot talk."}
						</div>
					</div>
					<div className="setting-row__right">
						<span className={cls("pill", voiceWorking ? "band-good" : gemini === null ? "" : "band-bad")}>
							{gemini === null ? "checking…" : voiceWorking ? "connected" : "not set up"}
						</span>
						<button className="btn btn-sm" onClick={() => setKeyOpen(!showKeyBox)}>
							{showKeyBox ? "Hide" : voiceWorking ? "Replace key" : "Set it up"}
						</button>
					</div>
				</div>

				{showKeyBox ?
					<div className="field wide" style={{ marginTop: "var(--sp-3)" }}>
						<div className="control">
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder={
									gemini?.hint ? `saved (${gemini.hint}) — paste a new one to replace` : (
										"paste an AI Studio API key"
									)
								}
								value={geminiKeyInput}
								onChange={e => setGeminiKeyInput(e.target.value)}
								style={{ width: "100%" }}
							/>
							<div style={{ display: "flex", gap: 6, marginTop: "var(--sp-2)" }}>
								<button
									className="btn"
									type="button"
									disabled={geminiKeyInput.trim() === ""}
									onClick={() => void saveGeminiKey(geminiKeyInput)}
								>
									Save &amp; test
								</button>
								{gemini?.hint && (
									<button className="btn" type="button" onClick={() => void saveGeminiKey("")}>
										Clear
									</button>
								)}
							</div>
							{gemini !== null && !gemini.ok && gemini.error ? (
								<div className="field-status band-bad">{gemini.error}</div>
							) : null}
						</div>
						<div className="help">
							Free at <code className="mono">aistudio.google.com/apikey</code> — sign in, press
							Create API key, paste it here. It stays on this machine: the daemon swaps it for a
							short-lived token and only that reaches the browser. There is no "sign in with
							Google" because the Live API takes an API key and a consumer Gemini subscription
							grants no API access.
						</div>
					</div>
				:	null}
			</div>

			{/* ==================================================== how often she speaks */}

			{/*
			 * The one knob he has asked for in every session, and the only lever in this app on how
			 * much the coach talks. It moves WHICH ASKS FIRE and nothing else — no prompt changes, no
			 * subject is forbidden, no sentence is suppressed.
			 *
			 * Each option carries its replayed count including the option he is NOT on, because a
			 * volume claim with no number beside it is the sentence he has learned to discount.
			 */}
			<div className="panel panel-pad">
				<div className="section-title">
					How often she speaks <span className="rule" />
				</div>
				<div className="choices">
					{SPEAK_LEVELS.map(l => {
						const on = draft.liveSpeakLevel === l.id
						return (
							<label key={l.id} className={cls("choice", on && "on")}>
								<input
									type="radio"
									name="liveSpeakLevel"
									checked={on}
									onChange={() => set("liveSpeakLevel", l.id)}
								/>
								<div>
									<div className="choice__title">
										{l.label} — about {l.linesPerGame.toFixed(1)} lines in a 28-minute game
										{l.id === DEFAULT_SETTINGS.liveSpeakLevel ? (
											<span className="chip">default</span>
										) : null}
									</div>
									<div className="choice__blurb">{l.blurb}</div>
									<div className="choice__evidence">
										<b>Measured:</b> {l.evidence}
									</div>
								</div>
							</label>
						)
					})}
				</div>
				<div className="help">
					Replayed through the real detector over 28 of your own recorded games — 879 turns, each
					joined to the ask that raised it and graded blind. Re-derive any of these with{" "}
					<code className="mono">scripts/measure-asks.ts --level &lt;id&gt;</code>; no model is
					consulted. This changes <b>when she is asked</b>, never what she may say: the prompt is
					byte-identical on all three, and the live board keeps rendering the objective clocks and
					the standing state continuously with no model in it.
				</div>
			</div>

			{/* ========================================================== how she talks */}

			{/*
			 * Three stops, not a twenty-one-position slider printing two decimals. There is no run
			 * anywhere in this repo comparing 0.75 to 0.80; the prompt itself describes three bands,
			 * and the shipped default lands exactly on one of them.
			 */}
			<div className="panel panel-pad">
				<div className="section-title">
					How she talks <span className="rule" />
				</div>
				<div className="choices choices--row">
					{INTENSITY_STOPS.map(stop => {
						const on = intensityStop === stop.value
						return (
							<label key={stop.value} className={cls("choice", on && "on")}>
								<input
									type="radio"
									name="coachIntensity"
									checked={on}
									onChange={() => set("coachIntensity", stop.value)}
								/>
								<div>
									<div className="choice__title">
										{stop.label}
										{stop.value === DEFAULT_SETTINGS.coachIntensity ? (
											<span className="chip">default</span>
										) : null}
									</div>
									<div className="choice__blurb">{stop.blurb}</div>
								</div>
							</label>
						)
					})}
				</div>
				{/*
				 * The stored value need not BE a stop — the old slider could write 0.9 — and a band
				 * lighting up under a number it does not equal is exactly the kind of quiet
				 * disagreement that cost this app eight days. Say it rather than round it away.
				 */}
				{draft.coachIntensity !== intensityStop ?
					<div className="help">
						Stored as <b>{draft.coachIntensity.toFixed(2)}</b>, from the slider this replaced. It
						reads as the band above; clicking that band would write{" "}
						<b>{intensityStop.toFixed(2)}</b>.
					</div>
				:	null}
				<div className="help">
					Scales the jokes and nothing else. It never changes a number, a timestamp, a severity or
					a fix — that is a property of the prompt, not a promise made here.
				</div>
			</div>

			{/* ============================================================== advanced */}

			{/*
			 * ONE disclosure, closed by default, and everything inside it keeps its evidence. These
			 * are real knobs with real defaults that were measured; the audit's finding was that none
			 * of them is a decision to hand a person on the way in.
			 */}
			<details className="advanced">
				<summary>
					<b>Advanced</b>
					<span>
						models, the coach's architecture, replay storage and diagnostics — all on measured
						defaults
					</span>
				</summary>

				<div className="settings-grid">
					{/* ------------------------------------------------ the architecture */}
					<div className="panel panel-pad">
						<div className="section-title">
							How she decides what to say <span className="rule" />
						</div>
						<div className="choices">
							{LIVE_COACH_MODES.map(m => {
								const on = draft.liveCoachMode === m.id
								return (
									<label key={m.id} className={cls("choice", on && "on")}>
										<input
											type="radio"
											name="liveCoachMode"
											checked={on}
											onChange={() => set("liveCoachMode", m.id)}
										/>
										<div>
											<div className="choice__title">
												{m.label}
												{m.id === DEFAULT_SETTINGS.liveCoachMode ? (
													<span className="chip">default</span>
												) : null}
											</div>
											<div className="choice__blurb">{m.blurb}</div>
											<div className="choice__evidence">
												<b>{m.measured ? "Measured:" : "Unmeasured:"}</b> {m.evidence}
											</div>
										</div>
									</label>
								)
							})}
						</div>
						<div className="help">
							All three were run on the same model against the same 363 recorded samples from four
							of your own games, judged with the labels stripped. None of them lets her say a
							number that is not in the block. Takes effect at the start of the next game: one
							socket is opened per game and the instructions go in when it opens.
						</div>
					</div>

					{/* -------------------------------------------------------- the models */}
					<div className="panel panel-pad">
						<div className="section-title">
							Models <span className="rule" />
						</div>

						<div className="field wide">
							<div className="label">Live coach</div>
							<div className="control" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
								<select
									value={draft.liveProvider}
									onChange={e => set("liveProvider", e.currentTarget.value)}
								>
									<option value="gemini-live">
										Gemini Live — speaks itself, ~1s, interruptible (default)
									</option>
									{/*
									 * NOT disabled when a key is missing: the key box only appears once a
									 * provider is selected, so disabling the keyless ones made them
									 * unreachable — you could not select the thing you needed to select in
									 * order to give it a key.
									 */}
									{providers.data?.providers.map(p => (
										<option key={p.id} value={p.id}>
											{p.label}
											{p.available ? "" : " — needs a key"}
										</option>
									))}
								</select>
								{/*
								 * THE MODEL BOX IS SHOWN FOR THE SOCKET TOO, and that is the fix.
								 *
								 * It used to be hidden whenever `gemini-live` was selected, because
								 * the socket's id was a constant in `review/gemini-live.ts`. So the
								 * default provider — the one every real game has ever run on — was
								 * the only one whose model he could not change, and the app shipped
								 * a single socket model for its entire life without anyone choosing
								 * it. Blank still means the measured default.
								 */}
								<input
									type="text"
									list={draft.liveProvider === "gemini-live" ? "socket-models" : undefined}
									placeholder={
										draft.liveProvider === "gemini-live" ?
											(providers.data?.socketModels?.[0]?.id ?? "models/…")
										:	(providers.data?.providers.find(p => p.id === draft.liveProvider)
												?.defaultModel ?? "model id")
									}
									value={draft.liveModel}
									onChange={e => set("liveModel", e.currentTarget.value)}
									style={{ minWidth: 260 }}
								/>
								<datalist id="socket-models">
									{providers.data?.socketModels?.map(m => (
										<option key={m.id} value={m.id}>
											{m.note}
										</option>
									))}
								</datalist>
							</div>
							<div className="help">
								{draft.liveProvider === "gemini-live" ?
									"A held-open socket: it speaks in its own voice, answers in about a second, and can be cut off mid-sentence. gemini-3.8-live is the default since 18 Sep: raced against the old one over 60 turns of two of your own games it was 77% useful against 57%, and — the part that needs no judge — it produced actual AUDIO on 60 of 60 turns where the old one was silent on 34 of them."
								:	<>
										An HTTPS turn spoken by your system voice — slower (a few seconds), it cannot
										be usefully interrupted because the sentence is already paid for, and it does
										not sound like her.{" "}
										{providers.data?.providers.find(p => p.id === draft.liveProvider)?.note}
									</>
								}
							</div>
							<div className="help">
								Model id is free text on purpose — ids change faster than this app does, and a
								stale dropdown is a bug that looks like a limitation. Blank uses the provider's
								default. Pick one that accepts images, and a fast one: a reasoning model took
								fifteen seconds to answer, which is useless in a fight.
							</div>
							<div className="help">
								Measured 18 Sep over the same 60 turns, one blind judge across all seven arms:
								claude-opus-5 84% useful [73-91] at 3.7s to the first word, claude-sonnet-5 78%
								[66-87] at 1.75s, gemini-3.8-live 77% [65-86] at 1.8s. Those three are not
								separable from each other — the ceiling is flat, so choose on shape and speed,
								not on hope. Below them: the old socket 57%, claude-fable-5-1 56% at 11s,
								claude-haiku-4-5 44%.
							</div>
						</div>

						{draft.liveProvider !== "gemini-live" && (
							<div className="field wide">
								<div className="label">
									Key for {providers.data?.providers.find(p => p.id === draft.liveProvider)?.label}
								</div>
								<div className="control" style={{ display: "flex", gap: 8 }}>
									<input
										type="password"
										autoComplete="off"
										placeholder="paste a key — it is written to a 0600 file and never read back"
										value={providerKeyDraft}
										onChange={e => setProviderKeyDraft(e.currentTarget.value)}
										style={{ flex: 1 }}
									/>
									<button
										className="btn"
										onClick={() => {
											void fetch(`/api/live/coach/key/${draft.liveProvider}`, {
												method: "PUT",
												headers: { "content-type": "application/json" },
												body: JSON.stringify({ key: providerKeyDraft })
											}).then(() => {
												setProviderKeyDraft("")
												providers.reload()
											})
										}}
									>
										Save
									</button>
								</div>
								<div className="help">
									Stored on this machine only, like the Gemini key — the daemon holds it and the
									browser never sees it. An empty save clears it.
								</div>
							</div>
						)}

						<div className="field">
							<div className="label">Post-game review</div>
							<div className="control">
								<select
									value={knownModel ? draft.model : "__custom"}
									onChange={e =>
										set("model", e.target.value === "__custom" ? draft.model : e.target.value)
									}
								>
									{MODEL_CHOICES.map(m => (
										<option key={m.id} value={m.id}>
											{m.label}
										</option>
									))}
									<option value="__custom">Custom…</option>
								</select>
							</div>
							{!knownModel ?
								<div className="control" style={{ gridColumn: "1 / -1", justifySelf: "stretch" }}>
									<input
										type="text"
										value={draft.model}
										onChange={e => set("model", e.target.value)}
										style={{ width: "100%" }}
									/>
								</div>
							:	null}
							<div className="help">
								Runs through the Claude Agent SDK on your existing{" "}
								<code className="mono">claude</code> CLI login — there is no API key on this
								machine, so nothing is billed separately. This is the tier a human graded at 68%
								useful, blinded.
							</div>
						</div>

						<div className="field">
							<div className="label">Games behind a baseline</div>
							<div className="control">
								<input
									type="number"
									min={3}
									max={200}
									value={draft.gamesForTrends}
									onChange={e => set("gamesForTrends", Number(e.target.value))}
								/>
							</div>
							<div className="help">
								How many recent games "your own average" is computed over, and the default window
								for the cross-game review. The Trends screen has its own picker for what it
								DISPLAYS; this is the corpus everything else compares you against. Fewer than
								about 10 and most series honestly report themselves as noise.
							</div>
						</div>
					</div>

					{/* ------------------------------------------------------ replays */}
					<div className="panel panel-pad">
						<div className="section-title">
							Replays <span className="rule" />
						</div>

						<div className="field">
							<div className="label">Keep replays for</div>
							<div className="control">
								<input
									type="number"
									min={0}
									max={365}
									value={draft.retentionDays}
									onChange={e => set("retentionDays", Number(e.target.value))}
								/>
							</div>
							<div className="help">
								Days. <code className="mono">.rofl</code> files are about 15 MB each and dominate
								disk use; 0 means never prune. Reviews, metrics and moments are kept forever
								regardless, and files the League client put in your own Replays folder are never
								touched.
							</div>
						</div>

						<div className="field">
							<div className="label">Replay folder</div>
							<div className="control">
								<input
									type="text"
									spellCheck={false}
									placeholder="/mnt/c/Users/<you>/Documents/League of Legends/Replays"
									value={draft.replayFolder}
									onChange={e => set("replayFolder", e.target.value)}
									style={{ width: "100%", fontFamily: "var(--mono)", fontSize: "var(--fs-2)" }}
								/>
							</div>
							<div className="help">
								Where to look for <code className="mono">.rofl</code> files on the{" "}
								<a href="#/replays">Replays</a> screen. Blank uses the client's default. Point it
								at an archive to coach games that have fallen out of match history — those reviews
								get end-of-game stats but no timeline, so no moments and no map positions.
							</div>
						</div>
					</div>

					{/* -------------------------------------------------- diagnostics */}
					<div className="panel panel-pad">
						<div className="section-title">
							Diagnostics <span className="rule" />
						</div>
						{health ?
							<dl className="kv">
								<dt>status</dt>
								<dd className={cls(health.daemon === "ok" ? "band-good" : "band-bad")}>
									{health.daemon}
								</dd>
								<dt>version</dt>
								<dd>{health.version}</dd>
								<dt>league client</dt>
								<dd className={cls(health.lcu === "connected" ? "band-good" : "band-bad")}>
									{health.lcu}
									{health.gameflowPhase ? ` · ${phaseWord(health.gameflowPhase)}` : ""}
								</dd>
								{/*
								 * WHICH TRANSPORT WON, reported rather than chosen. The picker that used to
								 * sit on the first screen is gone: the daemon falls back from the bridge to
								 * curl on its own, and there was nothing for a person to decide that the code
								 * did not already decide better and then tell you about here.
								 */}
								<dt>transport in use</dt>
								<dd>{health.bridge}</dd>
								<dt>queue depth</dt>
								<dd>{health.queueDepth}</dd>
								{typeof health.gameCount === "number" ?
									<>
										<dt>games stored</dt>
										<dd>{health.gameCount}</dd>
									</>
								:	null}
								{health.dbPath ?
									<>
										<dt>database</dt>
										<dd>{health.dbPath}</dd>
									</>
								:	null}
								{typeof health.analysisVersion === "number" ?
									<>
										<dt>versions</dt>
										<dd>
											analysis v{health.analysisVersion} · review v{health.reviewVersion ?? "?"}
										</dd>
									</>
								:	null}
								{health.lastSyncMs !== undefined && health.lastSyncMs !== null ?
									<>
										<dt>last sync</dt>
										<dd>{fmtAgo(health.lastSyncMs, now)}</dd>
									</>
								:	null}
							</dl>
						:	<Broken title="The daemon isn't answering, so its status is unknown." />}

						<div className="faint" style={{ fontSize: "var(--fs-1)", marginTop: "var(--sp-3)" }}>
							Logs: <code className="mono">journalctl --user -u eepalytics -f</code> · doctor:{" "}
							<code className="mono">pnpm doctor</code>
						</div>
					</div>
				</div>

				{/*
				 * The five fields with no control, named where someone looking for them will look.
				 * Saying "this is not a setting, and here is why" is the point of the audit; leaving
				 * them unmentioned would just be a smaller screen with the same ambiguity.
				 */}
				<div className="panel panel-pad">
					<div className="section-title">
						Not settings <span className="rule" />
					</div>
					<ul className="nonsettings">
						<li>
							<b>Reviewing each game</b> is always on. Its other position switched the only
							human-graded tier of this product off for eight days while the checkbox looked
							untouched. A control whose second value silently breaks the product is not a choice.
						</li>
						<li>
							<b>The League transport</b> picks itself — the bridge, falling back to curl — and
							which one carried the last request is printed above.
						</li>
						<li>
							<b>Poll intervals</b> are milliseconds between client reads. Nothing downstream of
							them is a coaching decision.
						</li>
						<li>
							<b>Moments per game</b> is capped at {DEFAULT_SETTINGS.maxMomentsPerGame}, which is
							the number the review prompt is written against. Raising it does not buy more
							coaching, it buys more rows.
						</li>
					</ul>
					<div className="help">
						If a stored value has one of these off its default, the banner at the top of this page
						names it and puts it back in one click.
					</div>
				</div>
			</details>

			<div className="save-bar">
				<span className={cls(dirty ? "band-ok" : "faint")} style={{ fontSize: "var(--fs-2)" }}>
					{dirty ?
						`${Object.keys(changed).length} unsaved change${Object.keys(changed).length === 1 ? "" : "s"}`
					: save.done ?
						"Saved."
					:	"No changes."}
				</span>
				{save.error ?
					<span className="band-bad" style={{ fontSize: "var(--fs-2)" }}>
						{save.error}
					</span>
				:	null}
				<span className="spacer" />
				<button onClick={() => loaded.data && setDraft(loaded.data)} disabled={!dirty}>
					Discard
				</button>
				<button className="btn-primary" onClick={save.run} disabled={!dirty || save.pending}>
					{save.pending ? "Saving…" : "Save"}
				</button>
			</div>
		</div>
	)
}
