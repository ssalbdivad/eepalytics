/**
 * The shell: a status bar that never lies about what the daemon is doing, a hash router,
 * and an error boundary so one bad render cannot take the whole tool down mid-game.
 */

import { Component, useCallback, useMemo, useState } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { api } from "./lib/api.ts"
import { href, useNow, useResource, useRoute, useScrollReset } from "./lib/hooks.ts"
import { reconnectSse, sseLastEventId, useSse } from "./lib/sse.ts"
import type { SseStatus } from "./lib/sse.ts"
import { cls } from "./lib/format.ts"
import { GameList } from "./pages/GameList.tsx"
import { GameReview } from "./pages/GameReview.tsx"
import { Trends } from "./pages/Trends.tsx"
import { Queue } from "./pages/Queue.tsx"
import { SettingsPage } from "./pages/Settings.tsx"

/* ======================================================= error boundary */

interface BoundaryProps {
	children: ReactNode
	resetKey: string
}
interface BoundaryState {
	error: Error | null
}

class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { error: null }

	static getDerivedStateFromError(error: Error): BoundaryState {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("coachskaffur: render failed", error, info.componentStack)
	}

	componentDidUpdate(prev: BoundaryProps): void {
		if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
	}

	render(): ReactNode {
		const { error } = this.state
		if (!error) return this.props.children
		return (
			<div className="page">
				<div className="notice bad">
					<span className="icon">✗</span>
					<div>
						<strong>This screen crashed.</strong> That is a bug in coachskaffur, not in your
						data — nothing was lost.
						<pre>{error.stack ?? error.message}</pre>
						<div style={{ marginTop: 10, display: "flex", gap: 8 }}>
							<button onClick={() => this.setState({ error: null })}>Try again</button>
							<a className="btn" href={href.games}>
								Back to games
							</a>
						</div>
					</div>
				</div>
			</div>
		)
	}
}

/* =============================================================== status */

const SSE_LABEL: Record<SseStatus, string> = {
	open: "live",
	connecting: "connecting…",
	reconnecting: "reconnecting…",
	closed: "offline"
}

const daemonTone = (daemon: string): string =>
	daemon === "ok" ? "ok"
	: daemon === "starting" ? "warn"
	: daemon === "degraded" ? "warn"
	: "bad"

/* ================================================================== app */

export const App = () => {
	const route = useRoute()
	const [eventTick, setEventTick] = useState(0)

	const onSseMessage = useCallback(() => setEventTick(t => t + 1), [])
	const sseStatus = useSse(onSseMessage)

	// A slow heartbeat so the header stays honest even if the event stream is wedged.
	const heartbeat = Math.floor(useNow(20_000) / 20_000)
	const health = useResource(signal => api.health(signal), [heartbeat, eventTick])

	const routeKey = useMemo(
		() => (route.name === "game" ? `game:${route.gameId}` : route.name),
		[route]
	)
	useScrollReset(routeKey)

	const h = health.data
	const offline = health.error !== null && h === null

	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					coachskaffur <small>Gooskaffur#NA1</small>
				</div>

				<nav className="nav">
					<a className={cls(route.name === "games" && "active")} href={href.games}>
						Games
					</a>
					<a className={cls(route.name === "trends" && "active")} href={href.trends}>
						Trends
					</a>
					<a className={cls(route.name === "queue" && "active")} href={href.queue}>
						Queue
						{h && h.queueDepth > 0 ?
							<span className="count">{h.queueDepth}</span>
						:	null}
					</a>
					<a className={cls(route.name === "settings" && "active")} href={href.settings}>
						Settings
					</a>
				</nav>

				<div className="topbar-right">
					{offline ?
						<span className="status-pill bad" title={health.errorDetail ?? undefined}>
							<span className="dot" /> daemon unreachable
						</span>
					:	<>
							<span
								className={cls("status-pill", h ? daemonTone(h.daemon) : "warn")}
								title={
									h?.warnings && h.warnings.length > 0 ?
										h.warnings.join("\n")
									:	`daemon ${h?.daemon ?? "?"}`
								}
							>
								<span className="dot" /> daemon {h?.daemon ?? "…"}
								{h?.warnings && h.warnings.length > 0 ? ` · ${h.warnings.length}⚠` : ""}
							</span>
							<span
								className={cls("status-pill", h?.lcu === "connected" ? "ok" : "warn")}
								title={
									h?.lcu === "connected" ?
										`League client connected via ${h.bridge}`
									:	"League client is closed — finished games can't be ingested right now"
								}
							>
								<span className="dot" /> LCU {h?.lcu ?? "…"}
								{h?.gameflowPhase ? ` · ${h.gameflowPhase}` : ""}
							</span>
						</>
					}
					<button
						className={cls("status-pill", sseStatus === "open" ? "ok live" : "warn")}
						title={`Event stream from the daemon — last event #${sseLastEventId()}. Click to reconnect now.`}
						onClick={reconnectSse}
					>
						<span className="dot" /> {SSE_LABEL[sseStatus]}
					</button>
				</div>
			</header>

			<ErrorBoundary resetKey={routeKey}>
				{route.name === "games" ?
					<GameList health={h} eventTick={eventTick} />
				: route.name === "game" ?
					<GameReview gameId={route.gameId} eventTick={eventTick} />
				: route.name === "trends" ?
					<Trends eventTick={eventTick} />
				: route.name === "queue" ?
					<Queue health={h} eventTick={eventTick} />
				: route.name === "settings" ?
					<SettingsPage health={h} onSaved={() => setEventTick(t => t + 1)} />
				:	<div className="page">
						<div className="empty">
							<h2>No such screen</h2>
							<p>
								<code className="mono">#/{route.path}</code> isn't a route in this build.
							</p>
							<div className="actions">
								<a className="btn btn-primary" href={href.games}>
									Go to games
								</a>
							</div>
						</div>
					</div>
				}
			</ErrorBoundary>
		</div>
	)
}
