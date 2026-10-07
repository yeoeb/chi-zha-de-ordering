import { useEffect, useState, type FormEvent } from "react";

type CustomerPhoneMode = "hidden" | "optional";
type DayHours = { isOpen: boolean; openAt: string; closeAt: string };
type WeeklyBusinessHours = Record<string, DayHours>;
type StoreConfiguration = {
	weeklyBusinessHours: WeeklyBusinessHours | null;
	lastOrderTime: string | null;
	customerPhoneMode: CustomerPhoneMode;
	showProductImages: boolean;
	newOrderSoundEnabled: boolean;
};

const dayLabels = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const timePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function editableSchedule(value: WeeklyBusinessHours | null): WeeklyBusinessHours {
	return Object.fromEntries(dayLabels.map((_, index) => [
		String(index),
		value?.[String(index)] ?? { isOpen: false, openAt: "17:30", closeAt: "23:15" },
	]));
}

async function responseError(response: Response, fallback: string) {
	const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
	return body?.error?.message ?? fallback;
}

export default function AdminStoreView() {
	const [schedule, setSchedule] = useState<WeeklyBusinessHours>(() => editableSchedule(null));
	const [lastOrderTime, setLastOrderTime] = useState("23:00");
	const [customerPhoneMode, setCustomerPhoneMode] = useState<CustomerPhoneMode>("optional");
	const [showProductImages, setShowProductImages] = useState(true);
	const [newOrderSoundEnabled, setNewOrderSoundEnabled] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/admin/store", { signal: controller.signal, cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error(await responseError(response, "無法載入營業設定。"));
				return response.json() as Promise<StoreConfiguration>;
			})
			.then((value) => {
				setSchedule(editableSchedule(value.weeklyBusinessHours));
				setLastOrderTime(value.lastOrderTime ?? "23:00");
				setCustomerPhoneMode(value.customerPhoneMode);
				setShowProductImages(value.showProductImages);
				setNewOrderSoundEnabled(value.newOrderSoundEnabled);
				setLoaded(true);
			})
			.catch((error) => {
				if (!(error instanceof Error && error.name === "AbortError")) {
					setMessage({ tone: "error", text: error instanceof Error ? error.message : "無法載入營業設定。" });
				}
			});
		return () => controller.abort();
	}, []);

	function updateDay(day: string, patch: Partial<DayHours>) {
		setSchedule((current) => ({
			...current,
			[day]: { ...current[day]!, ...patch },
		}));
		setMessage(null);
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		if (saving) return;
		const invalidDay = Object.entries(schedule).find(([, day]) =>
			!timePattern.test(day.openAt) || !timePattern.test(day.closeAt) || (day.isOpen && day.openAt === day.closeAt),
		);
		if (invalidDay || !timePattern.test(lastOrderTime)) {
			setMessage({ tone: "error", text: "請確認營業與最後接單時間皆為有效的 HH:mm，營業日的開始與結束時間不可相同。" });
			return;
		}
		setSaving(true);
		setMessage(null);
		try {
			const response = await fetch("/api/admin/store", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					weeklyBusinessHours: schedule,
					lastOrderTime,
					customerPhoneMode,
					showProductImages,
					newOrderSoundEnabled,
				}),
			});
			if (!response.ok) throw new Error(await responseError(response, "營業設定儲存失敗。"));
			const value = await response.json() as StoreConfiguration;
			setSchedule(editableSchedule(value.weeklyBusinessHours));
			setLastOrderTime(value.lastOrderTime ?? "23:00");
			setCustomerPhoneMode(value.customerPhoneMode);
			setShowProductImages(value.showProductImages);
			setNewOrderSoundEnabled(value.newOrderSoundEnabled);
			setMessage({ tone: "success", text: "營業與顧客點餐設定已儲存。" });
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "營業設定儲存失敗。" });
		} finally {
			setSaving(false);
		}
	}

	return (
		<main className="admin-page admin-store-page">
			<header className="admin-header">
				<div><p>吃炸的 · Owner</p><h1>店家設定</h1><span>低頻設定；每日接單與售罄仍在店家工作台操作。</span></div>
				<div className="admin-header-actions"><a href="/admin/menu">返回商品管理</a></div>
			</header>
			{message && <p className={`admin-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
			{!loaded ? <p className="admin-message" role="status">載入中…</p> : (
				<form className="admin-store-form" onSubmit={(event) => void save(event)}>
					<section aria-labelledby="business-hours-heading">
						<h2 id="business-hours-heading">營業設定</h2>
						<p>顧客畫面依台北時區顯示今天的營業時間；關閉的日期顯示「今日公休」。</p>
						<div className="admin-weekly-hours">
							{dayLabels.map((label, index) => {
								const day = schedule[String(index)]!;
								return <div className="admin-business-day" key={label}>
									<label className="admin-checkbox"><input type="checkbox" checked={day.isOpen} onChange={(event) => updateDay(String(index), { isOpen: event.target.checked })} />{label}</label>
									<label>開始<input type="time" value={day.openAt} disabled={!day.isOpen} onChange={(event) => updateDay(String(index), { openAt: event.target.value })} /></label>
									<label>結束<input type="time" value={day.closeAt} disabled={!day.isOpen} onChange={(event) => updateDay(String(index), { closeAt: event.target.value })} /></label>
								</div>;
							})}
						</div>
						<label className="admin-setting-field">最後接單時間<input type="time" value={lastOrderTime} required onChange={(event) => { setLastOrderTime(event.target.value); setMessage(null); }} /></label>
					</section>
					<section aria-labelledby="customer-settings-heading">
						<h2 id="customer-settings-heading">顧客點餐設定</h2>
						<fieldset><legend>電話</legend><label><input type="radio" name="phone-mode" checked={customerPhoneMode === "hidden"} onChange={() => setCustomerPhoneMode("hidden")} />不顯示</label><label><input type="radio" name="phone-mode" checked={customerPhoneMode === "optional"} onChange={() => setCustomerPhoneMode("optional")} />選填</label></fieldset>
						<fieldset><legend>商品圖片</legend><label><input aria-label="開啟商品圖片" type="radio" name="image-mode" checked={showProductImages} onChange={() => setShowProductImages(true)} />ON</label><label><input aria-label="關閉商品圖片" type="radio" name="image-mode" checked={!showProductImages} onChange={() => setShowProductImages(false)} />OFF</label></fieldset>
						<fieldset><legend>新單提示音</legend><label><input aria-label="開啟新單提示音" type="radio" name="sound-mode" checked={newOrderSoundEnabled} onChange={() => setNewOrderSoundEnabled(true)} />ON</label><label><input aria-label="關閉新單提示音" type="radio" name="sound-mode" checked={!newOrderSoundEnabled} onChange={() => setNewOrderSoundEnabled(false)} />OFF</label></fieldset>
						<p className="admin-form-note">店家設定決定是否使用提示音；每次開啟店家工作台仍需由店員點擊啟用瀏覽器音訊。</p>
						<p className="admin-form-note">關閉商品圖片只改變顧客排版，不會刪除商品的圖片網址。</p>
					</section>
					<button className="admin-store-save" type="submit" disabled={saving}>{saving ? "儲存中…" : "儲存設定"}</button>
				</form>
			)}
		</main>
	);
}
