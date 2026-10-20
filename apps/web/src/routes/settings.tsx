import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConsoleLayout, useShell } from "../components/ConsoleLayout";

function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="stack"><h1>{title}</h1><p className="lede muted">{lede}</p>{children}</div>);
}

// Hub only: every card links to a surface that already exists. The project
// sub-pages need the shell's current project; without one the card points at
// the dashboard so the member can pick a project first.
export function SettingsHub() {
  const shell = useShell();
  const pid = shell?.projectId ?? null;
  const projectCard = (label: string, sub: string, desc: string) => ({
    label,
    to: pid ? `/dashboard/projects/${pid}/${sub}` : "/dashboard",
    desc: pid ? desc : "Pick a project first",
  });
  const cards = [
    { label: "General", to: "/dashboard/workspace", desc: "Workspace name, slug and status" },
    { label: "Account", to: "/dashboard/account", desc: "Your name, email and timezone" },
    { label: "Team", to: "/dashboard/team/members", desc: "Members, roles and invitations" },
    { label: "Billing", to: "/dashboard/billing", desc: "Balance, thresholds and credits" },
    { label: "Payment methods", to: "/dashboard/billing/payment-methods", desc: "How you intend to pay" },
    { label: "Invoices", to: "/dashboard/billing/invoices", desc: "Generate and settle invoices" },
    projectCard("Project routing", "routing", "Routing policies and strategies"),
    projectCard("Project limits", "limits", "Rate and spend limits"),
    projectCard("Project aliases", "aliases", "Stable model aliases"),
  ];
  return (<ConsoleLayout><Page title="Settings" lede="Workspace, account, team, billing and project surfaces.">
    <div className="cat-grid">
      {cards.map((c) => (
        <Link key={c.label} className="cat-card" to={c.to}>
          <strong>{c.label}</strong>
          <span className="muted">{c.desc}</span>
        </Link>
      ))}
    </div>
  </Page></ConsoleLayout>);
}
