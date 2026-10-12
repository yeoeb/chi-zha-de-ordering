import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scripts = [
	"verify-pwa.mjs",
	"verify-fresh-d1.mjs",
	"verify-migration-0013-upgrade.mjs",
	"verify-production-data.mjs",
	"verify-hotfix-menu.mjs",
	"verify-test-menu.mjs",
	"verify-scheduled-store-upgrade.mjs",
];

// Every D1 verifier uses --local temporary persistence or an in-memory database.
// Deployment and remote database commands are deliberately outside this gate.
for (const script of scripts) {
	console.log(`\nLocal verification: ${script}`);
	const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Local verification PASS; no deployment or remote D1 operation performed.");
