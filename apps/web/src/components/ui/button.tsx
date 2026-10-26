import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  // The vocabulary is what callers actually use. `outline`, `link`, `lg` and
  // `icon` were declared (and styled in styles.css) with zero call sites — a
  // component API offering four controls nothing renders. Re-add one with its
  // CSS when a caller needs it.
  variant?: "default" | "primary" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "md";
  asChild?: boolean;
}

/**
 * Maps the legacy variant/size vocabulary onto the bespoke semantic classes in
 * styles.css. `default` and `primary` render identically (both are the orange
 * filled control), matching the previous inline-style override behaviour.
 */
export function variantClass(
  variant: ButtonProps["variant"],
  size: ButtonProps["size"],
): string {
  const v = variant ?? "default";
  const s = size ?? "default";
  const variantName = v === "default" ? "primary" : v;
  const sizeName = s === "default" ? "md" : s;
  return `btn btn-${variantName} btn-${sizeName}`;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={className ? `${variantClass(variant, size)} ${className}` : variantClass(variant, size)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button };
