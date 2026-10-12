// Measure intrinsic heights, not viewport bottoms, so repeated navigation has no drift.
export function syncCustomerStickyStack() {
	const page = document.querySelector<HTMLElement>(".customer-page");
	const header = page?.querySelector(".customer-header");
	const tabs = page?.querySelector(".category-tabs");
	const headerHeight = header?.getBoundingClientRect().height ?? 0;
	const tabsHeight = tabs?.getBoundingClientRect().height ?? 0;
	if (!page) return 0;
	for (const [name, height] of [
		["--customer-header-height", headerHeight],
		["--customer-category-nav-height", tabsHeight],
	] as const) {
		// Zero layout measurements in jsdom must not replace the CSS fallback.
		if (height > 0 && page.style.getPropertyValue(name) !== `${height}px`) {
			page.style.setProperty(name, `${height}px`);
		}
	}
	const gap = Number.parseFloat(getComputedStyle(page).getPropertyValue("--category-scroll-gap")) || 24;
	return headerHeight + tabsHeight + gap;
}
