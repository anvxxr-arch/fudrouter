/**
 * Explanatory copy for every control-plane page.
 *
 * The copy itself is split by audience — `$lib/guides/public`, `member`, `admin`
 * — because the three surfaces have nothing to say to each other and editing the
 * marketing landing should not mean scrolling past 500 lines of admin console
 * notes. This module composes them back into the one map `<Guide>` reads.
 *
 * Adding a page: one entry in the file for its audience, plus one
 * `<Guide id="...">` tag at the call site. `guides.test.ts` fails the build on an
 * id that does not resolve, so a typo cannot ship a blank explanation.
 *
 * Rules for an entry:
 * - Say only what the code actually does. No invented limits, credits, or SLAs.
 * - A fact's term is a label; its detail is a value. Do not shout the value.
 * - Keep it short enough that an operation page still leads with its form.
 */
import { ADMIN_GUIDES } from './guides/admin';
import { MEMBER_GUIDES } from './guides/member';
import { PUBLIC_GUIDES } from './guides/public';
import type { Guide } from './guides-types';

export type { Guide, GuideAudience, GuideFact, GuideSection } from './guides-types';

/** Every guide, keyed by the id a page passes to `<Guide>`. */
export const GUIDES = {
	...PUBLIC_GUIDES,
	...MEMBER_GUIDES,
	...ADMIN_GUIDES
} satisfies Record<string, Guide>;

export type GuideId = keyof typeof GUIDES;

export function guideFor(id: GuideId): Guide {
	return GUIDES[id];
}
