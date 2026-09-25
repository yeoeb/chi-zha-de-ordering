import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const onsiteUrl = "https://chi-zha-de-ordering.yeoeb55688.workers.dev/onsite";
const svg = await QRCode.toString(onsiteUrl, {
	type: "svg",
	errorCorrectionLevel: "H",
	margin: 4,
	width: 1024,
	color: { dark: "#181818ff", light: "#ffffffff" },
});

writeFileSync(
	join(root, "public", "onsite-ordering-qr.svg"),
	svg.replace("<svg ", `<svg role="img" aria-labelledby="onsite-qr-title" `)
		.replace(">", `><title id="onsite-qr-title">吃炸的現場點餐 ${onsiteUrl}</title>`),
	"utf8",
);
console.log(`Generated public/onsite-ordering-qr.svg for ${onsiteUrl}`);
