// Original synthesized telephone-style ring; dedicated to CC0-1.0.
import { mkdirSync, writeFileSync } from "node:fs";
const rate = 22050;
const duration = 2.4;
const samples = Math.round(rate * duration);
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
	const t = i / rate;
	const fade = Math.min(1, t / 0.035, (duration - t) / 0.035);
	const tremolo = 0.65 + 0.35 * Math.sin(2 * Math.PI * 20 * t);
	const tone = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
	wav.writeInt16LE(Math.round(32767 * 0.55 * fade * tremolo * tone), 44 + i * 2);
}
const directory = new URL("../public/sounds/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("new-order.wav", directory), wav);
console.log(`Generated original 2.4s telephone ring (${wav.length} bytes).`);
