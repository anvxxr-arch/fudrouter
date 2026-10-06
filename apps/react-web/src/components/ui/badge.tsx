import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        ok: "border-transparent shadow",
        warn: "border-transparent shadow",
        info: "border-transparent shadow",
        danger: "border-transparent shadow",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

type Tone = "default" | "ok" | "warn" | "info" | "danger";

const TONE_STYLE: Record<Tone, { border: string; color: string }> = {
  default: { border: "var(--color-text-muted)", color: "var(--color-text-muted)" },
  ok: { border: "var(--color-success)", color: "var(--color-success)" },
  warn: { border: "var(--warning)", color: "var(--warning)" },
  info: { border: "var(--color-info)", color: "var(--color-info)" },
  danger: { border: "var(--color-danger)", color: "var(--color-danger)" },
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  tone?: Tone;
}

function Badge({ className, variant, tone = "default", style, ...props }: BadgeProps) {
  const t = TONE_STYLE[tone];
  return (
    <div
      className={cn(badgeVariants({ variant: variant ?? tone }), className)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 var(--space-sm)",
        borderRadius: "var(--radius-pill)",
        border: `1px solid ${t.border}`,
        color: t.color,
        fontSize: "var(--text-caption)",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        ...style,
      }}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
