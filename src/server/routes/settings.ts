/**
 * `GET /api/settings` and `PUT /api/settings`.
 *
 * Settings are stored one key per row and read back merged over `DEFAULT_SETTINGS`, so adding
 * a field is backward compatible with an existing database and never needs a migration. The
 * corollary is that a stored row OUTRANKS the code default permanently, which is why the PUT
 * below writes only the keys the user actually touched — see the comment on the write.
 *
 * The PUT path goes through `clampSettings`, so a fat-fingered `pollInGameMs: 0` cannot wedge
 * the daemon, and the daemon is notified synchronously so new poll intervals apply without a
 * restart.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { type } from "arktype"
import { getSettings, putSettings } from "../../db/queries.ts"
import { SettingsResponse } from "../../shared/schema/api.ts"
import { SettingsPatch, clampSettings } from "../../shared/schema/settings.ts"
import type { Settings } from "../../shared/schema/settings.ts"
import type { ServerDeps } from "../deps.ts"
import { fail, readJson, send } from "../respond.ts"

export const createSettingsRoutes = (deps: ServerDeps): Hono => {
	const app = new Hono()

	app.get("/settings", c =>
		send(c, SettingsResponse, getSettings(), "GET /api/settings")
	)

	const applyPatch = async (c: Context): Promise<Response> => {
		const raw = await readJson(c)
		if (raw === undefined)
			return fail(c, 400, "request body was not valid JSON", "bad-json")

		// `SettingsPatch` has `"+": "delete"`, so unknown keys are dropped rather than stored.
		const patch = SettingsPatch(raw)
		if (patch instanceof type.errors)
			return fail(c, 400, "invalid settings patch", "bad-settings", patch.summary)

		/*
		 * ONLY THE KEYS THE PATCH CARRIED ARE PERSISTED, and that is load-bearing.
		 *
		 * This used to be `putSettings(merged)` — the whole settings object, every save. One
		 * field changed and all seventeen keys became stored rows, after which `getSettings()`
		 * merged them over `DEFAULT_SETTINGS` forever and a code default could never reach this
		 * install again. It is not a hypothetical: every settings row on the author's machine
		 * carries one identical `updatedMs`, and the `autoReviewNewGames: false` frozen in that
		 * single write switched the post-game review path off for eight days while the code
		 * default, the schema and the README all still said `true`.
		 *
		 * The clamp still runs against the MERGED view, because a clamp needs its neighbours —
		 * but only the touched keys are written back out of it.
		 */
		const merged = clampSettings({ ...getSettings(), ...patch } as Settings)
		const touched: Record<string, unknown> = {}
		for (const key of Object.keys(patch)) touched[key] = (merged as Record<string, unknown>)[key]
		const next = putSettings(touched as Partial<Settings>)

		try {
			deps.onSettingsChange?.(next)
		} catch (err) {
			console.warn(`[settings] daemon rejected the change: ${(err as Error).message}`)
		}

		return send(c, SettingsResponse, next, "PUT /api/settings")
	}

	app.put("/settings", applyPatch)
	// Some fetch wrappers only speak POST; the semantics are identical (merge, not replace).
	app.post("/settings", applyPatch)

	return app
}
