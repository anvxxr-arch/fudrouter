import * as React from "react";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many shimmer lines to stack. 1 by default; a list/table skeleton
   * passes N and lets CSS space them on the 4px rhythm. */
  lines?: number;
}

/**
 * Loading placeholder. The element is aria-hidden (it is decoration); the
 * accessing text comes from the caller's role="status" container (see
 * guards.tsx), so a screen reader hears the state while a sighted user sees
 * the shape of the page before the data lands. The shimmer lives in
 * styles/motion.css (fee-motion) and is switched off for reduced motion. */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, lines = 1, style, ...props }, ref) => {
    const count = Math.max(1, Math.min(lines, 8));
    return (
      <div
        ref={ref}
        className={className ? `skeleton ${className}` : "skeleton"}
        aria-hidden="true"
        data-slot="skeleton"
        {...props}
      >
        {React.useMemo(
          () =>
            Array.from({ length: count }, (_, i) => (
              <span className="skeleton-line" style={{ width: i === count - 1 && count > 1 ? "68%" : undefined }} key={i} />
            )),
          [count],
        )}
      </div>
    );
  },
);
Skeleton.displayName = "Skeleton";

export { Skeleton };
