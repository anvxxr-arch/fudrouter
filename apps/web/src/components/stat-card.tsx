import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";

// Moved out of routes/dashboard.tsx so the admin overview can reuse the same
// stat-card markup without lazy-loading the whole member-dashboard chunk
// (App.tsx splits the two trees separately).

export function pctDelta(now: number, prev: number): { text: string; tone: "up" | "down" | "flat" } {
	if (prev === 0) return { text: now === 0 ? "—" : "new", tone: now === 0 ? "flat" : "up" };
	const p = Math.round(((now - prev) / prev) * 100);
	if (p === 0) return { text: "0%", tone: "flat" };
	return { text: `${p > 0 ? "+" : ""}${p}%`, tone: p > 0 ? "up" : "down" };
}

const DELTA_COLOR: Record<"up" | "down" | "flat", string> = {
	up: "text-[var(--chart-1)]",
	down: "text-[var(--destructive)]",
	flat: "text-muted-foreground",
};

export function StatCard({ title, value, delta, spark, children }: { title: string; value: string; delta?: { text: string; tone: "up" | "down" | "flat" }; spark?: number[]; children?: ReactNode }) {
	const points = spark?.map((v, i) => `${((i / Math.max(spark.length - 1, 1)) * 100).toFixed(1)},${(26 - (v / Math.max(...spark, 1)) * 26).toFixed(1)}`).join(" ") ?? "";
	return (
		<Card className="flex flex-1 basis-48 flex-col gap-1 content-start">
			<CardHeader className="p-5 pb-0">
				<CardTitle className="text-base font-medium text-muted-foreground">{title}</CardTitle>
			</CardHeader>
			<CardContent className="p-5 pt-0">
				<p className="stat-figure m-0">{value}</p>
				<div className="mt-1 flex items-center justify-between gap-2">
					{delta ? <span className={cn("font-mono text-sm font-semibold tabular-nums", DELTA_COLOR[delta.tone])}>{delta.text}</span> : null}
					{spark ? (
						<svg className="ml-auto h-7 max-w-[7rem] w-full" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
							<polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground" />
						</svg>
					) : null}
				</div>
				{children}
			</CardContent>
		</Card>
	);
}
