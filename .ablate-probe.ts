import { readFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "/home/ssalb/eepalytics/src/review/live-providers.ts"
const p = providerById("gemini-http")!
const key = providerKey(p)!
const { generateText } = await import("ai")
for (const model of ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-latest"]) {
	try {
		const h = await modelHandleFor(p, key, model)
		const img = readFileSync("/home/ssalb/eepalytics/data/journal/js-mtn2jrku-8ae9/js-mtn2jrku-8ae9-4034.jpg").toString("base64")
		const t0 = Date.now()
		const r = await generateText({
			model: h,
			system: "Answer in one short line.",
			messages: [{ role: "user", content: [{ type: "image", image: img }, { type: "text", text: "What game clock is shown in this screenshot?" }] }],
			maxOutputTokens: 2000
		})
		console.log(model, "OK", Date.now() - t0, "ms:", JSON.stringify(r.text))
	} catch (e) {
		console.log(model, "FAIL", (e as Error).message.slice(0, 160))
	}
}
