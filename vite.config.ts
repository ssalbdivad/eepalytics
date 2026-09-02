import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
	root: "src/web",
	plugins: [react()],
	server: {
		port: 7701,
		// VERIFIED: a WSL loopback bind answers 000 from Windows, where League and the browser
		// live. `host: true` binds 0.0.0.0, which WSL2 maps onto the host's own localhost.
		host: true,
		proxy: {
			"/api": "http://127.0.0.1:7700",
			"/media": "http://127.0.0.1:7700"
		}
	},
	build: { outDir: "../../dist", emptyOutDir: true }
})
