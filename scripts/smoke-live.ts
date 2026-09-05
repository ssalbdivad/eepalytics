/**
 * One command that answers "is the live coach actually working right now?"
 *
 * It exercises the SHIPPED path end to end, in the same order the browser does:
 *
 *   1. ask the daemon for an ephemeral token   (proves the key is present and valid)
 *   2. ask the daemon for the ground-truth block (proves the League client is readable)
 *   3. open the WebSocket to Google with that token
 *   4. send one turn — a frame inline, plus the block — and time the first words back
 *
 * Every one of those steps has failed at least once for a different reason: a key that was never
 * loaded because the daemon does not read `.env`, a token minted against the wrong endpoint, a
 * socket that opened and never completed setup, and frames streamed in a shape the model could
 * not use. A smoke test that only checks the last one would have missed all four.
 *
 * Usage:
 *   pnpm smoke:live [--frame path.jpg]
 *
 * Exits non-zero on failure, so it can gate anything that cares.
 */

import { readFileSync } from "node:fs"
import { DATA_DIR, SERVER_PORT } from "../src/shared/constants.ts"

const BASE = `http://127.0.0.1:${SERVER_PORT}`
const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const step = (n: number, what: string) => process.stdout.write(`${n}. ${what.padEnd(46)}`)
const ok = (detail: string) => console.log(`ok    ${detail}`)
/*
 * Explicitly annotated, not inferred. TypeScript only narrows control flow through a
 * `never`-returning call when the callee carries an explicit type annotation — an inferred
 * `never` on a `const` arrow does not count, so without this every `if (!x) fail(...)` below
 * fails to narrow `x` afterwards.
 */
const fail: (detail: string) => never = detail => {
	console.log(`FAIL  ${detail}`)
	process.exit(1)
}

const main = async () => {
	console.log(`\neepalytics live coach — smoke test against ${BASE}\n`)

	step(1, "daemon reachable")
	const health = await fetch(`${BASE}/api/health`).catch(() => null)
	if (health === null || !health.ok) fail("no daemon on this port — start it with `pnpm daemon`")
	ok(String(((await health.json()) as { daemon?: string }).daemon))

	step(2, "gemini key present and accepted")
	const status = (await (await fetch(`${BASE}/api/live/gemini/status`)).json()) as {
		configured: boolean
		ok: boolean
		error?: string | null
		hint?: string
	}
	if (!status.configured) fail("no key set — paste one on the Live screen")
	if (!status.ok) fail(status.error ?? "the key was rejected")
	ok(`key ${status.hint}`)

	step(3, "ephemeral token minted")
	const tok = (await (await fetch(`${BASE}/api/live/gemini/token`, { method: "POST" })).json()) as
		| { ok: true; token: string; model: string; wsUrl: string; systemPrompt?: string; champion?: string }
		| { ok: false; error: string }
	if (!tok.ok) fail(tok.error)
	/*
	 * The PROMPT rides with the token, and this walks the shipped path, so it must be the prompt
	 * the app would connect with. Falling back silently to the fenced constant here would make the
	 * one check that exercises the real socket the one check that could not see the coach mode.
	 */
	if (!tok.systemPrompt) fail("the daemon minted a token with no system prompt — it is too old")
	ok(
		`${tok.model.replace("models/", "")}, prompt ${tok.systemPrompt.length} chars${
			tok.champion ? ` for ${tok.champion}` : " (no champion locked yet)"
		}`
	)

	step(4, "ground truth from the League client")
	const truth = (await (await fetch(`${BASE}/api/live/ground-truth`)).json()) as {
		inGame: boolean
		text: string
	}
	/*
	 * Not in a game is a PASS, not a failure — most of the time this is run there will be no game
	 * running, and the socket half is what is actually being tested. The block is replaced with a
	 * stand-in so step 5 still exercises a realistic payload.
	 */
	const block =
		truth.inGame ? truth.text : (
			`## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 14:30.

You: Lillia lv11 3/2/4, 120 CS, 1450g

Your team: Darius lv12 4/3/2

Enemy team: Graves lv12 6/3/3 DEAD (22s)

### What he is NOT looking at — prefer these

- 22s without Graves — their side of the map is short one`
		)
	ok(truth.inGame ? `in a game, ${truth.text.length} chars` : "no game — using a stand-in block")

	step(5, "socket opens and answers")
	const frame = readFileSync(arg("frame", `${DATA_DIR}/eval/frame.jpg`)).toString("base64")
	const started = Date.now()
	const said = await new Promise<{ text: string; setupMs: number; replyMs: number }>(
		(resolve, reject) => {
			const ws = new WebSocket(`${tok.wsUrl}?access_token=${encodeURIComponent(tok.token)}`)
			let setupMs = 0
			let sentAt = 0
			let partial = ""
			let finished = false
			ws.onopen = () =>
				ws.send(
					JSON.stringify({
						setup: {
							model: tok.model,
							generationConfig: { responseModalities: ["AUDIO"] },
							outputAudioTranscription: {},
							systemInstruction: { parts: [{ text: tok.systemPrompt! }] }
						}
					})
				)
			ws.onmessage = async ev => {
				const m = JSON.parse(
					typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
				) as {
					setupComplete?: unknown
					serverContent?: {
						turnComplete?: boolean
						outputTranscription?: { text?: string }
						modelTurn?: { parts?: { text?: string }[] }
					}
				}
				if (m.setupComplete) {
					setupMs = Date.now() - started
					sentAt = Date.now()
					// Frame INSIDE the turn — the shape the app uses. Streaming it does not work.
					ws.send(
						JSON.stringify({
							clientContent: {
								turns: [
									{
										role: "user",
										parts: [
											{ inlineData: { mimeType: "image/jpeg", data: frame } },
											{ text: block }
										]
									}
								],
								turnComplete: true
							}
						})
					)
					return
				}
				const sc = m.serverContent
				if (!sc) return
				if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
				for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
				if (sc.turnComplete) {
					finished = true
					ws.close()
					resolve({ text: partial.trim(), setupMs, replyMs: Date.now() - sentAt })
				}
			}
			ws.onclose = e => {
				if (!finished) reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 120)}`))
			}
			setTimeout(() => {
				if (!finished) {
					ws.close()
					reject(new Error("no reply within 45s"))
				}
			}, 45_000)
		}
	).catch((e: Error) => fail(e.message))

	ok(`setup ${said.setupMs}ms · reply ${said.replyMs}ms`)
	console.log(`\n   she said: ${said.text === "" ? "(nothing)" : `"${said.text}"`}`)
	console.log(
		said.text.toUpperCase().startsWith("PASS") ?
			`   → PASS is a correct answer; it means nothing was worth interrupting for.\n`
		:	`\n`
	)
}

await main()
