export type MerchantAudioState = "unsupported" | "needs-activation" | "ready" | "error";

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
	const candidate = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
	return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

export class MerchantForegroundAudioController {
	private context: AudioContext | null = null;
	private state: MerchantAudioState;
	private onStateChange: (state: MerchantAudioState) => void;
	private onRingChange: (ringing: boolean) => void;
	private ringOrders = new Set<string>();
	private ringDeadline = 0;
	private ringTimer: ReturnType<typeof setTimeout> | undefined;
	private ringing = false;
	private generation = 0;
	private disposed = false;
	private pendingResumes = new Set<() => void>();
	private nodes = new Set<{ oscillator: AudioScheduledSourceNode; gain: GainNode }>();
	private ringBuffer: AudioBuffer | null = null;
	private assetPromise: Promise<void> | null = null;
	private assetRequest: AbortController | null = null;
	private assetTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(onStateChange: (state: MerchantAudioState) => void, onRingChange: (ringing: boolean) => void = () => undefined) {
		this.onStateChange = onStateChange;
		this.onRingChange = onRingChange;
		this.state = audioContextConstructor() ? "needs-activation" : "unsupported";
		this.onStateChange(this.state);
	}

	getState() {
		return this.state;
	}

	private setState(state: MerchantAudioState) {
		this.state = state;
		this.onStateChange(state);
	}

	private ensureContext() {
		if (this.context && this.context.state !== "closed") return this.context;
		const Context = audioContextConstructor();
		if (!Context) {
			this.setState("unsupported");
			return null;
		}
		this.context = new Context();
		this.context.addEventListener("statechange", () => {
			if (!this.context || this.context.state === "closed") return;
			this.setState(this.context.state === "running" ? "ready" : "needs-activation");
		});
		return this.context;
	}

	private loadRing(context: AudioContext) {
		if (this.assetPromise) return this.assetPromise;
		if (!context.decodeAudioData || !context.createBufferSource) return Promise.resolve();
		this.assetRequest = new AbortController();
		const signal = this.assetRequest.signal;
		this.assetPromise = (async () => {
			try {
				const buffer = await Promise.race([
					(async () => {
						const response = await fetch("/sounds/new-order.wav", { signal, cache: "force-cache" });
						if (!response.ok) throw new Error("Ring asset unavailable");
						return context.decodeAudioData(await response.arrayBuffer());
					})(),
					new Promise<never>((_, reject) => {
						this.assetTimeout = setTimeout(() => { this.assetRequest?.abort(); reject(new Error("Ring asset timed out")); }, 2000);
					}),
				]);
				if (!this.disposed && !signal.aborted && buffer.duration >= 2 && buffer.duration <= 5) this.ringBuffer = buffer;
			} catch { /* Local synthesis remains available when the asset cannot load. */ }
			finally { clearTimeout(this.assetTimeout); this.assetTimeout = undefined; }
		})();
		return this.assetPromise;
	}

	private scheduleRing(context: AudioContext) {
		if (!this.ringBuffer) { this.scheduleChime(context, true); return; }
		const oscillator = context.createBufferSource();
		const gain = context.createGain();
		oscillator.buffer = this.ringBuffer;
		gain.gain.setValueAtTime(1.0, context.currentTime);
		const node = { oscillator, gain };
		this.nodes.add(node);
		oscillator.onended = () => {
			oscillator.disconnect(); gain.disconnect(); this.nodes.delete(node);
		};
		oscillator.connect(gain); gain.connect(context.destination);
		oscillator.start();
	}

	private scheduleChime(context: AudioContext, ringing = false) {
		const scheduleTone = (frequency: number, offset: number) => {
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const startsAt = context.currentTime + offset;
			const duration = ringing ? 1.2 : 0.32;
			const node = { oscillator, gain };
			this.nodes.add(node);
			oscillator.onended = () => {
				oscillator.disconnect();
				gain.disconnect();
				this.nodes.delete(node);
			};
			oscillator.frequency.setValueAtTime(frequency, startsAt);
			gain.gain.setValueAtTime(0.0001, startsAt);
			gain.gain.exponentialRampToValueAtTime(0.22, startsAt + 0.025);
			gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration - 0.02);
			oscillator.connect(gain);
			gain.connect(context.destination);
			oscillator.start(startsAt);
			oscillator.stop(startsAt + duration);
		};

		scheduleTone(740, 0);
		scheduleTone(988, ringing ? 1.2 : 0.32);
	}

	// One cadence timer per session, independent of the five-second polling loop.
	async startRing(orderIds: readonly string[]) {
		if (this.disposed || orderIds.length === 0) return false;
		const context = this.context;
		if (!context) return false;
		for (const id of orderIds) this.ringOrders.add(id);
		this.ringDeadline = Date.now() + 60_000;
		if (this.ringing) return true;
		this.ringing = true;
		const generation = ++this.generation;
		try {
			await this.resumeAndVerify(context);
			await this.loadRing(context);
			if (this.disposed || !this.ringing || generation !== this.generation) return false;
			this.onRingChange(true);
			this.ringPulse();
			return true;
		} catch {
			if (generation === this.generation && !this.disposed) {
				this.stopRing();
				this.setState("error");
			}
			return false;
		}
	}

	private ringPulse() {
		this.ringTimer = undefined;
		const remaining = this.ringDeadline - Date.now();
		if (!this.ringing || remaining <= 0 || this.context?.state !== "running") {
			this.stopRing();
			return;
		}
		// Never schedule audio beyond the deadline (e.g. late/suspended timer).
		const duration = (this.ringBuffer?.duration ?? 2.4) * 1000;
		if (remaining >= duration) this.scheduleRing(this.context);
		this.ringTimer = setTimeout(() => this.ringPulse(), Math.min(remaining, duration + 600));
	}

	retainPendingOrders(ids: readonly string[]) {
		const pending = new Set(ids);
		for (const id of this.ringOrders) if (!pending.has(id)) this.ringOrders.delete(id);
		if (this.ringOrders.size === 0) this.stopRing();
	}

	stopRing() {
		++this.generation;
		clearTimeout(this.ringTimer);
		this.ringTimer = undefined;
		this.ringOrders.clear();
		const wasRinging = this.ringing;
		this.ringing = false;
		for (const { oscillator, gain } of this.nodes) {
			oscillator.onended = null;
			try { oscillator.stop(); } catch { /* Already-ended audio is safe to disconnect. */ }
			oscillator.disconnect();
			gain.disconnect();
		}
		this.nodes.clear();
		if (wasRinging) this.onRingChange(false);
	}

	private async resumeAndVerify(context: AudioContext) {
		if (context.state !== "running") {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let cancel: (() => void) | undefined;
			try {
				await Promise.race([
					context.resume(),
					new Promise<never>((_, reject) => {
						cancel = () => { clearTimeout(timeout); reject(new Error("Audio controller disposed")); };
						this.pendingResumes.add(cancel);
						timeout = setTimeout(() => reject(new Error("Audio resume timed out")), 2000);
					}),
				]);
			} finally {
				clearTimeout(timeout);
				if (cancel) this.pendingResumes.delete(cancel);
			}
		}
		if (context.state !== "running") throw new Error("AudioContext did not enter running state");
	}

	async activate(preview = true) {
		if (this.disposed) return false;
		try {
			const context = this.ensureContext();
			if (!context) return false;
			await this.resumeAndVerify(context);
			await this.loadRing(context);
			if (this.disposed) return false;
			if (context.state !== "running") throw new Error("AudioContext suspended during asset loading");
			if (preview) {
				if (this.ringBuffer) this.scheduleRing(context);
				else this.scheduleChime(context);
			}
			this.setState("ready");
			return true;
		} catch {
			this.setState("error");
			return false;
		}
	}

	async playAlert() {
		if (this.disposed || this.ringing) return false;
		const context = this.context;
		if (!context) {
			this.setState(audioContextConstructor() ? "needs-activation" : "unsupported");
			return false;
		}
		try {
			await this.resumeAndVerify(context);
			if (this.disposed) return false;
			if (this.ringBuffer) this.scheduleRing(context);
			else this.scheduleChime(context);
			this.setState("ready");
			return true;
		} catch {
			this.setState("error");
			return false;
		}
	}

	async recover() {
		if (this.disposed || !this.context) return;
		if (this.context.state === "running") {
			this.setState("ready");
			return;
		}
		try {
			await this.resumeAndVerify(this.context);
			this.setState("ready");
		} catch {
			this.setState("error");
		}
	}

		dispose() {
		this.disposed = true;
		this.assetRequest?.abort();
		clearTimeout(this.assetTimeout);
		this.stopRing();
		this.onRingChange = () => undefined;
		this.onStateChange = () => undefined;
		for (const cancel of this.pendingResumes) cancel();
		this.pendingResumes.clear();
		if (this.context && this.context.state !== "closed") void this.context.close().catch(() => undefined);
		this.context = null;
	}
}
