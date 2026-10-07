import { useEffect, useState, type FormEvent } from "react";

type AdminCategory = { id: number; name: string; sortOrder: number; isActive: boolean };

type AdminMenuItem = {
	id: number;
	categoryId: number;
	categoryName: string;
	name: string;
	description: string;
	price: number;
	sortOrder: number;
	isAvailable: boolean;
	imageUrl: string | null;
	isPopular: boolean;
	isQuickSoldOut: boolean;
	isArchived: boolean;
	modifierGroups: Array<{
		id: number;
		name: string;
		isRequired: boolean;
		options: Array<{ id: number; name: string; priceDelta: number }>;
	}>;
};

type AdminMenuResponse = { categories: AdminCategory[]; items: AdminMenuItem[] };

type ItemDraft = {
	name: string;
	price: string;
	description: string;
	categoryId: string;
	sortOrder: string;
	imageUrl: string;
	isPopular: boolean;
	isQuickSoldOut: boolean;
	isArchived: boolean;
};

type CreateItemDraft = Omit<ItemDraft, "isArchived">;
type FieldErrors = Partial<Record<"name" | "price" | "categoryId" | "sortOrder", string>>;

const emptyCreateDraft: CreateItemDraft = {
	name: "",
	price: "",
	description: "",
	categoryId: "",
	sortOrder: "",
	imageUrl: "",
	isPopular: false,
	isQuickSoldOut: false,
};

function isExtremePriceChange(previousPrice: number, nextPrice: number) {
	if (previousPrice === nextPrice) return false;
	if (previousPrice === 0) return nextPrice >= 300;
	return nextPrice >= previousPrice * 3 || nextPrice * 3 <= previousPrice;
}

function toDraft(item: AdminMenuItem): ItemDraft {
	return {
		name: item.name,
		price: String(item.price),
		description: item.description,
		categoryId: String(item.categoryId),
		sortOrder: String(item.sortOrder),
		imageUrl: item.imageUrl ?? "",
		isPopular: item.isPopular,
		isQuickSoldOut: item.isQuickSoldOut,
		isArchived: item.isArchived,
	};
}

function itemStatus(item: AdminMenuItem) {
	if (item.isArchived) return "已封存";
	return item.isAvailable ? "販售中" : "售罄";
}

async function responseError(response: Response, fallback: string) {
	const result = await response.json().catch(() => null) as { error?: { message?: string } } | null;
	return result?.error?.message ?? fallback;
}

function CategoryEditor({ category, disabled, onSave }: {
	category: AdminCategory;
	disabled: boolean;
	onSave: (category: AdminCategory, draft: { name: string; sortOrder: number; isActive: boolean }) => Promise<void>;
}) {
	const [name, setName] = useState(category.name);
	const [sortOrder, setSortOrder] = useState(String(category.sortOrder));
	const [isActive, setIsActive] = useState(category.isActive);

	return (
		<form className="admin-category-row" onSubmit={(event) => {
			event.preventDefault();
			const normalizedSortOrder = Number(sortOrder);
			if (!name.trim() || !Number.isSafeInteger(normalizedSortOrder) || normalizedSortOrder < 0) return;
			void onSave(category, { name, sortOrder: normalizedSortOrder, isActive });
		}}>
			<label>分類名稱<input value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></label>
			<label>排序<input type="number" min="0" step="1" value={sortOrder} required onChange={(event) => setSortOrder(event.target.value)} /></label>
			<label className="admin-checkbox"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />啟用</label>
			<button type="submit" disabled={disabled}>儲存分類</button>
		</form>
	);
}

export default function AdminView() {
	const [menu, setMenu] = useState<AdminMenuResponse | null>(null);
	const [originDisclosure, setOriginDisclosure] = useState("");
	const [editingId, setEditingId] = useState<number | null>(null);
	const [draft, setDraft] = useState<ItemDraft | null>(null);
	const [showCreateItem, setShowCreateItem] = useState(false);
	const [createDraft, setCreateDraft] = useState<CreateItemDraft>(emptyCreateDraft);
	const [createErrors, setCreateErrors] = useState<FieldErrors>({});
	const [showCategories, setShowCategories] = useState(false);
	const [newCategoryName, setNewCategoryName] = useState("");
	const [newCategorySortOrder, setNewCategorySortOrder] = useState("");
	const [processingKey, setProcessingKey] = useState<string | null>(null);
	const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

	async function refreshMenu() {
		const response = await fetch("/api/admin/menu", { cache: "no-store" });
		if (!response.ok) throw new Error(await responseError(response, "無法重新載入商品資料。"));
		setMenu(await response.json() as AdminMenuResponse);
	}

	useEffect(() => {
		const controller = new AbortController();
		Promise.all([
			fetch("/api/admin/menu", { signal: controller.signal, cache: "no-store" }),
			fetch("/api/admin/store-presentation", { signal: controller.signal, cache: "no-store" }),
		])
			.then(async ([menuResponse, presentationResponse]) => {
				if (!menuResponse.ok || !presentationResponse.ok) {
					throw new Error(menuResponse.status === 403 ? "尚未設定獨立的 Admin 授權。" : "無法載入 Admin 資料。");
				}
				const [menuResult, presentationResult] = await Promise.all([
					menuResponse.json() as Promise<AdminMenuResponse>,
					presentationResponse.json() as Promise<{ originDisclosure: string | null }>,
				]);
				setMenu(menuResult);
				setOriginDisclosure(presentationResult.originDisclosure ?? "");
			})
			.catch((error) => {
				if (!(error instanceof Error && error.name === "AbortError")) {
					setMessage({ kind: "error", text: error instanceof Error ? error.message : "無法載入 Admin 資料。" });
				}
			});
		return () => controller.abort();
	}, []);

	function beginEditing(item: AdminMenuItem) {
		setEditingId(item.id);
		setDraft(toDraft(item));
		setMessage(null);
	}

	async function saveItem(event: FormEvent, item: AdminMenuItem) {
		event.preventDefault();
		if (!draft || processingKey !== null) return;
		const price = Number(draft.price);
		const sortOrder = Number(draft.sortOrder);
		const categoryId = Number(draft.categoryId);
		if (!Number.isSafeInteger(price) || price < 0 || price > 100_000) {
			setMessage({ kind: "error", text: "價格必須是 0–100000 的整數。" });
			return;
		}
		if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
			setMessage({ kind: "error", text: "排序必須是非負整數。" });
			return;
		}
		if (isExtremePriceChange(item.price, price) && !window.confirm(`價格將從 NT$ ${item.price} 改為 NT$ ${price}，確定儲存？`)) return;
		if (!item.isArchived && draft.isArchived && !window.confirm("封存後商品會從顧客菜單與店家售罄清單移除，確定封存？")) return;

		setProcessingKey(`item-${item.id}`);
		setMessage(null);
		try {
			const response = await fetch(`/api/admin/menu-items/${item.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: draft.name,
					price,
					description: draft.description,
					categoryId,
					sortOrder,
					imageUrl: draft.imageUrl || null,
					isPopular: draft.isPopular,
					isQuickSoldOut: draft.isQuickSoldOut,
					isArchived: draft.isArchived,
				}),
			});
			if (!response.ok) throw new Error(await responseError(response, "商品儲存失敗。"));
			await refreshMenu();
			setEditingId(null);
			setDraft(null);
			setMessage({ kind: "success", text: `${draft.name.trim()} 已儲存。` });
		} catch (error) {
			setMessage({ kind: "error", text: error instanceof Error ? error.message : "商品儲存失敗。" });
		} finally {
			setProcessingKey(null);
		}
	}

	async function createItem(event: FormEvent) {
		event.preventDefault();
		if (processingKey !== null) return;
		const price = Number(createDraft.price);
		const categoryId = Number(createDraft.categoryId);
		const errors: FieldErrors = {};
		if (!createDraft.name.trim()) errors.name = "請輸入商品名稱。";
		if (!Number.isSafeInteger(price) || price < 0 || price > 100_000) errors.price = "請輸入 0–100000 的整數價格。";
		if (!Number.isSafeInteger(categoryId) || categoryId <= 0) errors.categoryId = "請選擇啟用中的分類。";
		if (createDraft.sortOrder && (!Number.isSafeInteger(Number(createDraft.sortOrder)) || Number(createDraft.sortOrder) < 0)) errors.sortOrder = "排序必須是非負整數。";
		setCreateErrors(errors);
		if (Object.keys(errors).length > 0) return;

		setProcessingKey("create-item");
		setMessage(null);
		try {
			const body: Record<string, unknown> = {
				name: createDraft.name,
				price,
				categoryId,
				description: createDraft.description || null,
				imageUrl: createDraft.imageUrl || null,
				isPopular: createDraft.isPopular,
				isQuickSoldOut: createDraft.isQuickSoldOut,
			};
			if (createDraft.sortOrder) body.sortOrder = Number(createDraft.sortOrder);
			const response = await fetch("/api/admin/menu-items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(await responseError(response, "新增商品失敗。"));
			await refreshMenu();
			setCreateDraft(emptyCreateDraft);
			setCreateErrors({});
			setShowCreateItem(false);
			setMessage({ kind: "success", text: `${createDraft.name.trim()} 已新增。` });
		} catch (error) {
			setMessage({ kind: "error", text: error instanceof Error ? error.message : "新增商品失敗。" });
		} finally {
			setProcessingKey(null);
		}
	}

	async function createCategory(event: FormEvent) {
		event.preventDefault();
		if (processingKey !== null || !newCategoryName.trim()) return;
		const sortOrder = newCategorySortOrder ? Number(newCategorySortOrder) : undefined;
		if (sortOrder !== undefined && (!Number.isSafeInteger(sortOrder) || sortOrder < 0)) {
			setMessage({ kind: "error", text: "分類排序必須是非負整數。" });
			return;
		}
		setProcessingKey("create-category");
		setMessage(null);
		try {
			const response = await fetch("/api/admin/categories", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: newCategoryName, ...(sortOrder === undefined ? {} : { sortOrder }) }),
			});
			if (!response.ok) throw new Error(await responseError(response, "新增分類失敗。"));
			await refreshMenu();
			setNewCategoryName("");
			setNewCategorySortOrder("");
			setMessage({ kind: "success", text: "分類已新增。" });
		} catch (error) {
			setMessage({ kind: "error", text: error instanceof Error ? error.message : "新增分類失敗。" });
		} finally {
			setProcessingKey(null);
		}
	}

	async function saveCategory(category: AdminCategory, categoryDraft: { name: string; sortOrder: number; isActive: boolean }) {
		if (processingKey !== null) return;
		setProcessingKey(`category-${category.id}`);
		setMessage(null);
		try {
			const response = await fetch(`/api/admin/categories/${category.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(categoryDraft),
			});
			if (!response.ok) throw new Error(await responseError(response, "分類儲存失敗。"));
			await refreshMenu();
			setMessage({ kind: "success", text: `${categoryDraft.name.trim()} 已儲存。` });
		} catch (error) {
			setMessage({ kind: "error", text: error instanceof Error ? error.message : "分類儲存失敗。" });
		} finally {
			setProcessingKey(null);
		}
	}

	async function saveOrigin(event: FormEvent) {
		event.preventDefault();
		if (processingKey !== null) return;
		setProcessingKey("origin");
		setMessage(null);
		try {
			const response = await fetch("/api/admin/store-presentation", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ originDisclosure: originDisclosure || null }),
			});
			if (!response.ok) throw new Error("來源資訊儲存失敗。");
			setMessage({ kind: "success", text: "來源資訊已儲存。" });
		} catch (error) {
			setMessage({ kind: "error", text: error instanceof Error ? error.message : "來源資訊儲存失敗。" });
		} finally {
			setProcessingKey(null);
		}
	}

	const activeCategories = menu?.categories.filter((category) => category.isActive) ?? [];

	return (
		<main className="admin-page">
			<header className="admin-header">
				<div><p>吃炸的 · Owner</p><h1>商品管理</h1><span>低頻設定；每日售罄請使用店家工作台。</span></div>
				<div className="admin-header-actions"><a href="/admin/store">店家設定</a><button type="button" onClick={() => setShowCategories((current) => !current)}>管理分類</button><button type="button" onClick={() => { setShowCreateItem(true); setCreateErrors({}); setMessage(null); }}>新增商品</button></div>
			</header>

			{message && <p className={`admin-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
			{!menu && !message && <p className="admin-message" role="status">載入中…</p>}

			{menu && <>
				{showCreateItem && <section className="admin-create-panel" aria-labelledby="create-item-heading">
					<h2 id="create-item-heading">新增商品</h2>
					<form className="admin-edit-form" noValidate onSubmit={(event) => void createItem(event)}>
						<label>商品名稱<input value={createDraft.name} maxLength={80} required onChange={(event) => setCreateDraft({ ...createDraft, name: event.target.value })} />{createErrors.name && <small className="admin-field-error">{createErrors.name}</small>}</label>
						<label>價格（TWD）<input type="number" min="0" max="100000" step="1" value={createDraft.price} required onChange={(event) => setCreateDraft({ ...createDraft, price: event.target.value })} />{createErrors.price && <small className="admin-field-error">{createErrors.price}</small>}</label>
						<label>分類<select value={createDraft.categoryId} required onChange={(event) => setCreateDraft({ ...createDraft, categoryId: event.target.value })}><option value="">請選擇分類</option>{activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{createErrors.categoryId && <small className="admin-field-error">{createErrors.categoryId}</small>}</label>
						<label>排序（選填）<input type="number" min="0" step="1" value={createDraft.sortOrder} onChange={(event) => setCreateDraft({ ...createDraft, sortOrder: event.target.value })} />{createErrors.sortOrder && <small className="admin-field-error">{createErrors.sortOrder}</small>}</label>
						<label className="admin-wide-field">描述<textarea value={createDraft.description} maxLength={240} onChange={(event) => setCreateDraft({ ...createDraft, description: event.target.value })} /></label>
						<label className="admin-wide-field">圖片 URL<input type="url" placeholder="https://…" value={createDraft.imageUrl} onChange={(event) => setCreateDraft({ ...createDraft, imageUrl: event.target.value })} /></label>
						<label className="admin-checkbox"><input type="checkbox" checked={createDraft.isPopular} onChange={(event) => setCreateDraft({ ...createDraft, isPopular: event.target.checked })} />顧客熱門標記</label>
						<label className="admin-checkbox"><input type="checkbox" checked={createDraft.isQuickSoldOut} onChange={(event) => setCreateDraft({ ...createDraft, isQuickSoldOut: event.target.checked })} />店家快速售罄</label>
						<div className="admin-form-actions"><button type="button" onClick={() => setShowCreateItem(false)}>取消</button><button type="submit" disabled={processingKey !== null || activeCategories.length === 0}>{processingKey === "create-item" ? "新增中…" : "新增商品"}</button></div>
					</form>
					<p className="admin-form-note">新商品預設販售中且未封存；客製選項建立後另行設定。</p>
				</section>}

				{showCategories && <section className="admin-category-panel" aria-labelledby="category-heading">
					<h2 id="category-heading">分類管理</h2>
					<form className="admin-new-category" onSubmit={(event) => void createCategory(event)}><label>新分類名稱<input value={newCategoryName} maxLength={80} required onChange={(event) => setNewCategoryName(event.target.value)} /></label><label>排序（選填）<input type="number" min="0" step="1" value={newCategorySortOrder} onChange={(event) => setNewCategorySortOrder(event.target.value)} /></label><button type="submit" disabled={processingKey !== null}>新增分類</button></form>
					<p className="admin-form-note">仍有未封存商品時不能停用分類，請先重新分類或封存商品。</p>
					<div className="admin-category-list">{menu.categories.map((category) => <CategoryEditor key={`${category.id}:${category.name}:${category.sortOrder}:${category.isActive}`} category={category} disabled={processingKey !== null} onSave={saveCategory} />)}</div>
				</section>}

				<section className="admin-origin" aria-labelledby="origin-heading"><div><h2 id="origin-heading">來源資訊</h2><p>每行一筆；未確認時可留空，不會顯示給顧客。</p></div><form onSubmit={saveOrigin}><textarea aria-label="來源資訊" maxLength={500} value={originDisclosure} onChange={(event) => setOriginDisclosure(event.target.value)} /><button type="submit" disabled={processingKey !== null}>儲存來源資訊</button></form></section>

				<section className="admin-menu-list" aria-label="商品清單">{menu.items.map((item) => <article className={`admin-menu-item${item.isArchived ? " archived" : ""}`} key={item.id}>
					<header><div><h2>{item.name}</h2><p>{item.categoryName} · NT$ {item.price} · {itemStatus(item)}</p></div><div className="admin-item-flags">{item.isPopular && <span>熱門</span>}{item.isQuickSoldOut && <span>快速售罄</span>}</div><button type="button" onClick={() => beginEditing(item)}>編輯</button></header>
					{editingId === item.id && draft && <form className="admin-edit-form" onSubmit={(event) => void saveItem(event, item)}>
						<label>商品名稱<input value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>價格（TWD）<input type="number" min="0" max="100000" step="1" value={draft.price} required onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></label>
						<label className="admin-wide-field">描述<textarea value={draft.description} maxLength={240} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label>分類<select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}>{activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>排序<input type="number" min="0" step="1" value={draft.sortOrder} required onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} /></label>
						<label className="admin-wide-field">圖片 URL<input type="url" placeholder="https://…" value={draft.imageUrl} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} /></label><label className="admin-checkbox"><input type="checkbox" checked={draft.isPopular} onChange={(event) => setDraft({ ...draft, isPopular: event.target.checked })} />顧客熱門標記</label><label className="admin-checkbox"><input type="checkbox" checked={draft.isQuickSoldOut} onChange={(event) => setDraft({ ...draft, isQuickSoldOut: event.target.checked })} />店家快速售罄</label><label className="admin-checkbox"><input type="checkbox" checked={draft.isArchived} onChange={(event) => setDraft({ ...draft, isArchived: event.target.checked })} />封存商品</label>
						<div className="admin-form-actions"><button type="button" onClick={() => { setEditingId(null); setDraft(null); }}>取消</button><button type="submit" disabled={processingKey !== null}>{processingKey === `item-${item.id}` ? "儲存中…" : "儲存"}</button></div>
					</form>}
					{item.modifierGroups.length > 0 ? <details className="admin-modifiers"><summary>餐點選項（唯讀）</summary>{item.modifierGroups.map((group) => <div key={group.id}><strong>{group.name}</strong><ul>{group.options.map((option) => <li key={option.id}>{option.name}{option.priceDelta ? ` +NT$ ${option.priceDelta}` : ""}</li>)}</ul></div>)}</details> : <p className="admin-no-modifiers">客製選項：尚未設定</p>}
				</article>)}</section>
			</>}
		</main>
	);
}
