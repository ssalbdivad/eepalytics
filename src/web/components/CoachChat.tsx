/**
 * CoachChat — ask the coach about this game and get an answer with its receipts.
 *
 * The review is a monologue; this is the follow-up. Two things make it more than a text box:
 *
 *  - **Answers carry citations.** The server drops any moment or metric id the coach invented,
 *    so what arrives here is guaranteed to exist in the digest. Cited moments render as
 *    clickable chips and their map images appear inline — the same evidence rule the feedback
 *    cards follow, because an uncited claim about a game should never look like a sourced one.
 *  - **Asking seeks the page.** Clicking a cited moment moves the minimap, the scrubber and the
 *    media panel, so a question about 14:20 leaves you looking at 14:20.
 *
 * The request genuinely waits on Claude (30-90 s is normal), so the pending turn is rendered
 * optimistically with a cancel affordance rather than hidden behind a spinner.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { ChatMessage, Media, Metric, Moment } from "../../shared/schema/domain.ts"
import { API } from "../../shared/schema/api.ts"
import { api, errorMessage } from "../lib/api.ts"
import { fmtClock } from "../../shared/time.ts"
import { MOMENT_KIND_LABEL, momentColor } from "./MiniMap.tsx"
import "./components.css"

export interface CoachChatProps {
	gameId: number
	moments: Moment[]
	metrics: Metric[]
	media: Media[]
	/** Move the whole page to a timestamp. */
	onSeek: (tSec: number) => void
	onSelectMoment: (momentId: string) => void
	/** Model to ask. Defaults to the daemon's configured model when omitted. */
	model?: string
}

/** Questions worth one click, phrased the way he would actually ask them. */
const SUGGESTIONS = [
	"What was my single biggest mistake?",
	"Was my early pathing wrong, or just the ganks?",
	"Show me every death and what they had in common.",
	"What should I do differently in the first 10 minutes?"
]

const Citations = ({
	message,
	moments,
	metrics,
	media,
	onPick
}: {
	message: ChatMessage
	moments: Moment[]
	metrics: Metric[]
	media: Media[]
	onPick: (m: Moment) => void
}) => {
	const cited = message.citedMomentIds
		.map(id => moments.find(m => m.id === id))
		.filter((m): m is Moment => m !== undefined)
	const citedMetrics = message.citedMetricKeys
		.map(k => metrics.find(m => m.key === k))
		.filter((m): m is Metric => m !== undefined)
	const pictures = media.filter(m => m.momentId !== null && message.citedMomentIds.includes(m.momentId))

	if (cited.length === 0 && citedMetrics.length === 0) return null

	return (
		<div className="csk-chat-cites">
			{cited.map(m => (
				<button key={m.id} className="csk-chat-chip" onClick={() => onPick(m)}>
					<span className="dot" style={{ background: momentColor(m.kind) }} />
					<span className="t">{fmtClock(m.tSec)}</span>
					<span className="k">{MOMENT_KIND_LABEL[m.kind] ?? m.kind}</span>
				</button>
			))}
			{citedMetrics.map(m => (
				<span key={m.key} className={`csk-chat-metric band-${m.band}`} title={m.explain}>
					{m.label}: <strong>{m.value}{m.unit}</strong>
				</span>
			))}
			{pictures.length > 0 && (
				<div className="csk-chat-shots">
					{pictures.slice(0, 4).map(p => (
						<button
							key={p.id}
							className="csk-chat-shot"
							onClick={() => onPick(cited.find(c => c.id === p.momentId) ?? cited[0]!)}
							title={`${fmtClock(p.tSec)} — ${p.source === "replay" ? "captured from your replay" : "drawn from your position data"}`}
						>
							<img src={API.media(p.id)} alt={`Map at ${fmtClock(p.tSec)}`} loading="lazy" />
							<span className="csk-chat-shot-tag">
								{p.source === "replay" ? "replay" : "drawn"} · {fmtClock(p.tSec)}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

export const CoachChat = ({
	gameId,
	moments,
	metrics,
	media,
	onSeek,
	onSelectMoment,
	model
}: CoachChatProps) => {
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [draft, setDraft] = useState("")
	const [pending, setPending] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [liveMedia, setLiveMedia] = useState<Media[]>([])
	const abortRef = useRef<AbortController | null>(null)
	const endRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const ac = new AbortController()
		setMessages([])
		setError(null)
		void api
			.chatHistory(gameId, ac.signal)
			.then(r => setMessages(r.messages))
			.catch(e => {
				if (!ac.signal.aborted) setError(errorMessage(e))
			})
		return () => ac.abort()
	}, [gameId])

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
	}, [messages.length, pending])

	const pick = useCallback(
		(m: Moment) => {
			onSelectMoment(m.id)
			onSeek(m.tSec)
		},
		[onSeek, onSelectMoment]
	)

	const ask = useCallback(
		async (question: string) => {
			const q = question.trim()
			if (q === "" || pending !== null) return
			setDraft("")
			setPending(q)
			setError(null)
			const ac = new AbortController()
			abortRef.current = ac
			try {
				const turn = await api.askCoach(gameId, q, model, ac.signal)
				setMessages(prev => [...prev, turn.user, turn.coach])
				setLiveMedia(prev => [...prev, ...turn.media])
			} catch (e) {
				if (!ac.signal.aborted) setError(errorMessage(e))
			} finally {
				abortRef.current = null
				setPending(null)
			}
		},
		[gameId, model, pending]
	)

	const clear = useCallback(async () => {
		try {
			await api.clearChat(gameId)
			setMessages([])
			setLiveMedia([])
			setError(null)
		} catch (e) {
			setError(errorMessage(e))
		}
	}, [gameId])

	const allMedia = [...media, ...liveMedia]

	return (
		<div className="csk-chat">
			<div className="csk-chat-log">
				{messages.length === 0 && pending === null && (
					<div className="csk-chat-empty">
						<p>
							Ask about this game. The coach can only see what the digest measured — no items,
							no wards, no skill order — and it will tell you when the answer isn't in the data
							rather than guessing.
						</p>
						<div className="csk-chat-suggest">
							{SUGGESTIONS.map(s => (
								<button key={s} onClick={() => void ask(s)}>
									{s}
								</button>
							))}
						</div>
					</div>
				)}

				{messages.map(m => (
					<div key={m.id} className={`csk-chat-turn csk-chat-turn--${m.role}`}>
						<div className={`csk-chat-bubble ${m.status === "failed" ? "failed" : ""}`}>
							{m.content}
							{m.status === "failed" && m.error !== null && (
								<div className="csk-chat-err">{m.error}</div>
							)}
						</div>
						{m.role === "coach" && m.status === "ok" && (
							<Citations
								message={m}
								moments={moments}
								metrics={metrics}
								media={allMedia}
								onPick={pick}
							/>
						)}
					</div>
				))}

				{pending !== null && (
					<>
						<div className="csk-chat-turn csk-chat-turn--user">
							<div className="csk-chat-bubble">{pending}</div>
						</div>
						<div className="csk-chat-turn csk-chat-turn--coach">
							<div className="csk-chat-bubble csk-chat-thinking">
								Coach is watching the replay back
								<span className="csk-dots">
									<i />
									<i />
									<i />
								</span>
								<button className="csk-chat-cancel" onClick={() => abortRef.current?.abort()}>
									cancel
								</button>
							</div>
						</div>
					</>
				)}
				<div ref={endRef} />
			</div>

			{error !== null && <div className="csk-chat-error">{error}</div>}

			<form
				className="csk-chat-input"
				onSubmit={e => {
					e.preventDefault()
					void ask(draft)
				}}
			>
				<textarea
					value={draft}
					onChange={e => setDraft(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							void ask(draft)
						}
					}}
					placeholder={pending !== null ? "waiting for the coach…" : "Ask about this game…"}
					rows={2}
					disabled={pending !== null}
				/>
				<div className="csk-chat-actions">
					<button type="submit" disabled={pending !== null || draft.trim() === ""}>
						Ask
					</button>
					{messages.length > 0 && (
						<button type="button" className="ghost" onClick={() => void clear()}>
							Clear
						</button>
					)}
				</div>
			</form>
		</div>
	)
}
