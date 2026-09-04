/**
 * Which transport to try, in what order, and what would count as proof.
 *
 * Kept separate from `createLcu` and free of I/O so the policy can be tested for every host
 * shape — including the two nobody here can reproduce (native Windows, WSL with mirrored
 * networking). The rule the whole file exists to enforce:
 *
 * > **Never demote the transport that is known to work on the strength of a platform string.**
 *
 * ## The three environments
 *
 * - **WSL (this machine).** `bridge` → `curl` → `direct`. Unchanged from before `direct`
 *   existed: WSL2's default NAT networking cannot reach Windows' `127.0.0.1`, measured twice.
 *   `direct` sits at the *back* and is only taken when a request has actually answered,
 *   because WSL2 in *mirrored* networking mode genuinely can reach the loopback and there is no
 *   way to tell the two modes apart short of trying. Under NAT the probe is refused, direct is
 *   skipped, and the order is exactly what it always was.
 * - **Native Windows.** `direct` only. `bridge` and `curl` are not slower there, they are
 *   *impossible*: both translate paths with `wslpath` and reach for `/mnt/c/...`, neither of
 *   which exists. Offering them as a fallback would only turn a clear failure into a confusing
 *   one.
 * - **Anything else (a Linux or mac box with no client).** `direct` only, for the same reason,
 *   and it will sit `degraded` because there is no lockfile to find. That is the honest state.
 *
 * ## Why an explicit setting does not override feasibility
 * `settings.transport` defaults to `"bridge"` for every existing install, so on a fresh native
 * Windows machine the *default* would name a transport that cannot run. A preference reorders
 * the candidates; it cannot conjure `/mnt/c`. When the preference is impossible we say so in
 * the log rather than failing to start.
 */

import type { EnvironmentFacts } from "./environment.ts"
import type { TransportKind } from "./transport.ts"

export interface TransportChoice {
	kind: TransportKind
	/**
	 * Start this one only if a real request has proved the loopback answers.
	 *
	 * Only ever set for `direct` in WSL, where "the socket refused us" and "the client is
	 * closed" look identical from the outside and a wrong guess means a daemon that silently
	 * sees no games.
	 */
	requireProof: boolean
	why: string
}

/** The candidates, best first. Never empty — `direct` is always possible to *attempt*. */
export const planTransports = (
	preferred: TransportKind | undefined,
	facts: EnvironmentFacts
): TransportChoice[] => {
	if (!facts.interopPossible) {
		const why =
			facts.kind === "windows" ?
				"native Windows: this process's loopback is the client's, and the interop transports have no /mnt/c or wslpath to use"
			:	`${facts.kind}: no Windows interop available, so direct is the only transport that can run`
		return [{ kind: "direct", requireProof: false, why }]
	}

	const order: TransportChoice[] = [
		{
			kind: "bridge",
			requireProof: false,
			why: "WSL: a Windows-side node.exe over stdio, p50 2.3 ms, and it carries LCU events"
		},
		{
			kind: "curl",
			requireProof: false,
			why: "WSL: curl.exe per request, ~88 ms, no LCU events"
		},
		{
			kind: "direct",
			// The one case where trying is not free: under NAT this probe is refused in
			// microseconds, but choosing direct on a hunch would strand the daemon.
			requireProof: preferred !== "direct",
			why:
				preferred === "direct" ?
					"WSL: asked for explicitly — only works with mirrored networking"
				:	"WSL: last resort, and only if a live request proves the loopback answers (mirrored networking)"
		}
	]

	if (!preferred) return order
	const first = order.findIndex(c => c.kind === preferred)
	if (first <= 0) return order
	return [order[first] as TransportChoice, ...order.filter((_, i) => i !== first)]
}

/** One line for the daemon log, so a support question is answered by the log and not a guess. */
export const describePlan = (plan: readonly TransportChoice[]): string =>
	plan.map(c => (c.requireProof ? `${c.kind}(if proved)` : c.kind)).join(" → ")
