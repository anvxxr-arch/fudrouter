/**
 * Single source of truth for every enumerated prop an atom accepts.
 *
 * These used to be declared locally in each component — `Variant` twice, `Tone`
 * twice — and they had already drifted: `Button` accepted `danger` while
 * `ButtonLink` did not, and `Badge` had a `neutral` tone that `Alert` lacked.
 * Nothing failed loudly, because two structurally identical unions are unrelated
 * types as far as TypeScript is concerned.
 *
 * Declaring each list once, as a `const` array, buys three things:
 *   1. the type is *derived* from the list, so they cannot disagree;
 *   2. `variants.test.ts` can iterate the runtime array and assert that every
 *      member has a matching CSS rule — a variant you cannot style is a bug that
 *      otherwise ships silently;
 *   3. adding a variant is one edit in one file, and the compiler points at every
 *      atom that must handle it.
 */

/** Button emphasis. `primary` is the one action worth taking on a screen. */
export const BUTTON_VARIANTS = ['primary', 'secondary', 'danger', 'ghost'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/** Control sizes, shared by buttons and form controls. */
export const CONTROL_SIZES = ['sm', 'md', 'lg'] as const;
export type ControlSize = (typeof CONTROL_SIZES)[number];

/** Semantic tone. Always paired with a word, never carried by colour alone. */
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type Tone = (typeof TONES)[number];

/** `Badge` renders every tone; `Alert` has no use for `neutral`. */
export const BADGE_TONES = TONES;
export const ALERT_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type AlertTone = (typeof ALERT_TONES)[number];

/**
 * `StatCard` accents its value for good/bad only — a KPI number reads as plain
 * text otherwise. Deliberately NOT the five-tone list: a type that accepts `info`
 * and ignores it is a lie the caller cannot see.
 */
export const STAT_TONES = ['neutral', 'success', 'danger'] as const;
export type StatTone = (typeof STAT_TONES)[number];

/** The class a tone maps to. Defined once so every tone-carrying atom agrees. */
export const toneClass = (tone: Tone) => `fr-tone-${tone}`;

/** The class set a button renders, so markup and stylesheet cannot disagree. */
export const buttonClass = (variant: ButtonVariant, size: ControlSize = 'md') =>
	`fr-btn fr-btn--${variant} fr-btn--${size}`;

/**
 * Warn when an untyped caller passes a member that does not exist.
 *
 * A prop typed as a union still accepts anything at runtime from JS, a form
 * payload or a `{...spread}`; the failure mode is an *unstyled* control, which is
 * invisible in review. Dev-only, so it costs nothing in production.
 */
export function warnUnknown(
	list: readonly string[],
	value: string,
	component: string,
	prop: string
): void {
	if (import.meta.env.DEV && !list.includes(value)) {
		console.warn(
			`${component}: unknown ${prop} "${value}" — expected one of ${list.join(', ')}. ` +
				`The element will render unstyled.`
		);
	}
}
