import type { SubmitFunction } from '@sveltejs/kit';

/**
 * `use:enhance` submit handler that flips a pending flag around the request.
 *
 * Without it a form POST looks like nothing happened: the button stays enabled and
 * the page sits still until the server answers. With it the caller can disable the
 * button and set `aria-busy`, so both sighted and screen-reader users get told the
 * work is in flight.
 *
 *   let pending = $state(false);
 *   <form method="POST" use:enhance={withPending((v) => (pending = v))}>
 *     <Button type="submit" pending={pending}>Save</Button>
 *
 * The flag is cleared after `update()`, which also handles a redirect returned by
 * the action (the component unmounts, so a stale `true` cannot leak).
 */
export function withPending(setPending: (value: boolean) => void): SubmitFunction {
	return () => {
		setPending(true);
		return async ({ update }) => {
			await update();
			setPending(false);
		};
	};
}
