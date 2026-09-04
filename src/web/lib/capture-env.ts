/**
 * Can THIS window capture the screen the game is on?
 *
 * The live coach is a screenshot stream, so this one question decides whether the app's flagship
 * feature works where it is running — and getting it wrong is worse than either answer. Telling
 * someone the window cannot see their game when it can sends them to a browser for nothing.
 * Telling them it can when it cannot hands them a picker full of screens the game is not on, and
 * a coach that talks confidently about a desktop.
 *
 * ## What actually decides it
 *
 * A renderer can only ever see the compositor its own process is in. The League client is a
 * Windows process, so a renderer that is not on that desktop cannot see it, no matter what
 * permissions it is granted:
 *
 *   - **Electron under WSLg** (how this app is developed) runs on a Linux compositor holding
 *     three WSLg virtual screens and exactly one window — its own. Enumerated live, League is
 *     not among them. This is a boundary, not a permission.
 *   - **Electron on native Windows** is a Windows process on the Windows desktop, and
 *     `desktopCapturer` sees the game like any other capture tool. Here the WSL advice is simply
 *     false, and the banner that gives it is the bug.
 *   - **A browser on Windows** — the escape hatch offered from WSL — is also a Windows process,
 *     and `localhost` is a secure context, so `getDisplayMedia` is allowed.
 *
 * ## Where the platform comes from
 *
 * The shell tells us: `electron/preload.cjs` puts its own `process.platform` on
 * `window.eepalytics`. That is the process that owns the window, which is precisely the thing
 * the question is about — unlike the user-agent string, which is a guess about a guess. The UA
 * sniff survives only as a fallback for a shell too old to expose it, or one whose preload
 * failed to load; it is never consulted when the bridge is there.
 *
 * Pure and free of React so it can be tested directly; `readCaptureEnv` below is the only part
 * that touches globals.
 */

/** Which desktop this window's process is on. `null` when nothing said. */
export type ShellPlatform = "linux" | "win32" | "darwin" | "unknown" | null

export interface CaptureProbe {
	/** `process.platform` of the shell hosting this window; `null` in a plain browser tab. */
	shellPlatform: ShellPlatform
	/** `navigator.userAgent`. Only consulted when `shellPlatform` is null. */
	userAgent: string
	/** Does `navigator.mediaDevices.getDisplayMedia` exist at all? */
	hasDisplayMedia: boolean
}

export type CaptureBlocked =
	/** The window is on a Linux desktop; the League client is not. */
	| "wrong-desktop"
	/** No `getDisplayMedia` here — an insecure origin, or a browser too old. */
	| "no-display-media"

export interface CaptureEnv {
	/** True when sharing from this window can actually show the game. */
	can: boolean
	/** Why not, or `null` when it can. */
	blocked: CaptureBlocked | null
	/**
	 * Whether to offer the hand-off to a Windows browser instead of a screen picker.
	 *
	 * Only for the wrong-desktop case, and only ever an *offer*: `POST /api/shell/open-in-windows`
	 * answers 501 when there is no Windows shell to reach, and that message is shown rather than
	 * swallowed. An offer that quietly does nothing is the failure this replaces.
	 */
	offerWindowsBrowser: boolean
}

/** What the UA string says about the platform, when that is all there is. */
const platformFromUserAgent = (ua: string): ShellPlatform => {
	if (/Windows/i.test(ua)) return "win32"
	if (/Mac OS X/i.test(ua)) return "darwin"
	// Android also carries "Linux"; it is not a platform this app runs on, and treating it as
	// Linux only costs an offer to open a Windows browser that it will decline honestly.
	if (/Linux|X11/i.test(ua)) return "linux"
	return "unknown"
}

export const captureEnv = (probe: CaptureProbe): CaptureEnv => {
	const platform = probe.shellPlatform ?? platformFromUserAgent(probe.userAgent)

	// Ignorance is not evidence of failure: an unrecognised platform is allowed to try, and the
	// picker itself will say no if it must.
	if (platform === "linux")
		return { can: false, blocked: "wrong-desktop", offerWindowsBrowser: true }

	if (!probe.hasDisplayMedia)
		return { can: false, blocked: "no-display-media", offerWindowsBrowser: false }

	return { can: true, blocked: null, offerWindowsBrowser: false }
}

/** What the Electron preload exposes. Absent in a browser, and absent if the preload failed. */
interface ShellBridge {
	platform?: unknown
}

const shellPlatform = (): ShellPlatform => {
	if (typeof window === "undefined") return null
	const bridge = (window as { eepalytics?: ShellBridge }).eepalytics
	const platform = bridge?.platform
	if (typeof platform !== "string") return null
	return platform === "linux" || platform === "win32" || platform === "darwin" ?
			platform
		:	"unknown"
}

/** The live reading, for the component. */
export const readCaptureEnv = (): CaptureEnv => {
	if (typeof navigator === "undefined")
		return { can: false, blocked: "no-display-media", offerWindowsBrowser: false }
	return captureEnv({
		shellPlatform: shellPlatform(),
		userAgent: navigator.userAgent,
		hasDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === "function"
	})
}
