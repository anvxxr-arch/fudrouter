import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	SELECTABLE_STRATEGIES,
	SMART_INTENT,
	STRATEGIES,
	constraintsFromForm,
	parsePolicyForm,
	policyToFormValues,
	weightsFromForm,
	type PolicyFormGetter,
	type PolicyFormValues
} from './routing-form';

/** The page's submit → parse contract: form seed → one entry per field name. */
function getterFrom(v: Partial<Record<string, string | boolean>>): PolicyFormGetter {
	return (key) => {
		const value = v[key];
		if (value === undefined || value === null) return null;
		return typeof value === 'boolean' ? (value ? 'on' : null) : value;
	};
}

/** Form seed → the exact field names the <form> posts. */
function fieldsFrom(values: PolicyFormValues): Partial<Record<string, string | boolean>> {
	return {
		name: values.name,
		strategy: values.strategy,
		enabled: values.enabled,
		max_attempts: values.maxAttempts,
		request_timeout_ms: values.requestTimeoutMs,
		fallback_enabled: values.fallbackEnabled,
		provider_order: values.providerOrder.join('\n'),
		model_order: values.modelOrder.join('\n'),
		max_input_price_micro: values.constraints.maxInputPriceMicro,
		max_output_price_micro: values.constraints.maxOutputPriceMicro,
		max_p95_latency_ms: values.constraints.maxP95LatencyMs,
		min_availability: values.constraints.minAvailability,
		allowed_providers: values.constraints.allowedProviders,
		blocked_providers: values.constraints.blockedProviders,
		region_preference: values.constraints.regionPreference,
		weight_price: values.weights.price,
		weight_latency: values.weights.latency,
		weight_reliability: values.weights.reliability,
		weight_capacity: values.weights.capacity
	};
}

/** row → form → row must be the identity on stored values. */
function roundTrip(row: Parameters<typeof policyToFormValues>[0]) {
	const result = parsePolicyForm(getterFrom(fieldsFrom(policyToFormValues(row))));
	if (!result.ok) throw new Error(`round-trip failed: ${result.error}`);
	return result.values;
}

const fullRow = {
	name: 'prod priority',
	strategy: 'weighted',
	enabled: false,
	maxAttempts: 4,
	requestTimeoutMs: 125000,
	fallbackEnabled: false,
	providerPreferences: { order: ['openai', 'anthropic', 'google'], weights: { openai: 0.7 } },
	modelPreferences: { order: ['gpt-5', 'claude-4'] },
	constraints: {
		max_input_price_micro: 25_500_000,
		max_output_price_micro: 75_000_000,
		max_p95_latency_ms: 2500,
		min_availability: 0.99,
		allowed_providers: ['openai', 'google'],
		blocked_providers: ['some-vendor'],
		region_preference: 'eu-west-1'
	},
	weights: { price: 40, latency: 30, reliability: 20, capacity: 10 }
};

describe('STRATEGIES', () => {
	it('declares the 8 selectable strategies plus smart', () => {
		expect(STRATEGIES.map((s) => s.id)).toEqual([
			'balanced',
			'lowest_cost',
			'lowest_latency',
			'highest_reliability',
			'provider_priority',
			'weighted',
			'round_robin',
			'random',
			'smart'
		]);
		expect(SELECTABLE_STRATEGIES.map((s) => s.id)).toHaveLength(8);
	});

	it('disables smart with its PRD §30 intent text', () => {
		const smart = STRATEGIES.find((s) => s.id === 'smart')!;
		expect(smart.disabled).toBe(true);
		expect(smart.intent).toBe(SMART_INTENT);
		expect(SMART_INTENT).toBe('Smart routing — learns from outcomes; coming soon');
		for (const s of STRATEGIES) if (s.id !== 'smart') expect(s.disabled).toBe(false);
	});
});

describe('round-trip (PRD §32)', () => {
	it('round-trips every field, all 7 constraint keys and all 4 weight keys', () => {
		const out = roundTrip(fullRow);
		expect(out.name).toBe('prod priority');
		expect(out.strategy).toBe('weighted');
		expect(out.enabled).toBe(false);
		expect(out.maxAttempts).toBe(4);
		expect(out.requestTimeoutMs).toBe(125000);
		expect(out.fallbackEnabled).toBe(false);
		// `weights` inside provider_preferences is NOT form-managed: it must not
		// survive the form, while the order list does.
		expect(out.providerPreferences).toEqual({ order: ['openai', 'anthropic', 'google'] });
		expect(out.modelPreferences).toEqual({ order: ['gpt-5', 'claude-4'] });
		expect(out.constraints).toEqual({
			max_input_price_micro: 25_500_000,
			max_output_price_micro: 75_000_000,
			max_p95_latency_ms: 2500,
			min_availability: 0.99,
			allowed_providers: ['openai', 'google'],
			blocked_providers: ['some-vendor'],
			region_preference: 'eu-west-1'
		});
		expect(out.weights).toEqual({ price: 40, latency: 30, reliability: 20, capacity: 10 });
	});

	it('round-trips price constraints exactly — money never touches a float', () => {
		const out = roundTrip({
			...fullRow,
			constraints: { max_input_price_micro: 1, max_output_price_micro: 99_999_999_999_999 }
		});
		expect(out.constraints.max_input_price_micro).toBe(1);
		expect(out.constraints.max_output_price_micro).toBe(99_999_999_999_999);
		// The decimal form a user typed normalizes (12.50 → "12.5") but is
		// numerically identical — 12_500_000 micros.
		const values = policyToFormValues({
			...fullRow,
			constraints: { max_input_price_micro: 12_500_000 }
		});
		expect(values.constraints.maxInputPriceMicro).toBe('12.5');
		const again = parsePolicyForm(getterFrom(fieldsFrom(values)));
		expect(again.ok && again.values.constraints.max_input_price_micro).toBe(12_500_000);
	});

	it('keeps omitted-empty semantics (missing ≠ zero) through the form', () => {
		const out = roundTrip({
			...fullRow,
			constraints: {},
			weights: {},
			providerPreferences: {},
			modelPreferences: {}
		});
		expect(out.constraints).toEqual({});
		expect(out.weights).toEqual({});
		expect(out.providerPreferences).toEqual({ order: [] });
		expect(out.modelPreferences).toEqual({ order: [] });
		// Explicit zeroes are kept — they are claims, unlike empty fields.
		const zero = roundTrip({
			...fullRow,
			constraints: { max_input_price_micro: 0, min_availability: 0 },
			weights: { price: 0 }
		});
		expect(zero.constraints).toEqual({ max_input_price_micro: 0, min_availability: 0 });
		expect(zero.weights).toEqual({ price: 0 });
	});
});

describe('parsePolicyForm validation', () => {
	const valid = fieldsFrom(policyToFormValues(fullRow));
	const parse = (patch: Partial<Record<string, string | boolean>>) =>
		parsePolicyForm(getterFrom({ ...valid, ...patch }));

	it('accepts the boundary values', () => {
		expect(parse({ max_attempts: '1', request_timeout_ms: '1000' }).ok).toBe(true);
		expect(parse({ max_attempts: '8', request_timeout_ms: '600000' }).ok).toBe(true);
		expect(parse({ weight_price: '0', weight_latency: '100' }).ok).toBe(true);
	});

	it('rejects out-of-range and non-integer numbers', () => {
		expect(parse({ max_attempts: '0' })).toEqual({ ok: false, error: 'Max attempts must be between 1 and 8' });
		expect(parse({ max_attempts: '9' }).ok).toBe(false);
		expect(parse({ max_attempts: '2.5' }).ok).toBe(false);
		expect(parse({ request_timeout_ms: '999' }).ok).toBe(false);
		expect(parse({ request_timeout_ms: '600001' }).ok).toBe(false);
		expect(parse({ weight_price: '101' }).ok).toBe(false);
		expect(parse({ weight_latency: '-1' }).ok).toBe(false);
		expect(parse({ weight_capacity: '50.5' }).ok).toBe(false);
	});

	it('defaults empty numeric fields to the PRD §139 defaults', () => {
		const out = parse({ max_attempts: '', request_timeout_ms: '' });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.values.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
			expect(out.values.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
		}
	});

	it('requires a name and a known, enabled strategy', () => {
		expect(parse({ name: '  ' })).toEqual({ ok: false, error: 'Name is required' });
		expect(parse({ strategy: 'telepathy' })).toEqual({ ok: false, error: 'Unknown routing strategy' });
		expect(parse({ strategy: 'smart' })).toEqual({ ok: false, error: SMART_INTENT });
	});

	it('reads checkboxes as presence, not values', () => {
		expect(parse({ enabled: 'on', fallback_enabled: 'on' }).ok).toBe(true);
		const off = parse({});
		expect(off.ok && off.values.enabled).toBe(false);
		expect(off.ok && off.values.fallbackEnabled).toBe(false);
	});

	it('rejects malformed constraint values', () => {
		expect(parse({ max_input_price_micro: '12.3456789' }).ok).toBe(false);
		expect(parse({ max_output_price_micro: '-1' }).ok).toBe(false);
		expect(parse({ max_p95_latency_ms: '2.5' }).ok).toBe(false);
		expect(parse({ min_availability: '1.5' }).ok).toBe(false);
		expect(parse({ min_availability: '-0.1' }).ok).toBe(false);
		expect(parse({ min_availability: 'abc' }).ok).toBe(false);
	});

	it('rejects a price that cannot be an exact safe-integer of micros', () => {
		const out = parse({ max_input_price_micro: '9999999999999999' });
		expect(out.ok).toBe(false);
	});
});

describe('constraintsFromForm / weightsFromForm', () => {
	const emptyConstraints: PolicyFormValues['constraints'] = {
		maxInputPriceMicro: '',
		maxOutputPriceMicro: '',
		maxP95LatencyMs: '',
		minAvailability: '',
		allowedProviders: '',
		blockedProviders: '',
		regionPreference: ''
	};
	const emptyWeights: PolicyFormValues['weights'] = {
		price: '',
		latency: '',
		reliability: '',
		capacity: ''
	};

	it('omits every empty constraint and weight', () => {
		expect(constraintsFromForm(emptyConstraints)).toEqual({});
		expect(weightsFromForm(emptyWeights)).toEqual({});
	});

	it('parses slug lists from lines or commas, order preserved, de-duplicated', () => {
		const out = constraintsFromForm({
			...emptyConstraints,
			allowedProviders: ' openai\nanthropic, openai\ngoogle ',
			blockedProviders: 'bad-actor'
		});
		expect(out).toEqual({
			allowed_providers: ['openai', 'anthropic', 'google'],
			blocked_providers: ['bad-actor']
		});
	});

	it('converts decimal prices to micros with bigint arithmetic', () => {
		const out = constraintsFromForm({
			...emptyConstraints,
			maxInputPriceMicro: '0.000001',
			maxOutputPriceMicro: '75'
		});
		expect(out).toEqual({ max_input_price_micro: 1, max_output_price_micro: 75_000_000 });
	});

	it('returns the first error as a string', () => {
		const out = constraintsFromForm({ ...emptyConstraints, minAvailability: '2' });
		expect(typeof out).toBe('string');
	});
});
