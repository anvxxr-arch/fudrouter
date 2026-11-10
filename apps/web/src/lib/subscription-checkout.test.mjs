// subscription-checkout.test.mjs — the checkout response-shape discriminator.
//
// Why this file exists: checkout/claim is the only money-collecting surface in
// the web console, and the server (apps/web/server/pages.mjs) returns TWO shape
// branches depending on whether MAYYAR_API_KEY is set. The Mayar branch carries
// `checkoutUrl` + `qris:null` + `gateway:'mayar'`; the legacy fallback carries
// `qris` and no `checkoutUrl`. A regression that renders the wrong branch here
// either shows an empty copy box or hides the pay link — invisible at runtime to
// any other gate in the repo, because the integration suite does not exercise
// this client path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutKind } from './subscription-checkout.ts';

test('mayar shape (checkoutUrl set, qris null) is mayar', () => {
  assert.equal(
    checkoutKind({ gatewayRef: 'pay_1', checkoutUrl: 'https://pay.mayar.id/x', qris: null, gateway: 'mayar' }),
    'mayar'
  );
});

test('legacy shape (qris string, no checkoutUrl) is qris', () => {
  assert.equal(
    checkoutKind({ gatewayRef: 'qris_web_1', qris: '00020101...', amountIdr: 90000 }),
    'qris'
  );
});

test('checkoutUrl wins even when qris is also present', () => {
  assert.equal(
    checkoutKind({ checkoutUrl: 'https://pay.mayar.id/x', qris: '00020101...' }),
    'mayar'
  );
});

test('mayar shape with an empty qris string is still mayar', () => {
  assert.equal(
    checkoutKind({ gatewayRef: 'pay_1', checkoutUrl: 'https://pay.mayar.id/x', qris: '', gateway: 'mayar' }),
    'mayar'
  );
});

test('a null payload carries no artefact', () => {
  assert.equal(checkoutKind(null), null);
  assert.equal(checkoutKind(undefined), null);
});

test('an empty-string checkoutUrl and empty-string qris carry no artefact', () => {
  assert.equal(checkoutKind({ checkoutUrl: '', qris: '' }), null);
});