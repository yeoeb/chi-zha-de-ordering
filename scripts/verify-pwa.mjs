import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "public", "manifest.webmanifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (
	manifest.name !== "吃炸的" ||
	manifest.short_name !== "吃炸的" ||
	manifest.display !== "standalone" ||
	manifest.start_url !== "/merchant"
) {
	throw new Error("PWA manifest metadata is incomplete");
}

for (const size of ["192x192", "512x512"]) {
	const icon = manifest.icons?.find((candidate) => candidate.sizes === size);
	if (!icon || !existsSync(join(root, "public", icon.src.replace(/^\//, "")))) {
		throw new Error(`PWA icon ${size} is missing`);
	}
}

const serviceWorker = readFileSync(join(root, "public", "service-worker.js"), "utf8");
if (!serviceWorker.includes('url.pathname.startsWith("/api/")')) {
	throw new Error("Service Worker must bypass every API request");
}

const registration = readFileSync(join(root, "src", "react-app", "main.tsx"), "utf8");
if (!registration.includes('navigator.serviceWorker.register("/service-worker.js")')) {
	throw new Error("Service Worker registration is missing");
}

console.log("PWA manifest, icons, API cache boundary, and registration verified.");
