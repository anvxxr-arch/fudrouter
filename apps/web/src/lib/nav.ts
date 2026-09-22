import { page } from '$app/state';

/** Is this href the current page? For nav highlighting. */
export const isActive = (href: string) => page.url.pathname === href;
