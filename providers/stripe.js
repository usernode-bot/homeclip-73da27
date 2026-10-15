// Stripe adapter — the only provider implemented, used with TEST (sandbox)
// keys only. Card entry happens on Stripe's hosted checkout page; this app
// never sees or stores card numbers, just session references and amounts.
//
// Uses the plain REST API over fetch so the app keeps its three runtime
// dependencies (express, pg, jsonwebtoken). IDR is a zero-decimal currency
// in Stripe: `unit_amount` is whole rupiah.
const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com';

async function request(method, path, params) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Stripe request failed (${res.status})`);
    err.code = 'stripe_error';
    throw err;
  }
  return data;
}

// One Checkout Session for a plan at a (possibly coupon-discounted) price in
// rupiah. The interval makes Stripe charge again on the plan's schedule; the
// metadata carries what `fulfillCheckout` needs to activate the subscription
// idempotently when the session completes.
async function createCheckout({ plan, amountIdr, origin, userId, paymentId }) {
  const params = {
    mode: 'subscription',
    client_reference_id: String(paymentId),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'idr',
    'line_items[0][price_data][unit_amount]': String(amountIdr),
    'line_items[0][price_data][recurring][interval]': plan.interval.unit,
    'line_items[0][price_data][product_data][name]': `HomeClip VIP - ${plan.name}`,
    success_url: `${origin}/tracker/vip/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/vip`,
    'metadata[payment_id]': String(paymentId),
    'metadata[user_id]': String(userId),
    'metadata[plan_id]': plan.id,
  };
  if (plan.interval.count > 1) {
    params['line_items[0][price_data][recurring][interval_count]'] = String(plan.interval.count);
  }
  const session = await request('POST', '/v1/checkout/sessions', params);
  return { url: session.url, sessionId: session.id };
}

async function retrieveSession(sessionId) {
  return request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// Stripe's signature header is `t=<ts>,v1=<hex>[,v1=<hex>…]`; the signed
// payload is `<ts>.<raw body>`. Compared with a timing-safe equal.
function verifyEvent(rawBody, sigHeader, secret) {
  if (!sigHeader || !rawBody) return false;
  const entries = sigHeader.split(',').map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1)];
  });
  const t = entries.find((e) => e[0] === 't');
  const signatures = entries.filter((e) => e[0] === 'v1').map((e) => e[1]);
  if (!t || !signatures.length) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t[1]}.${rawBody.toString('utf8')}`)
    .digest('hex');
  return signatures.some((sig) =>
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

function parseEvent(rawBody) {
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { id: 'stripe', createCheckout, retrieveSession, verifyEvent, parseEvent };
