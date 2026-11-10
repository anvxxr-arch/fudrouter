import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ConsoleLayout } from "../components/ConsoleLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { checkoutKind } from "../lib/subscription-checkout";
import "./subscription.css";

// The member buys time, not tokens (owner directive 2026-10-31). The server
// endpoints (/api/pages/dashboard/subscription + checkout/claim/payments) served
// the Discord/Telegram bots, but no web page ever called them: Pricing's "Buy"
// CTA is a bare link to /login and the console had no subscription route.
// This page is that missing surface — pick a plan, pay (a Mayar checkout URL
// when the gateway is configured, otherwise the legacy static QRIS), submit
// proof, and watch the approval state move pending → claimed → confirmed.
// It reads the same endpoints the bots call, so a payment minted here or in
// Discord shows up in both places.

type Plan = { id: string; days: number; priceIdr: number };
type CurrentSub = { id: string; plan: string; expiresAt: string; priceIdr: number } | null;
type HistoryRow = { id: string; plan: string; status: string; startsAt: string | null; expiresAt: string | null; priceIdr: number };
type SubscriptionData = { plans: Plan[]; current: CurrentSub; history: HistoryRow[] };
type CheckoutResult = { gatewayRef: string; qris: string | null; checkoutUrl?: string | null; gateway?: string; amountIdr: number; plan: string; label: string };
type PaymentRow = { id: string; channel: string; gatewayRef: string; plan: string; amountIdr: number; status: string; createdAt: string };
type PaymentsData = { rows: PaymentRow[] };

// Label fallback for a plan id the table does not know (should never happen —
// the migration CHECK pins five names — but an unknown label must not blank).
const PLAN_LABEL: Record<string, string> = {
	sub_1d: "1 Day",
	sub_3d: "3 Days",
	sub_7d: "7 Days",
	sub_14d: "14 Days",
	sub_28d: "28 Days",
};

// Approval state → badge tones: pending is informational, claimed is the
// "waiting on an admin" step, confirmed/rejected are the terminal states.
const PAYMENT_BADGE: Record<string, { tone: "default" | "ok" | "warn" | "info" | "danger"; label: string }> = {
	pending: { tone: "info", label: "Awaiting payment" },
	claimed: { tone: "warn", label: "Proof submitted" },
	confirmed: { tone: "ok", label: "Confirmed" },
	rejected: { tone: "danger", label: "Rejected" },
};

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 });
function fmtIdr(n: number): string {
	return idr.format(n);
}

// The shared apiGet/apiPost throw "path: status", discarding the server's {error}
// the operator actually needs ("Unknown plan", "Payment not found"). These two
// page-local helpers keep that body; session/auth stays lib/server.ts's job.
async function http<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { credentials: "include", ...init });
	const data = (await res.json().catch(() => null)) as { error?: string } | null;
	if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
	return data as T;
}

function fmtDate(v: string | null | undefined): string {
	if (!v) return "—";
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function SubscriptionHome() {
	const [tick, setTick] = useState(0);
	const [sub, setSub] = useState<SubscriptionData | null>(null);
	const [payments, setPayments] = useState<PaymentsData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// One checkout at a time: buying a plan mints a pending payment and shows the
	// QRIS payload inline. A claimed proof is followed by a reload so the payment
	// table and the current-window card both re-read the server.
	const [checkout, setCheckout] = useState<CheckoutResult | null>(null);
	const [busyPlan, setBusyPlan] = useState<string | null>(null);
	const [checkoutErr, setCheckoutErr] = useState<string | null>(null);
	const [proofUrl, setProofUrl] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [claimErr, setClaimErr] = useState<string | null>(null);
	const [claimOk, setClaimOk] = useState(false);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let live = true;
		setLoading(true);
		Promise.all([
			http<SubscriptionData>("/api/pages/dashboard/subscription"),
			http<PaymentsData>("/api/pages/dashboard/subscription/payments"),
		])
			.then(([s, p]) => {
				if (!live) return;
				setSub(s);
				setPayments(p);
				setError(null);
			})
			.catch((e) => { if (live) setError(e instanceof Error ? e.message : "Failed to load"); })
			.finally(() => { if (live) setLoading(false); });
		return () => { live = false; };
	}, [tick]);

	const buy = (planId: string) => {
		setBusyPlan(planId);
		setCheckoutErr(null);
		setCheckout(null);
		setProofUrl("");
		setClaimOk(false);
		http<CheckoutResult>("/api/pages/dashboard/subscription/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan: planId, channel: "web" }),
		})
			.then((r) => setCheckout(r))
			.catch((e) => setCheckoutErr(e instanceof Error ? e.message : "Checkout failed"))
			.finally(() => setBusyPlan(null));
	};

	const claim = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!checkout) return;
		setClaiming(true);
		setClaimErr(null);
		setClaimOk(false);
		http<{ claimed: boolean }>("/api/pages/dashboard/subscription/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ gatewayRef: checkout.gatewayRef, proofUrl }),
		})
			.then(() => {
				setClaimOk(true);
				setCheckout(null);
				setProofUrl("");
				setTick((t) => t + 1);
			})
			.catch((ex) => setClaimErr(ex instanceof Error ? ex.message : "Could not submit proof"))
			.finally(() => setClaiming(false));
	};

	const copy = async () => {
		if (!checkout?.qris) return;
		try {
			await navigator.clipboard?.writeText(checkout.qris);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch { /* clipboard unavailable: the string is on screen to select */ }
	};
	const kind = checkoutKind(checkout);

	const current = sub?.current ?? null;

	return (
		<div className="stack">
			<div className="dash-head">
				<div className="dash-head-text">
					<h1>Subscription</h1>
					<p className="lede muted">Buy time, not tokens. Pay by QRIS, submit proof, and an admin confirms it.</p>
				</div>
			</div>

			{loading ? <p className="muted" role="status" aria-live="polite">Loading…</p> : null}
			{error ? <p className="error" role="alert">{error}</p> : null}

			{sub ? (
				<>
					<section aria-labelledby="sub-status">
						<h2 id="sub-status">Your access</h2>
						<Card title="Current plan">
							{current ? (
								<p className="sub-status">
									<Badge tone="ok">Active</Badge>
									<span className="sub-status-text">{PLAN_LABEL[current.plan] ?? current.plan} until {fmtDate(current.expiresAt)}</span>
								</p>
							) : (
								<div className="sub-empty">
									<p className="muted">No active plan — buy time below to serve requests.</p>
									<Link to="/dashboard/keys">Mint a key after your plan is confirmed</Link>
								</div>
							)}
						</Card>
					</section>

					<section aria-labelledby="sub-plans">
						<h2 id="sub-plans">Buy time</h2>
						<ol className="sub-steps" aria-label="How buying time works">
							<li>Pick a plan and pay the QRIS code.</li>
							<li>Send your payment proof back.</li>
							<li>An admin confirms it — your window starts.</li>
						</ol>
						<div className="sub-plans">
							{(sub.plans ?? []).map((p) => (
								<Card key={p.id} title={PLAN_LABEL[p.id] ?? p.id} desc={fmtIdr(p.priceIdr)} className="sub-plan">
									<p className="sub-plan-meta">{p.days} day{p.days === 1 ? "" : "s"} of access</p>
									<Button variant="secondary" disabled={busyPlan === p.id} onClick={() => buy(p.id)}>
										{busyPlan === p.id ? "Preparing…" : `Pay ${fmtIdr(p.priceIdr)}`}
									</Button>
								</Card>
							))}
						</div>
						{checkoutErr ? <p className="error" role="alert">{checkoutErr}</p> : null}
					</section>

					{checkout ? (
						<Card title={`Pay ${checkout.label} — ${fmtIdr(checkout.amountIdr)}`} aria-live="polite">
							{kind === "mayar" && checkout.checkoutUrl ? (
								<div className="sub-mayar">
									<p className="muted">Complete your payment on the secure Mayar checkout page, then submit your proof below.</p>
									<Button asChild variant="primary" className="sub-mayar-cta">
										<a
											href={checkout.checkoutUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											Continue to checkout
											<span className="sr-only"> (opens in a new tab)</span>
										</a>
									</Button>
								</div>
							) : kind === "qris" && checkout.qris ? (
								<div className="sub-qris">
									<code>{checkout.qris}</code>
									<Button size="sm" variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy code"}</Button>
								</div>
							) : null}
							{kind === "qris" && checkout.qris ? (
								<p className="muted">Scan this QRIS string in your e-wallet or banking app, then submit your proof.</p>
							) : null}
							<form className="sub-claim" onSubmit={claim}>
								<label className="sub-claim-label" htmlFor="proof-url">Payment proof URL</label>
								<div className="row">
									<Input
										id="proof-url"
										name="proofUrl"
										type="url"
										inputMode="url"
										placeholder="https://… (link to your screenshot)"
										value={proofUrl}
										onChange={(e) => setProofUrl(e.currentTarget.value)}
										required
									/>
									<Button type="submit" disabled={claiming}>{claiming ? "Submitting…" : "I've paid — submit proof"}</Button>
								</div>
							</form>
							{claimOk ? <p className="sub-ok" role="status">Proof submitted — an admin will confirm your payment.</p> : null}
							{claimErr ? <p className="error" role="alert">{claimErr}</p> : null}
						</Card>
					) : null}

					<section aria-labelledby="sub-payments">
						<h2 id="sub-payments">Payments</h2>
						{payments && payments.rows.length === 0 ? (
							<p className="muted">No payments yet — your QRIS payments and approval status appear here.</p>
						) : (
							<div className="table-wrap">
								<div className="table-scroll">
									<table className="fr">
										<caption className="sub-caption">Your QRIS payments and their approval status</caption>
										<thead className="fr-thead">
											<tr className="fr-tr">
												<th scope="col" className="fr-th">Date</th>
												<th scope="col" className="fr-th">Plan</th>
												<th scope="col" className="fr-th fr-num">Amount</th>
												<th scope="col" className="fr-th">Status</th>
											</tr>
										</thead>
										<tbody className="fr-tbody">
											{(payments?.rows ?? []).map((r) => {
												const st = PAYMENT_BADGE[r.status] ?? { tone: "default" as const, label: r.status };
												return (
													<tr className="fr-tr" key={r.id}>
														<td className="fr-td">{fmtDate(r.createdAt)}</td>
														<td className="fr-td">{PLAN_LABEL[r.plan] ?? r.plan}</td>
														<td className="fr-td fr-num">{fmtIdr(r.amountIdr)}</td>
														<td className="fr-td"><Badge tone={st.tone}>{st.label}</Badge></td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							</div>
						)}
					</section>
				</>
			) : null}
		</div>
	);
}

export function SubscriptionPage() {
	return <ConsoleLayout><SubscriptionHome /></ConsoleLayout>;
}
