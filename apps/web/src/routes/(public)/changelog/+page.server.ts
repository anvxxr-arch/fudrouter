import type { PageServerLoad } from './$types';
import { changelog } from '$lib/server/changelog';
// One entry per shipped release, newest first. The folder docs/changelog/*.md
// is the source of truth (not system_event): entries ship with their code and
// never mutate afterwards.
export const load: PageServerLoad = () => ({ entries: changelog() });
