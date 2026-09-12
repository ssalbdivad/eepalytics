/**
 * Vendor the item table the coach needs, from Riot's own static data.
 *
 * ## Why this file exists at all
 *
 * The Live Client Data API tells you an item's `itemID`, its `displayName` and its `price`, and
 * `price` is NOT what the item cost. It is the item's own cost line — `gold.base` in Data Dragon,
 * confirmed below on every item this app has ever observed — so a component consumed into a
 * legendary contributes only its combine fee and a sum of prices recovers about a quarter of the
 * truth. `scripts/audit-live-fields.ts` measured that ratio at a median 0.3 across ten players of
 * one game, and 0.27 pooled.
 *
 * So the feed cannot answer the three questions a build sentence needs: is this thing FINISHED,
 * what is he BUILDING toward, and what does the rest of it COST. Those answers are static — they
 * change on a patch, not on a game — and Riot publishes them. Never derive a fact you can be told.
 *
 * ## What it writes, and why it is a .ts file rather than JSON
 *
 * `src/shared/item-table.ts`, a generated module. `--experimental-strip-types` runs TypeScript
 * directly with no build step, and a JSON import needs an import attribute and a resolver that
 * behaves the same in Vite and in Node; a plain module needs neither and is browser-safe, which is
 * the same reason everything else in `src/shared/` is shaped this way.
 *
 * It is checked in. A coach that cannot classify an item without a network call is a coach that
 * says nothing about builds the first time the network is down.
 *
 * ## The validation, which is the point of the script rather than a nicety
 *
 * Before writing anything it joins the table against every `allgamedata` sample on disk and checks
 * that the client's `price` equals `gold.base` and the client's `displayName` equals `name`, for
 * every item ever observed. At the time of writing that is 215 distinct items and the answer is
 * 215/215 on both. That join is what licenses the rest of the file: if `price` is `gold.base`,
 * then `gold.total` is the number the feed is missing, and the arithmetic below is exact rather
 * than an estimate.
 *
 * Run:
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/fetch-items.ts
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/fetch-items.ts --patch 16.18.1
 *
 * Read-only on the database; never touches the LCU.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SAMPLES = "data/live-samples"
const OUT = "src/shared/item-table.ts"

interface DdItem {
	name: string
	gold: { base: number; total: number; purchasable: boolean }
	from?: string[]
	into?: string[]
	depth?: number
	tags?: string[]
	maps?: Record<string, boolean>
}

const arg = (flag: string): string | null => {
	const i = process.argv.indexOf(flag)
	return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const main = async (): Promise<void> => {
	const versions = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[]
	const patch = arg("--patch") ?? versions[0]!
	const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/item.json`
	const data = ((await (await fetch(url)).json()) as { data: Record<string, DdItem> }).data
	console.log(`patch ${patch}: ${Object.keys(data).length} items`)

	/* ------------------------------------------------- the join, before anything is written */

	const observed = new Map<number, { name: string; price: number }>()
	let sampleFiles = 0
	for (const f of readdirSync(SAMPLES)) {
		if (!f.endsWith(".ndjson")) continue
		sampleFiles += 1
		for (const line of readFileSync(join(SAMPLES, f), "utf8").split("\n")) {
			if (line.trim() === "") continue
			let s: { data?: { allPlayers?: { items?: { itemID?: number; displayName?: string; price?: number }[] }[] } }
			try {
				s = JSON.parse(line)
			} catch {
				continue
			}
			for (const p of s.data?.allPlayers ?? [])
				for (const i of p.items ?? [])
					if (i.itemID !== undefined)
						observed.set(i.itemID, { name: i.displayName ?? "", price: i.price ?? 0 })
		}
	}
	let priceOk = 0
	let nameOk = 0
	const misses: string[] = []
	for (const [id, seen] of observed) {
		const it = data[String(id)]
		if (!it) {
			misses.push(`${id} ${seen.name} — not in the table at all`)
			continue
		}
		if (it.gold.base === seen.price) priceOk += 1
		else misses.push(`${id} ${seen.name} — client price ${seen.price}, gold.base ${it.gold.base}`)
		if (it.name === seen.name) nameOk += 1
	}
	console.log(
		`join against ${observed.size} distinct items observed in ${sampleFiles} sample files: price===gold.base ${priceOk}, name matches ${nameOk}`
	)
	for (const m of misses.slice(0, 20)) console.log(`  MISMATCH ${m}`)
	if (misses.length > 0) {
		console.error(`refusing to write: ${misses.length} observed items do not join`)
		process.exit(1)
	}

	/* ------------------------------------------------------------------ what gets kept */

	/*
	 * Summoner's Rift only, plus anything ever observed. The full table is every map and every
	 * mode; the coach only ever sees one of them, and an item table that carries ARAM's Mejai's is
	 * a bigger file with no extra answer in it.
	 */
	const keep = new Set<number>(observed.keys())
	for (const [k, it] of Object.entries(data)) if (it.maps?.["11"] === true) keep.add(Number(k))
	// A recipe is useless with a hole in it: pull in every ancestor and descendant of anything kept.
	for (let grew = true; grew; ) {
		grew = false
		for (const id of [...keep]) {
			const it = data[String(id)]
			if (!it) continue
			for (const r of [...(it.from ?? []), ...(it.into ?? [])])
				if (!keep.has(Number(r)) && data[r]) {
					keep.add(Number(r))
					grew = true
				}
		}
	}

	const rows = [...keep]
		.filter(id => data[String(id)])
		.sort((a, b) => a - b)
		.map(id => {
			const it = data[String(id)]!
			const tags = it.tags ?? []
			return {
				id,
				name: it.name,
				base: it.gold.base,
				total: it.gold.total,
				from: (it.from ?? []).map(Number),
				into: (it.into ?? []).map(Number),
				consumable: tags.includes("Consumable"),
				trinket: tags.includes("Trinket"),
				purchasable: it.gold.purchasable
			}
		})

	const body = rows
		.map(
			r =>
				`\t[${r.id}, "${r.name.replace(/"/g, '\\"')}", ${r.base}, ${r.total}, [${r.from.join(",")}], [${r.into.join(",")}], ${r.consumable ? 1 : 0}, ${r.trinket ? 1 : 0}, ${r.purchasable ? 1 : 0}]`
		)
		.join(",\n")

	const out = `/**
 * GENERATED by \`scripts/fetch-items.ts\` from Data Dragon patch ${patch}. Do not edit by hand.
 *
 * Regenerate on a patch. The shape is a tuple per row rather than an object per row because this
 * module is shipped to the browser and the field names would otherwise be repeated ${rows.length}
 * times; \`shared/items.ts\` is the only thing that reads it and it names them once.
 *
 * Row: [id, name, base, total, from, into, consumable, trinket, purchasable]
 *
 * - \`base\` is the item's OWN cost line, and is exactly what the Live Client Data API reports as
 *   \`price\` — verified on every item this app has ever observed at generation time.
 * - \`total\` is what it costs to OWN, recipe included. This is the number the live feed does not
 *   have and the reason this file exists.
 */
export type ItemRow = readonly [
	id: number,
	name: string,
	base: number,
	total: number,
	from: readonly number[],
	into: readonly number[],
	consumable: 0 | 1,
	trinket: 0 | 1,
	/**
	 * Can it be bought in the shop? A transformed item — Seraph's Embrace, Muramana, Fimbulwinter
	 * — cannot, and that is how a finished item with no recipe is told apart from a starter with
	 * no recipe.
	 */
	purchasable: 0 | 1
]

/** The patch this table was generated from, so a stale table can be seen rather than guessed at. */
export const ITEM_TABLE_PATCH = "${patch}"

export const ITEM_ROWS: readonly ItemRow[] = [
${body}
]
`
	writeFileSync(OUT, out)
	console.log(`wrote ${OUT}: ${rows.length} rows, ${(out.length / 1024).toFixed(0)} KB`)
}

void main()
