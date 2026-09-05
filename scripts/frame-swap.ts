/*
 * Frame-swap control for the e2e ablation.
 *
 * The with/without-frame ablation can only say whether the picture CHANGED the answer. It cannot
 * separate "the model read the picture and the picture had nothing to add" from "the model never
 * looked". This does: same system prompt, same block, same model — only the IMAGE BYTES differ,
 * and one of the images is from a completely different moment of the same game, chosen so that it
 * flatly contradicts the block it arrives with (a greyscale death screen paired with a block that
 * says he is alive at full health).
 *
 * If the correct-frame answer and the wrong-frame answer are the same sentence, the picture is
 * inert and the ablation's "no difference" is not evidence that the picture was empty.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { coachTurn } from "../src/review/live-providers.ts"

const fx = JSON.parse(readFileSync("data/eval/fixture-5635467422.json", "utf8"))
const cps = new Map<string, any>(fx.checkpoints.map((c: any) => [c.id, c]))
const b64 = (p: string) => readFileSync(p).toString("base64")

// The two decoys. cp-0378 is the greyscale death screen with the shop open ("BACK IN 12"); it is
// the most contradictable picture in the fixture. cp-0022 is the fountain at 22 seconds.
const DECOY_DEAD = cps.get("cp-0378").framePath as string
const DECOY_FOUNTAIN = cps.get("cp-0022").framePath as string

// Every frame-bearing checkpoint whose label carries visual evidence, plus the two the block
// speaks on, so the swap is tested where a line actually comes out.
const labels = JSON.parse(readFileSync("data/eval/labels-5635467422.json", "utf8")).labels
const visual = new Set<string>(
	labels.filter((l: any) => l.visualEvidence).map((l: any) => String(l.id))
)
const ids = fx.checkpoints
	.filter((c: any) => c.framePath && (visual.has(c.id) || c.block.includes("What he is NOT looking at")))
	.map((c: any) => c.id as string)

const rows: any[] = []
for (const id of ids) {
	const c = cps.get(id)
	const decoy = c.framePath === DECOY_DEAD ? DECOY_FOUNTAIN : DECOY_DEAD
	for (const [arm, path] of [
		["real", c.framePath],
		["decoy", decoy],
		["none", null]
	] as const) {
		const r = await coachTurn({
			provider: "gemini-http",
			blockText: c.block,
			...(path ? { frameJpegBase64: b64(path) } : {})
		})
		rows.push({ id, clock: c.clock, arm, decoy: path === decoy ? decoy : null, ok: r.ok, text: r.text, reason: r.reason })
		console.log(`${id} ${c.clock} ${arm.padEnd(5)} ${r.ok ? JSON.stringify(r.text) : "ERR " + r.reason}`)
	}
}
writeFileSync("data/eval/frame-swap-5635467422.json", JSON.stringify({ rows }, null, "\t") + "\n")
console.log(`\n${ids.length} checkpoints x 3 arms -> data/eval/frame-swap-5635467422.json`)
