import { describe, expect, it } from 'vitest';
import { bodiesForDisplay, contentCaptureAllowed } from './admin-retention';

describe('contentCaptureAllowed', () => {
	it('is true only for an explicit positive window', () => {
		expect(contentCaptureAllowed({ request_content_days: 7 })).toBe(true);
	});
	it('is false when content capture is off', () => {
		expect(contentCaptureAllowed({ request_content_days: 0 })).toBe(false);
	});
	it('fails closed on a missing or malformed policy', () => {
		expect(contentCaptureAllowed(null)).toBe(false);
		expect(contentCaptureAllowed(undefined)).toBe(false);
		expect(contentCaptureAllowed({})).toBe(false);
		expect(contentCaptureAllowed({ request_content_days: null })).toBe(false);
		expect(contentCaptureAllowed({ request_content_days: NaN })).toBe(false);
		expect(contentCaptureAllowed({ request_content_days: -3 })).toBe(false);
	});
});

describe('bodiesForDisplay', () => {
	const row = { requestBody: 'USER PROMPT', responseBody: 'MODEL OUTPUT' };
	it('hides the request and response bodies when content capture is off', () => {
		const view = bodiesForDisplay(row, { request_content_days: 0 });
		expect(view.contentRetained).toBe(false);
		expect(view.requestBody).toBeNull();
		expect(view.responseBody).toBeNull();
	});
	it('hides bodies even when the row still carries them under an old policy', () => {
		const view = bodiesForDisplay(row, null);
		expect(view.contentRetained).toBe(false);
		expect(view.requestBody).toBeNull();
		expect(view.responseBody).toBeNull();
	});
	it('shows the bodies under an opt-in retention policy', () => {
		const view = bodiesForDisplay(row, { request_content_days: 30 });
		expect(view.contentRetained).toBe(true);
		expect(view.requestBody).toBe('USER PROMPT');
		expect(view.responseBody).toBe('MODEL OUTPUT');
	});
});
