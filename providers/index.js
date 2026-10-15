// Payment provider registry. `PAYMENT_PROVIDER` (dapp.json, default stripe)
// picks the adapter; only Stripe is implemented, in sandbox mode.
const providers = {
  stripe: require('./stripe'),
  midtrans: require('./midtrans'),
  xendit: require('./xendit'),
};

function currentProvider() {
  const id = String(process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase();
  return providers[id] || providers.stripe;
}

module.exports = { providers, currentProvider };
