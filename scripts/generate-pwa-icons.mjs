import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "public", "icons");

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
	return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createIcon(size) {
	const rowLength = size * 4 + 1;
	const pixels = Buffer.alloc(rowLength * size);
	const center = size / 2;

	for (let y = 0; y < size; y += 1) {
		pixels[y * rowLength] = 0;
		for (let x = 0; x < size; x += 1) {
			const offset = y * rowLength + 1 + x * 4;
			const distance = Math.hypot(x - center, y - center);
			const inPlate = distance < size * 0.32;
			const inBasket = y > size * 0.48 && y < size * 0.67 && Math.abs(x - center) < size * 0.23;
			const inFry =
				y > size * 0.3 &&
				y < size * 0.52 &&
				[0.39, 0.47, 0.55, 0.63].some((ratio) => Math.abs(x - size * ratio) < size * 0.025);

			let color = [163, 58, 32, 255];
			if (inPlate) color = [255, 248, 239, 255];
			if (inBasket) color = [112, 40, 24, 255];
			if (inFry) color = [239, 166, 48, 255];
			pixels.set(color, offset);
		}
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 6;

	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

mkdirSync(outputDirectory, { recursive: true });
for (const size of [192, 512]) {
	writeFileSync(join(outputDirectory, `icon-${size}.png`), createIcon(size));
}
