require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────
// CASHBACK CONFIG
// ─────────────────────────────────────────
const CASHBACK = {
  standard:    0.02,   // 2% back for regular users
  xmr:         0.05,   // 5% back for XMR users
  fixed_trade: 0.50,   // €0.50 flat per completed barter trade (both parties)
  min_payout:  5.00,   // minimum balance to request withdrawal
};

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─────────────────────────────────────────
// HEALTH + SUPABASE KEEP-ALIVE PING
// ─────────────────────────────────────────
app.get('/', async (req, res) => {
  try { await sb.from('listings').select('id').limit(1); } catch {}
  res.json({
    status: '🟢 3Market backend v2.1',
    cashback_rates: CASHBACK,
    endpoints: [
      'POST /auth/register',
      'POST /auth/login',
      'GET  /auth/me',
      'POST /auth/logout',
      'GET  /wallet/:userId',
      'POST /wallet/withdraw',
      'POST /cashback/award',
      'POST /trade-complete',
      'POST /create-checkout-session',
      'POST /create-customer',
      'GET  /customer/:customerId',
      'POST /issue-card',
      'GET  /cards/:cardholderId',
      'POST /create-payout',
      'GET  /transactions/:customerId',
      'POST /buy-xmr',
      'POST /webhook'
    ]
  });
});

// ─────────────────────────────────────────
// AUTH — Register
// ─────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, username, location } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username: username || email.split('@')[0],
        location: location || 'Croatia'
      }
    });

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.username
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// AUTH — Login
// ─────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    res.json({
      success: true,
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.username
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// AUTH — Get current user (verify token)
// ─────────────────────────────────────────
app.get('/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired token' });

    const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).single();

    res.json({
      id: data.user.id,
      email: data.user.email,
      username: profile?.username || data.user.user_metadata?.username,
      location: profile?.location,
      monero_user: profile?.monero_user || false,
      avatar_url: profile?.avatar_url
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// AUTH — Logout
// ─────────────────────────────────────────
app.post('/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const { data } = await sb.auth.getUser(token);
      if (data?.user) await sb.auth.admin.signOut(data.user.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CASHBACK — Internal helper
// ─────────────────────────────────────────
async function awardCashback({ userId, purchaseAmount, type, listingId, isXmrUser, description }) {
  try {
    let cashbackAmount = 0;

    if (type === 'trade') {
      cashbackAmount = CASHBACK.fixed_trade;
    } else {
      const rate = isXmrUser ? CASHBACK.xmr : CASHBACK.standard;
      cashbackAmount = parseFloat((purchaseAmount * rate).toFixed(2));
    }

    if (cashbackAmount <= 0) return null;

    const { data: existing } = await sb
      .from('wallets').select('balance').eq('user_id', userId).single();

    const newBalance = parseFloat(((existing?.balance || 0) + cashbackAmount).toFixed(2));

    await sb.from('wallets').upsert(
      { user_id: userId, balance: newBalance, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

    await sb.from('cashback_events').insert({
      user_id: userId,
      amount: cashbackAmount,
      type,
      listing_id: listingId || null,
      description: description || `Cashback: ${type}`,
      balance_after: newBalance,
      rate_applied: type === 'trade' ? null : (isXmrUser ? CASHBACK.xmr : CASHBACK.standard),
      is_xmr_bonus: !!isXmrUser
    });

    console.log(`💰 Cashback: €${cashbackAmount} → user ${userId} (${type}, XMR:${!!isXmrUser})`);
    return cashbackAmount;
  } catch (err) {
    console.error('Cashback award error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────
// WALLET — Get balance + history
// ─────────────────────────────────────────
app.get('/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: wallet } = await sb
      .from('wallets').select('*').eq('user_id', userId).single();

    const { data: history } = await sb
      .from('cashback_events').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);

    res.json({
      balance: wallet?.balance || 0,
      currency: 'EUR',
      lifetime_earned: history?.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0) || 0,
      history: history || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// WALLET — Manual cashback award endpoint
// ─────────────────────────────────────────
app.post('/cashback/award', async (req, res) => {
  try {
    const { userId, purchaseAmount, type, listingId, isXmrUser, description } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const awarded = await awardCashback({ userId, purchaseAmount, type, listingId, isXmrUser, description });
    res.json({ success: true, cashback_awarded: awarded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// WALLET — Withdraw
// ─────────────────────────────────────────
app.post('/wallet/withdraw', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });

    const { data: wallet } = await sb.from('wallets').select('balance').eq('user_id', userId).single();
    const balance = wallet?.balance || 0;

    if (balance < CASHBACK.min_payout) {
      return res.status(400).json({
        error: `Minimum withdrawal is €${CASHBACK.min_payout}`,
        current_balance: balance
      });
    }
    if (amount > balance) {
      return res.status(400).json({ error: 'Insufficient balance', current_balance: balance });
    }

    const newBalance = parseFloat((balance - amount).toFixed(2));
    await sb.from('wallets').update({
      balance: newBalance,
      updated_at: new Date().toISOString()
    }).eq('user_id', userId);

    await sb.from('cashback_events').insert({
      user_id: userId,
      amount: -amount,
      type: 'withdrawal',
      description: `Withdrawal request: €${amount}`,
      balance_after: newBalance
    });

    res.json({ success: true, withdrawn: amount, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// TRADE COMPLETE — Award fixed cashback to both sides
// ─────────────────────────────────────────
app.post('/trade-complete', async (req, res) => {
  try {
    const { buyerUserId, sellerUserId, listingId, listingTitle, buyerIsXmr, sellerIsXmr } = req.body;
    if (!buyerUserId || !sellerUserId) return res.status(400).json({ error: 'Both user IDs required' });

    const [buyerCashback, sellerCashback] = await Promise.all([
      awardCashback({ userId: buyerUserId, purchaseAmount: 0, type: 'trade', listingId, isXmrUser: buyerIsXmr, description: `Trade completed: ${listingTitle}` }),
      awardCashback({ userId: sellerUserId, purchaseAmount: 0, type: 'trade', listingId, isXmrUser: sellerIsXmr, description: `Trade completed: ${listingTitle}` }),
    ]);

    res.json({ success: true, buyer_cashback: buyerCashback, seller_cashback: sellerCashback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CHECKOUT — Buy listing with card
// ─────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { listingId, title, price, currency = 'eur', customerId, imageUrl, userId, isXmrUser } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'title and price are required' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: title,
            ...(imageUrl && { images: [imageUrl] }),
            metadata: { listingId: listingId || 'unknown' }
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}?payment=success&listing=${listingId}`,
      cancel_url: `${FRONTEND_URL}?payment=cancelled`,
      metadata: {
        listingId: listingId || '',
        userId: userId || '',
        isXmrUser: isXmrUser ? 'true' : 'false',
        source: '3market'
      },
      ...(customerId && { customer: customerId }),
    });

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
    if (!email) return res.status(400).json({ error: 'email is required' });

    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      return res.json({ customerId: existing.data[0].id, existing: true });
    }

    const customer = await stripe.customers.create({
      email,
      name,
      phone,
      metadata: { ...metadata, source: '3market' }
    });

    res.json({ customerId: customer.id, existing: false });
  } catch (err) {
    console.error('Create customer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/customer/:customerId', async (req, res) => {
  try {
    const customer = await stripe.customers.retrieve(req.params.customerId);
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CARD ISSUING
// ─────────────────────────────────────────
app.post('/issue-card', async (req, res) => {
  try {
    const { cardholderId, currency = 'eur', spendingLimit = 100000 } = req.body;
    if (!cardholderId) return res.status(400).json({ error: 'cardholderId is required' });

    const card = await stripe.issuing.cards.create({
      cardholder: cardholderId,
      currency,
      type: 'virtual',
      spending_controls: {
        spending_limits: [{ amount: spendingLimit, interval: 'monthly' }]
      }
    });

    res.json({ cardId: card.id, last4: card.last4, status: card.status });
  } catch (err) {
    console.error('Issue card error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/cards/:cardholderId', async (req, res) => {
  try {
    const cards = await stripe.issuing.cards.list({
      cardholder: req.params.cardholderId,
      limit: 10
    });
    res.json(cards.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// PAYOUTS
// ─────────────────────────────────────────
app.post('/create-payout', async (req, res) => {
  try {
    const { amount, currency = 'eur', method = 'standard' } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount is required' });

    const payout = await stripe.payouts.create({
      amount: Math.round(amount * 100),
      currency,
      method
    });

    res.json({ payoutId: payout.id, status: payout.status, amount: payout.amount });
  } catch (err) {
    console.error('Payout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────
app.get('/transactions/:customerId', async (req, res) => {
  try {
    const charges = await stripe.charges.list({
      customer: req.params.customerId,
      limit: 20
    });
    res.json(charges.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// BUY XMR (stub — integrate with exchange API)
// ─────────────────────────────────────────
app.post('/buy-xmr', async (req, res) => {
  try {
    const { userId, eurAmount } = req.body;
    if (!userId || !eurAmount) return res.status(400).json({ error: 'userId and eurAmount required' });

    // Stub — in production, connect to FixedFloat or similar
    res.json({
      success: true,
      message: 'XMR purchase queued',
      eur_spent: eurAmount,
      estimated_xmr: (eurAmount / 165).toFixed(6), // rough estimate
      status: 'pending'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// STRIPE WEBHOOK
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const isXmrUser = session.metadata?.isXmrUser === 'true';
      const amountEur = session.amount_total / 100;

      if (userId) {
        await awardCashback({
          userId,
          purchaseAmount: amountEur,
          type: 'purchase',
          listingId: session.metadata?.listingId,
          isXmrUser,
          description: `Purchase: €${amountEur}`
        });
      }
      console.log(`✅ Checkout complete: ${session.id} — €${amountEur}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
🚀 3Market backend v2.1 running on port ${PORT}
💳 Stripe:   ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌ Missing STRIPE_SECRET_KEY'}
🗄️  Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌ Missing SUPABASE_URL'}
💰 Cashback: ${CASHBACK.standard*100}% standard | ${CASHBACK.xmr*100}% XMR | €${CASHBACK.fixed_trade} per trade
🌐 Frontend: ${FRONTEND_URL}
  `);
});
