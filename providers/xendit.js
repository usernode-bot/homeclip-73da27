// Xendit adapter — structure only, so Indonesian payment methods (e-wallets,
// virtual accounts for bank transfer, QRIS) can be switched on later with no
// schema or flow changes. Every method returns the same "not configured"
// error the server maps to a 503.
async function notConfigured() {
  const err = new Error('Xendit payments are not configured yet');
  err.code = 'provider_not_configured';
  throw err;
}

module.exports = {
  id: 'xendit',
  createCheckout: notConfigured,
  retrieveSession: notConfigured,
  verifyEvent: () => false,
  parseEvent: () => null,
};
