import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
	root: "src/web",
	plugins: [react()],
	server: {
		port: 7701,
		proxy: {
			"/api": "http://127.0.0.1:7700",
			"/media": "http://127.0.0.1:7700"
		}
	},
	build: { outDir: "../../dist", emptyOutDir: true }
})
