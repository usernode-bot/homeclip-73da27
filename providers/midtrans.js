// Midtrans adapter — structure only, so Indonesian payment methods (GoPay and
// other e-wallets, bank transfer) can be switched on later with no schema or
// flow changes. Every method returns the same "not configured" error the
// server maps to a 503.
async function notConfigured() {
  const err = new Error('Midtrans payments are not configured yet');
  err.code = 'provider_not_configured';
  throw err;
}

module.exports = {
  id: 'midtrans',
  createCheckout: notConfigured,
  retrieveSession: notConfigured,
  verifyEvent: () => false,
  parseEvent: () => null,
};
