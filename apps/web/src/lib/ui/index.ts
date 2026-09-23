/**
 * The atom barrel.
 *
 * Consumers used to reach into the file tree by name
 * (`import Button from '$lib/ui/Button.svelte'`), which means the file layout is
 * part of every call site: move or rename an atom and the change ripples across
 * the app. Import from `$lib/ui` instead — the layout becomes an implementation
 * detail.
 *
 * The `variants.ts` re-exports matter as much as the components: a caller that
 * needs the type of a prop (`ButtonVariant`) or the tone list for a `{#each}`
 * should not have to know it lives under `$lib/design`.
 */
export { default as DiscordButton } from './DiscordButton.svelte';
export { default as Alert } from './Alert.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Button } from './Button.svelte';
export { default as ButtonLink } from './ButtonLink.svelte';
export { default as Card } from './Card.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Field } from './Field.svelte';
export { default as Input } from './Input.svelte';
export { default as NavProgress } from './NavProgress.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as Select } from './Select.svelte';
export { default as StatCard } from './StatCard.svelte';
export { default as Textarea } from './Textarea.svelte';
export { default as Metric } from './Metric.svelte';
export { default as Section } from './Section.svelte';
export { default as Facts } from './Facts.svelte';
export { default as CodeBlock } from './CodeBlock.svelte';
export { default as Guide } from './Guide.svelte';
export { default as VisualDivider } from './VisualDivider.svelte';
export { default as UsageChart } from './UsageChart.svelte';

export {
	ALERT_TONES,
	BADGE_TONES,
	BUTTON_VARIANTS,
	CONTROL_SIZES,
	STAT_TONES,
	TONES,
	buttonClass,
	toneClass,
	type AlertTone,
	type ButtonVariant,
	type ControlSize,
	type StatTone,
	type Tone
} from '$lib/design/variants';
