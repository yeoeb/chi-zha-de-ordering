import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const outputDirectory = mkdtempSync(join(safeTempRoot, "chi-zha-de-dry-run-"));
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function listFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

try {
	const result = spawnSync(
		process.execPath,
		[
			wranglerBin,
			"deploy",
			"--dry-run",
			"--outdir",
			outputDirectory,
			"--metafile",
			join(outputDirectory, "bundle-meta.json"),
			"--config",
			join(root, "wrangler.json"),
		],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		},
	);

	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.status !== 0) {
		throw new Error("Wrangler deployment dry-run failed");
	}

	const bundleFiles = listFiles(outputDirectory);
	const workerBundle = bundleFiles.find((path) => path.endsWith(".js"));
	const wranglerConfiguration = JSON.parse(readFileSync(join(root, "wrangler.json"), "utf8"));
	const requiredAssets = [
		"dist/client/index.html",
		"dist/client/manifest.webmanifest",
		"dist/client/service-worker.js",
		"dist/client/icons/icon-192.png",
		"dist/client/icons/icon-512.png",
	];

	if (!workerBundle || statSync(workerBundle).size === 0) {
		throw new Error("Wrangler dry-run did not emit a Worker bundle");
	}
	if (
		wranglerConfiguration.assets?.directory !== "./dist/client" ||
		!wranglerConfiguration.assets?.run_worker_first?.includes("/api/*")
	) {
		throw new Error("Wrangler static assets or API Worker-first routing is misconfigured");
	}
	for (const asset of requiredAssets) {
		if (!existsSync(join(root, asset))) {
			throw new Error(`Deployment asset is missing: ${asset}`);
		}
	}

	console.log("Dry-run bundle files:");
	for (const path of bundleFiles) {
		console.log(`- ${relative(outputDirectory, path)} (${statSync(path).size} bytes)`);
	}
	console.log("Wrangler deployment dry-run PASS; Worker bundle and required PWA assets verified.");
} finally {
	const resolvedOutput = resolve(outputDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedOutput.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedOutput, { recursive: true, force: true });
}
