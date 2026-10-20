import type { ReactNode } from "react";
import { Card } from "./ui/card";

// Moved out of routes/dashboard.tsx so the admin overview can reuse the same
// stat-card markup without lazy-loading the whole member-dashboard chunk
// (App.tsx splits the two trees separately). The .stat-* classes live in
// routes/dashboard.css, which both pages import.

export function pctDelta(now: number, prev: number): { text: string; tone: "up" | "down" | "flat" } {
	if (prev === 0) return { text: now === 0 ? "—" : "new", tone: now === 0 ? "flat" : "up" };
	const p = Math.round(((now - prev) / prev) * 100);
	if (p === 0) return { text: "0%", tone: "flat" };
	return { text: `${p > 0 ? "+" : ""}${p}%`, tone: p > 0 ? "up" : "down" };
}

export function StatCard({ title, value, delta, spark, children }: { title: string; value: string; delta?: { text: string; tone: "up" | "down" | "flat" }; spark?: number[]; children?: ReactNode }) {
	const points = spark?.map((v, i) => `${((i / Math.max(spark.length - 1, 1)) * 100).toFixed(1)},${(26 - (v / Math.max(...spark, 1)) * 26).toFixed(1)}`).join(" ") ?? "";
	return (<Card titleAs="h2" title={title} className="stat-card">
		<p className="stat-value num">{value}</p>
		<div className="row stat-foot">
			{delta ? <span className={`stat-delta stat-delta--${delta.tone}`}>{delta.text}</span> : null}
			{spark ? <svg className="stat-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg> : null}
		</div>
		{children}
	</Card>);
}
