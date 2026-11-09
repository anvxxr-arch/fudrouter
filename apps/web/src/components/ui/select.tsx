import * as React from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children" | "placeholder"> {
  options?: SelectOption[];
  /** Accessible label. When omitted the caller must supply aria-label or
   * aria-labelledby (native select semantics keep it announceable either way). */
  label?: string;
  /** Helper text; wired to the select, never read as a label. */
  hint?: string;
  /** Error text; sets aria-invalid and announces the message. */
  error?: string;
  /** Shown as the disabled hidden first option when no value is chosen. */
  placeholder?: string;
}

/**
 * A native <select> wrapped in the .select field idiom. Native on purpose:
 * opening with Enter/Space, type-to-select, the platform picker and the
 * screen-reader role all come for free, and a custom listbox buys none of
 * them back with fewer semantics. The visible styling is the .select class
 * in styles.css; the wrapper adds the label/helper/error contract.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, label, hint, error, id, placeholder, ...props }, ref) => {
    const autoId = React.useId();
    const selectId = id ?? autoId;
    const hintId = `${selectId}-hint`;
    const errId = `${selectId}-err`;
    const describedBy = [hint ? hintId : undefined, error ? errId : undefined]
      .filter(Boolean)
      .join(" ")
      .trim() || undefined;
    const cls = className ? `select ${className}` : "select";
    const hintNode = hint ? <p id={hintId} className="field-hint muted">{hint}</p> : null;
    const errNode = error ? <p id={errId} className="field-error error">{error}</p> : null;
    return (
      <div className="field">
        {label ? <label htmlFor={selectId} className="field-label">{label}</label> : null}
        <select
          id={selectId}
          ref={ref}
          className={cls}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        >
          {props.multiple ? (
            options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
          ) : (
            [<option key="" value="" disabled hidden>{placeholder ?? "Select…"}</option>,
            ...(options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)]
          )}
        </select>
        {hintNode}
        {errNode}
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
