import { afterEach, describe, expect, it, vi } from "vitest";
import { MerchantForegroundAudioController } from "../src/react-app/merchant-audio";

function setup() {
	vi.useFakeTimers();
	const nodes: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
	const gains: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
	const close = vi.fn(async () => undefined);
	const resume = vi.fn(async () => undefined);
	const constructed = vi.fn();
	class FakeContext {
		state: AudioContextState = "running";
		currentTime = 0;
		destination = {};
		resume = resume;
		close = close;
		constructor() { constructed(); }
		addEventListener() {}
		createOscillator() {
			const node = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null as (() => void) | null, connect: vi.fn(), frequency: { setValueAtTime: vi.fn() } };
			nodes.push(node);
			return node;
		}
		createGain() {
			const gain = { disconnect: vi.fn(), connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
			gains.push(gain);
			return gain;
		}
	}
	vi.stubGlobal("AudioContext", FakeContext);
	const changes = vi.fn();
	const controller = new MerchantForegroundAudioController(vi.fn(), changes);
	return { controller, changes, constructed, nodes, gains, close, resume };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Merchant repeated foreground ring", () => {
	it("loads the repository ring once, plays decoded buffers and disconnects on stop", async () => {
		const audio = setup();
		const contextConstructor = window.AudioContext;
		const decode = vi.fn(async () => ({ duration: 2.4 }) as AudioBuffer);
		const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
		Object.assign(contextConstructor.prototype, {
			decodeAudioData: decode,
			createBufferSource() {
				const source = { buffer: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), onended: null as (() => void) | null };
				sources.push(source); return source;
			},
		});
		const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
		vi.stubGlobal("fetch", fetch);
		await audio.controller.activate();
		await audio.controller.startRing(["a", "b"]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith("/sounds/new-order.wav", expect.objectContaining({ cache: "force-cache" }));
		expect(decode).toHaveBeenCalledTimes(1);
		expect(sources).toHaveLength(3); // Test preview + two pulses.
		expect(vi.getTimerCount()).toBe(1);
		audio.controller.stopRing();
		for (const source of sources) { expect(source.stop).toHaveBeenCalled(); expect(source.disconnect).toHaveBeenCalled(); }
		expect(audio.constructed).toHaveBeenCalledTimes(1);
		audio.controller.dispose();
	});

	it("does not claim activation if the context suspends during asynchronous asset decoding", async () => {
		const audio = setup();
		let finish!: (buffer: AudioBuffer) => void;
		Object.assign(window.AudioContext.prototype, {
			decodeAudioData: vi.fn(() => new Promise<AudioBuffer>((resolve) => { finish = resolve; })),
			createBufferSource: vi.fn(),
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
		const activation = audio.controller.activate();
		await vi.advanceTimersByTimeAsync(0);
		const context = (audio.controller as unknown as { context: { state: string } }).context;
		context.state = "suspended";
		finish({ duration: 2.4 } as AudioBuffer);
		expect(await activation).toBe(false);
		expect(audio.controller.getState()).toBe("error");
		expect(audio.nodes).toHaveLength(0);
		audio.controller.dispose();
	});

	it("disposal cancels an in-flight asset timeout and late download cannot play audio", async () => {
		const audio = setup();
		Object.assign(window.AudioContext.prototype, { decodeAudioData: vi.fn(async () => ({ duration: 2.4 })), createBufferSource: vi.fn() });
		let finish!: (response: Response) => void;
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
		const activation = audio.controller.activate();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		audio.controller.dispose();
		expect(vi.getTimerCount()).toBe(0);
		finish(new Response(new Uint8Array([1])));
		expect(await activation).toBe(false);
		expect(audio.nodes).toHaveLength(0);
	});

	it("failed local audio download uses synthesis without blocking new-order alerts", async () => {
		const audio = setup();
		Object.assign(window.AudioContext.prototype, { decodeAudioData: vi.fn(), createBufferSource: vi.fn() });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
		expect(await audio.controller.activate()).toBe(true);
		expect(await audio.controller.startRing(["a"])).toBe(true);
		expect(audio.nodes).toHaveLength(4);
		audio.controller.dispose();
	});
	it("uses the unlocked context and one timer for an entire new-order batch", async () => {
		const audio = setup();
		await audio.controller.activate();
		expect(await audio.controller.startRing(["a", "b", "c"])).toBe(true);
		expect(audio.constructed).toHaveBeenCalledTimes(1);
		expect(audio.changes.mock.calls).toEqual([[true]]);
		expect(vi.getTimerCount()).toBe(1);
		const firstPulseNodes = audio.nodes.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(audio.nodes.length).toBe(firstPulseNodes + 2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(audio.nodes.length).toBe(firstPulseNodes + 4);
		expect(vi.getTimerCount()).toBe(1);
		audio.controller.dispose();
	});

	it("repeats but stops at exactly 60 seconds and disconnects all audio", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a"]);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(audio.changes.mock.calls).toEqual([[true]]);
		expect(audio.nodes.length).toBeGreaterThan(4);
		await vi.advanceTimersByTimeAsync(1);
		expect(audio.changes.mock.calls).toEqual([[true], [false]]);
		expect(vi.getTimerCount()).toBe(0);
		const total = audio.nodes.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(audio.nodes).toHaveLength(total);
		for (const node of audio.nodes) expect(node.disconnect).toHaveBeenCalled();
		for (const gain of audio.gains) expect(gain.disconnect).toHaveBeenCalled();
		audio.controller.dispose();
	});

	it("extends the deadline for a new batch without a second controller, pulse or timer", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a"]);
		await vi.advanceTimersByTimeAsync(30_000);
		const before = audio.nodes.length;
		await audio.controller.startRing(["b", "c"]);
		expect(audio.nodes).toHaveLength(before);
		expect(audio.changes.mock.calls).toEqual([[true]]);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(audio.changes.mock.calls).toEqual([[true]]);
		await vi.advanceTimersByTimeAsync(1);
		expect(audio.changes.mock.calls).toEqual([[true], [false]]);
		expect(audio.constructed).toHaveBeenCalledTimes(1);
		audio.controller.dispose();
	});

	it("manual stop is immediate but does not disable a later genuinely new order", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a"]);
		audio.controller.stopRing();
		expect(audio.changes.mock.calls).toEqual([[true], [false]]);
		expect(vi.getTimerCount()).toBe(0);
		const total = audio.nodes.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(audio.nodes).toHaveLength(total);
		await audio.controller.startRing(["b"]);
		expect(audio.nodes).toHaveLength(total + 2);
		expect(audio.constructed).toHaveBeenCalledTimes(1);
		expect(audio.close).not.toHaveBeenCalled();
		audio.controller.dispose();
	});

	it("stops when the alerted orders are processed, not when unrelated pending orders remain", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a", "b"]);
		audio.controller.retainPendingOrders(["b", "old"]);
		expect(audio.changes.mock.calls).toEqual([[true]]);
		audio.controller.retainPendingOrders(["old"]);
		expect(audio.changes.mock.calls).toEqual([[true], [false]]);
		expect(vi.getTimerCount()).toBe(0);
		audio.controller.dispose();
	});

	it("ended tones disconnect nodes without waiting for the session to end", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a"]);
		const node = audio.nodes.at(-1)!;
		node.onended!();
		expect(node.disconnect).toHaveBeenCalledTimes(1);
		expect(audio.gains.at(-1)!.disconnect).toHaveBeenCalledTimes(1);
		audio.controller.dispose();
		expect(node.disconnect).toHaveBeenCalledTimes(1);
	});

	it("disposal cancels timers/audio and prevents async resume from resurrecting an alarm", async () => {
		const audio = setup();
		await audio.controller.activate();
		await audio.controller.startRing(["a"]);
		audio.controller.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(audio.close).toHaveBeenCalledTimes(1);
		expect(await audio.controller.startRing(["b"])).toBe(false);
	});

	it("a stop while resume is awaiting prevents late audio and a duplicate pending session", async () => {
		const audio = setup();
		await audio.controller.activate();
		let resolveResume!: () => void;
		audio.resume.mockImplementation(() => new Promise<undefined>((resolve) => { resolveResume = () => resolve(undefined); }));
		// Use the actual context state, not a platform-specific unlock path.
		const context = (audio.controller as unknown as { context: { state: string } }).context;
		context.state = "suspended";
		const first = audio.controller.startRing(["a"]);
		await audio.controller.startRing(["b"]);
		audio.controller.stopRing();
		context.state = "running";
		resolveResume();
		expect(await first).toBe(false);
		expect(audio.nodes).toHaveLength(2); // Activation only.
		expect(vi.getTimerCount()).toBe(0);
		audio.controller.dispose();
	});
});
