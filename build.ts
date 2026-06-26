// Minimal standalone build script for this plugin.
//
// This is a deliberately stripped-down version of the approach confirmed from
// nexpid/RevengePlugins' real build pipeline (scripts/build/modules/workers/plugins.ts) —
// specifically the two things that actually matter for getting a plugin to load correctly:
//
//   1. @vendetta/* imports need to resolve to property access on the global
//      `vendetta` object the loader injects at runtime (e.g. `@vendetta/metro/common`
//      becomes `vendetta.metro.common`), not to an actual installed package — there's no
//      npm package backing these at runtime, vendetta-types only provides the *type*
//      declarations used at compile time.
//   2. The bundle needs to be wrapped so it evaluates to a single object with onLoad/
//      onUnload/settings on it, the shape Revenge's plugin loader expects.
//
// Everything else in the real build script (i18n, doc generation, a worker pool for
// building many plugins in parallel) doesn't apply to a single standalone plugin and
// isn't reproduced here.

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
const isWatch = process.argv.includes("--watch");

const vendettaGlobalsPlugin = {
	name: "vendetta-globals",
	setup(buildApi: any) {
		// Resolve any "@vendetta" or "@vendetta/x/y" import to a synthetic module that
		// just re-exports the matching path on the runtime-injected `vendetta` global.
		buildApi.onResolve({ filter: /^@vendetta\/?/ }, ({ path }: { path: string; }) => ({
			path,
			namespace: "vendetta-globals"
		}));

		buildApi.onLoad({ filter: /.*/, namespace: "vendetta-globals" }, ({ path }: { path: string; }) => ({
			// "@vendetta/metro/common" -> "vendetta.metro.common"
			// "@vendetta" -> "vendetta"
			contents: `module.exports = ${path.replace(/^@/, "").replace(/\//g, ".")}`,
			loader: "js"
		}));
	}
};

async function run() {
	const options = {
		entryPoints: [manifest.main],
		outfile: "dist/index.js",
		bundle: true,
		format: "iife" as const,
		globalName: "__mochasrevenge",
		// Wraps the IIFE so the bundle evaluates to the module's exports object —
		// onLoad/onUnload/settings — which is the shape the plugin loader expects.
		banner: { js: "(() => {" },
		footer: { js: "return __mochasrevenge; })()" },
		jsx: "automatic" as const,
		jsxImportSource: "react",
		target: "es2020",
		minify: !isWatch,
		sourcemap: isWatch,
		loader: { ".json": "json" as const },
		plugins: [vendettaGlobalsPlugin]
	};

	if (isWatch) {
		const context = await (await import("esbuild")).context(options);
		await context.watch();
		console.log("Watching for changes...");
	} else {
		await build(options);
		console.log(`Built dist/index.js from ${manifest.main}`);
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
