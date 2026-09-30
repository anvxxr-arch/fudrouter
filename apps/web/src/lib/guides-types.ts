/**
 * Guide shapes — the contract every audience file satisfies.
 *
 * Lives on its own so `$lib/guides/public`, `member` and `admin` can each import
 * the type without importing each other (they cannot import the index that
 * composes them — that would be a cycle).
 */
export type GuideFact = { term: string; detail: string };
export type GuideSection = {
	title: string;
	lede?: string;
	paragraphs?: readonly string[];
	facts?: readonly GuideFact[];
};
export type GuideAudience = 'public' | 'member' | 'admin';
export type Guide = {
	audience: GuideAudience;
	sections: readonly GuideSection[];
};
