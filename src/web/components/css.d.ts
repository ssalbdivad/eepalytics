/**
 * Vite resolves `import "./components.css"` to a side-effect module. `tsc` needs to be told
 * that such an import is legal, because this repo does not pull in `vite/client` types.
 * Owned by the `web-viz` unit alongside the components that do the importing.
 */
declare module "*.css" {
	const url: string
	export default url
}

declare module "*.svg" {
	const url: string
	export default url
}
