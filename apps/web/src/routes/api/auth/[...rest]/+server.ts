import { auth } from '$lib/server/auth';
import { toSvelteKitHandler } from 'better-auth/svelte-kit';

export const GET = toSvelteKitHandler(auth);
export const POST = toSvelteKitHandler(auth);
export const PATCH = toSvelteKitHandler(auth);
export const PUT = toSvelteKitHandler(auth);
export const DELETE = toSvelteKitHandler(auth);
