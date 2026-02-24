# 3Market Backend

Node.js + Express + Stripe backend for 3Market.

## Setup

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm run dev
```

## Deploy to Railway (recommended — free tier)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard:
   - `STRIPE_SECRET_KEY` = your sk_live_... key
   - `STRIPE_WEBHOOK_SECRET` = from Stripe dashboard webhooks
   - `FRONTEND_URL` = your deployed frontend URL
4. Railway gives you a URL like `https://3market-backend.up.railway.app`

## Stripe Webhook Setup

1. Go to dashboard.stripe.com/webhooks
2. Add endpoint: `https://YOUR-RAILWAY-URL/webhook`
3. Select events:
   - `checkout.session.completed`
   - `issuing_card.created`
   - `payout.paid`
   - `payment_intent.payment_failed`
4. Copy the signing secret → paste as `STRIPE_WEBHOOK_SECRET` in Railway

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| POST | `/create-checkout-session` | Stripe checkout for listings |
| POST | `/create-customer` | Create Stripe customer |
| GET | `/customer/:id` | Get customer |
| POST | `/issue-card` | Issue virtual card |
| GET | `/cards/:cardholderId` | List cards |
| POST | `/create-payout` | EUR bank payout |
| GET | `/transactions/:customerId` | Payment history |
| POST | `/buy-xmr` | Checkout for buying XMR |
| POST | `/webhook` | Stripe webhook handler |
