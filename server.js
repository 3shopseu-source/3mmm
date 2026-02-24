require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────

// Stripe webhooks need raw body — must be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: '🟢 3Market backend running',
    version: '1.0.0',
    endpoints: [
      'POST /create-checkout-session',
      'POST /create-customer',
      'GET  /customer/:customerId',
      'POST /issue-card',
      'GET  /cards/:customerId',
      'POST /create-payout',
      'GET  /transactions/:customerId',
      'POST /webhook'
    ]
  });
});

// ─────────────────────────────────────────
// CHECKOUT — Buy a listing with card
// ─────────────────────────────────────────

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { listingId, title, price, currency = 'eur', customerId, imageUrl } = req.body;

    if (!title || !price) {
      return res.status(400).json({ error: 'title and price are required' });
    }

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: title,
            ...(imageUrl && { images: [imageUrl] }),
            metadata: { listingId: listingId || 'unknown' }
          },
          unit_amount: Math.round(price * 100), // Stripe uses cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}?payment=success&listing=${listingId}`,
      cancel_url: `${FRONTEND_URL}?payment=cancelled`,
      metadata: { listingId: listingId || '', source: '3market' },
      ...(customerId && { customer: customerId }),
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CUSTOMERS — Create & fetch Stripe customers
// ─────────────────────────────────────────

app.post('/create-customer', async (req, res) => {
  try {
    const { email, name, phone, metadata = {} } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    // Check if customer already exists
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      return res.json({ customer: existing.data[0], existing: true });
    }

    const customer = await stripe.customers.create({
      email,
      name,
      phone,
      metadata: { ...metadata, source: '3market' }
    });

    res.json({ customer, existing: false });
  } catch (err) {
    console.error('Create customer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/customer/:customerId', async (req, res) => {
  try {
    const customer = await stripe.customers.retrieve(req.params.customerId);
    res.json({ customer });
  } catch (err) {
    res.status(404).json({ error: 'Customer not found' });
  }
});

// ─────────────────────────────────────────
// CARD ISSUING — Issue virtual cards
// ─────────────────────────────────────────

app.post('/issue-card', async (req, res) => {
  try {
    const { name, email, spendingLimit = 10000, currency = 'eur' } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }

    // 1. Create or retrieve cardholder
    let cardholder;
    try {
      const existing = await stripe.issuing.cardholders.list({ email, limit: 1 });
      if (existing.data.length > 0) {
        cardholder = existing.data[0];
      } else {
        cardholder = await stripe.issuing.cardholders.create({
          name,
          email,
          type: 'individual',
          billing: {
            address: {
              line1: '1 3Market St',
              city: 'Zagreb',
              postal_code: '10000',
              country: 'HR',
            }
          },
          status: 'active'
        });
      }
    } catch (e) {
      throw new Error(`Cardholder error: ${e.message}`);
    }

    // 2. Issue virtual card
    const card = await stripe.issuing.cards.create({
      cardholder: cardholder.id,
      currency,
      type: 'virtual',
      status: 'active',
      spending_controls: {
        spending_limits: [{
          amount: spendingLimit * 100,
          interval: 'monthly'
        }]
      }
    });

    res.json({
      cardId: card.id,
      cardholderId: cardholder.id,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      status: card.status,
      // Note: full card number only available via Stripe Elements for PCI compliance
      // Use stripe.issuing.cards.retrieveSensitiveData() with Elements on frontend
    });
  } catch (err) {
    console.error('Card issuing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/cards/:cardholderId', async (req, res) => {
  try {
    const cards = await stripe.issuing.cards.list({
      cardholder: req.params.cardholderId,
      limit: 10
    });
    res.json({ cards: cards.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// PAYOUTS — EUR bank payouts
// ─────────────────────────────────────────

app.post('/create-payout', async (req, res) => {
  try {
    const { amount, currency = 'eur', description = '3Market payout' } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'amount must be at least 1' });
    }

    const payout = await stripe.payouts.create({
      amount: Math.round(amount * 100),
      currency,
      description
    });

    res.json({ payout });
  } catch (err) {
    console.error('Payout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// TRANSACTIONS — Payment history
// ─────────────────────────────────────────

app.get('/transactions/:customerId', async (req, res) => {
  try {
    const charges = await stripe.charges.list({
      customer: req.params.customerId,
      limit: 20
    });

    const transactions = charges.data.map(c => ({
      id: c.id,
      amount: c.amount / 100,
      currency: c.currency.toUpperCase(),
      status: c.status,
      description: c.description,
      date: new Date(c.created * 1000).toISOString(),
      receipt: c.receipt_url
    }));

    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// XMR CHECKOUT — Pay EUR for Monero
// (Stripe side — XMR delivery handled separately)
// ─────────────────────────────────────────

app.post('/buy-xmr', async (req, res) => {
  try {
    const { eurAmount, xmrAmount, customerId, walletAddress } = req.body;

    if (!eurAmount || !walletAddress) {
      return res.status(400).json({ error: 'eurAmount and walletAddress are required' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Buy ${xmrAmount} XMR`,
            description: `Monero delivered to: ${walletAddress.substring(0, 20)}...`,
          },
          unit_amount: Math.round(eurAmount * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}?xmr=success&amount=${xmrAmount}&wallet=${walletAddress}`,
      cancel_url: `${FRONTEND_URL}?xmr=cancelled`,
      metadata: {
        type: 'xmr_purchase',
        xmrAmount: String(xmrAmount),
        walletAddress,
        source: '3market'
      },
      ...(customerId && { customer: customerId })
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('XMR checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// WEBHOOKS — Stripe event handling
// ─────────────────────────────────────────

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`✅ Webhook received: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log(`💰 Payment complete: €${session.amount_total / 100} | ${session.metadata?.listingId}`);
      // TODO: mark listing as sold in Supabase, notify seller
      break;
    }
    case 'issuing_card.created': {
      const card = event.data.object;
      console.log(`💳 Card issued: ${card.id} (${card.last4})`);
      break;
    }
    case 'payout.paid': {
      const payout = event.data.object;
      console.log(`🏦 Payout sent: €${payout.amount / 100}`);
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      console.log(`❌ Payment failed: ${intent.id}`);
      break;
    }
    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
🚀 3Market backend running on port ${PORT}
💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ Connected' : '❌ Missing STRIPE_SECRET_KEY'}
🌐 Frontend: ${FRONTEND_URL}
  `);
});
