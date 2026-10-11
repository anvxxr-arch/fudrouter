// Field Web-Vitals collector (CLS/LCP/INP/FCP/TTFB) for the landing + catalog.
// Zero dependencies: PerformanceObserver + navigation timing, sampled at 10%
// and beacons via sendBeacon to /api/metrics/vitals (best-effort, never throws).
// Lab numbers live in perf audits; THESE are the production numbers.
const SAMPLE = 0.1;
function beacon(payload: Record<string, number | string>): void {
	try {
		const body = JSON.stringify({ ...payload, path: location.pathname, at: Date.now() });
		if (navigator.sendBeacon) navigator.sendBeacon('/api/metrics/vitals', body);
	} catch { /* metrics must never break the page */ }
}
export function initVitals(): void {
	try {
		if (Math.random() > SAMPLE) return;
		let cls = 0;
		let lcp = 0;
		let inp = 0;
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		const ttfb = nav ? Math.round(nav.responseStart) : 0;
		const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
		const fcp = paint ? Math.round(paint.startTime) : 0;
		const mo = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				const entry = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean; startTime: number };
				if (e.entryType === 'layout-shift' && !entry.hadRecentInput) cls += entry.value ?? 0;
				else if (e.entryType === 'largest-contentful-paint') lcp = Math.max(lcp, Math.round(entry.startTime));
			}
		});
		mo.observe({ type: 'layout-shift', buffered: true });
		mo.observe({ type: 'largest-contentful-paint', buffered: true });
		const io = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				const entry = e as PerformanceEntry & { duration?: number };
				inp = Math.max(inp, Math.round(entry.duration ?? 0));
			}
		});
		try { io.observe({ type: 'event', buffered: true }); } catch { /* event-timing unsupported */ }
		const send = () => {
			mo.disconnect();
			try { io.disconnect(); } catch { /* ignore */ }
			beacon({ cls: Math.round(cls * 1000) / 1000, lcp, inp, fcp, ttfb });
		};
		addEventListener('pagehide', send, { once: true });
		setTimeout(send, 30000);
	} catch { /* never break the app for metrics */ }
}
