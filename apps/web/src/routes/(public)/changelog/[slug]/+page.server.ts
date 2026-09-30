import type { PageServerLoad } from './$types';
import { changelogEntry } from '$lib/server/changelog';
import { publicError } from '$lib/server/public-error';
// The slug is the entry's filename. Unknown slug is a 404 with the four
// answers — a changelog link out of date is a normal occurrence, not a crash.
export const load: PageServerLoad = ({ params }) => {
	const entry = changelogEntry(params.slug);
	if (!entry) {
		throw publicError(404, 'Entry not found', {
			why: `No changelog entry matches “${params.slug}”.`,
			action: 'Browse the changelog index for the entry you want.'
		});
	}
	return { entry };
};
