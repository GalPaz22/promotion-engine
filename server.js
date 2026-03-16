/**
 * 🏷️ Promotion & Sales Discovery Engine
 *
 * Connects to the same MongoDB cluster as dashboard-server.
 * For each session, loads the user profile (preferences.softCategories +
 * preferences.priceRangesByCategory) and uses it to rank on-sale products
 * so the most relevant promotions surface first.
 *
 * Auth: X-API-Key header (same keys stored in the `users` DB).
 *
 * Endpoints:
 *   POST /promotions/discover   — personalized on-sale product list
 *   GET  /promotions/summary    — sale counts & categories for this store
 *   GET  /health                — health check
 */

import express from 'express';
import { MongoClient } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const PORT = parseInt(process.env.PORT || '3099', 10);

if (!MONGODB_URI) {
  console.error('[PROMO] MONGODB_URI is not set. Check your .env file.');
  process.exit(1);
}

// ─── MongoDB singleton ──────────────────────────────────────────────────────

let _client = null;

async function getMongoClient() {
  if (_client) return _client;
  _client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 2,
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 5000,
    readPreference: 'primaryPreferred',
  });
  await _client.connect();
  console.log('[PROMO] MongoDB connected');
  return _client;
}

// ─── Store resolution ────────────────────────────────────────────────────────

/**
 * Resolve an API key to a store config document from the `users` DB.
 * Returns null if the key is unknown.
 */
async function getStoreByApiKey(apiKey) {
  const client = await getMongoClient();
  return client.db('users').collection('users').findOne({ apiKey });
}

// ─── Profile helpers ─────────────────────────────────────────────────────────

/**
 * Fetch a session profile from the store's `profiles` collection.
 * Returns null if not found.
 */
async function getSessionProfile(dbName, sessionId) {
  const client = await getMongoClient();
  return client.db(dbName).collection('profiles').findOne({ session_id: sessionId });
}

/**
 * Build an ordered map of soft-category affinities from the profile.
 * Affinity = purchases×5 + carts×3 + clicks×1 + searches×0.5
 * Returns: { [categoryName]: affinityScore }
 */
function buildAffinityMap(profile) {
  const affinityMap = {};
  const softCats = profile?.preferences?.softCategories || {};
  for (const [cat, stats] of Object.entries(softCats)) {
    affinityMap[cat] =
      (stats.purchases || 0) * 8 +
      (stats.carts    || 0) * 15 + // strong intent signal — user actively added to cart
      (stats.clicks   || 0) * 1 +
      (stats.searches || 0) * 0.5;
  }
  return affinityMap;
}

/**
 * Build an affinity map from hardCategories (same scoring formula as soft).
 * Returns: { [categoryName]: affinityScore }
 */
function buildHardCategoryMap(profile) {
  const map = {};
  const hardCats = profile?.hardCategories || {};
  for (const [cat, stats] of Object.entries(hardCats)) {
    if (typeof stats !== 'object' || !stats) continue;
    map[cat] =
      (stats.purchases || 0) * 8 +
      (stats.carts    || 0) * 15 +
      (stats.clicks   || 0) * 1 +
      (stats.searches || 0) * 0.5;
  }
  return map;
}

/**
 * Build lookup structures from the profile's cartItems array.
 * Returns: { ids: Set<string>, names: Set<string> }
 */
function buildCartSets(profile) {
  const ids   = new Set();
  const names = new Set();
  for (const item of (profile?.cartItems || [])) {
    if (item.id   != null) ids.add(String(item.id));
    if (item.name != null) names.add(String(item.name).toLowerCase().trim());
  }
  return { ids, names };
}

/**
 * Return the preferred price range for a given hard category (or global fallback).
 * Returns: { min, max, avg } or null
 */
function getPreferredPriceRange(profile, hardCategory) {
  const byCategory = profile?.preferences?.priceRangesByCategory || {};
  const global = profile?.preferences?.priceRange || null;
  if (hardCategory && byCategory[hardCategory]) return byCategory[hardCategory];
  return global;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score a single on-sale product against a session profile.
 *
 * Score components:
 *   1. Soft-category affinity   (0–200 pts): sum of affinities for matching soft cats
 *   2. Hard-category affinity   (0–100 pts): sum of affinities from hardCategories map
 *   3. Price proximity           (0–50  pts): closeness to preferred avg price
 *   4. Price-range interaction   (0–30  pts): user has interacted in same hard cat
 *   5. Cart item match           (0–80  pts): product is / shares name with a cart item
 *   6. Boost field bonus         (0–30  pts): catalog-level boost from store config
 *
 * @param {Object} product          — raw MongoDB product document
 * @param {Object|null} profile     — session profile document (may be null for anonymous)
 * @param {Object} affinityMap      — pre-built soft-category affinity map
 * @param {Object} hardCategoryMap  — pre-built hard-category affinity map
 * @param {Object} cartSets         — { ids: Set, names: Set } from cart items
 * @returns {number} total score (higher = more relevant)
 */
function scoreProduct(product, profile, affinityMap, hardCategoryMap, cartSets) {
  let score = 0;

  // ── 1. Soft-category affinity ──────────────────────────────────────────────
  const productSoftCats = Array.isArray(product.softCategory)
    ? product.softCategory
    : product.softCategory
    ? [product.softCategory]
    : [];

  for (const sc of productSoftCats) {
    if (typeof sc !== 'string') continue;
    const affinity = affinityMap[sc] || 0;
    score += affinity * 10;
  }

  // ── 2. Hard-category affinity ─────────────────────────────────────────────
  const productHardCats = Array.isArray(product.category)
    ? product.category
    : product.category
    ? [product.category]
    : [];

  for (const hc of productHardCats) {
    if (typeof hc !== 'string') continue;
    const affinity = hardCategoryMap[hc] || 0;
    score += affinity * 8; // slightly lower weight than soft cats
  }

  // ── 3. Price proximity ────────────────────────────────────────────────────
  const productPrice = parseFloat(product.price) || 0;
  if (productPrice > 0 && profile) {
    const hardCat = productHardCats[0] || null;
    const range = getPreferredPriceRange(profile, hardCat);
    if (range && range.avg > 0) {
      const priceDiff = Math.abs(productPrice - range.avg);
      const proximity = Math.max(0, 1 - priceDiff / range.avg);
      score += proximity * 50;
    }
  }

  // ── 4. Price-range interaction count ─────────────────────────────────────
  if (profile) {
    const hardCat = productHardCats[0] || null;
    if (hardCat) {
      const catRange = profile?.preferences?.priceRangesByCategory?.[hardCat];
      if (catRange?.count > 0) {
        score += Math.min(catRange.count * 5, 30);
      }
    }
  }

  // ── 5. Cart item match ────────────────────────────────────────────────────
  if (cartSets) {
    const productId   = String(product.id ?? product._id ?? '');
    const productName = String(product.name || '').toLowerCase().trim();

    if (productId && cartSets.ids.has(productId)) {
      score += 80; // exact product is in cart — highest intent signal
    } else if (productName && cartSets.names.has(productName)) {
      score += 60; // same product name
    }
  }

  // ── 6. Catalog boost field ────────────────────────────────────────────────
  if (product.boost && product.boost > 0) {
    score += Math.min(product.boost * 2, 30);
  }

  return score;
}

// ─── On-sale query helpers ───────────────────────────────────────────────────

/**
 * MongoDB filter that selects products currently on sale and in stock.
 * Matches any of:
 *   • non-empty specialSales array
 *   • onSale: true
 *   • sale_price field present
 *   • salePrice field present
 */
function buildSaleFilter(category) {
  const filter = {
    onSale: { $ne: false },
    $or: [
      { specialSales: { $exists: true, $type: 'array', $ne: [] } },
      { onSale: true },
      { sale_price: { $exists: true } },
      { salePrice: { $exists: true } },
      { regularPrice: { $exists: true } },
    ],
    $and: [{ $or: [{ stockStatus: 'instock' }, { stockStatus: { $exists: false } }] }],
  };
  if (category) {
    filter.category = { $in: Array.isArray(category) ? category : [category] };
  }
  return filter;
}

/** Fields we actually need — keeps network overhead low. */
const SALE_PROJECTION = {
  id: 1, name: 1, description: 1,
  price: 1, sale_price: 1, salePrice: 1, regularPrice: 1, image: 1, url: 1,
  category: 1, softCategory: 1,
  stockStatus: 1, boost: 1, onSale: 1,
  specialSales: 1,
};

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ── Serve widget.js (and demo) as public static files ────────────────────────
// widget.js is the CDN-deliverable embed script; serve it with a short cache
// so updates propagate quickly while still benefiting from browser caching.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// widget-loader.js — permanent URL, customers embed this once and never change it
// Cached aggressively (1 hour) since it barely changes.
app.get('/widget-loader.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.sendFile(path.join(__dirname, 'widget-loader.js'));
});

// widget.js — full engine, short cache in production; no cache in dev
app.get('/widget.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  const isProd = process.env.NODE_ENV === 'production';
  res.setHeader('Cache-Control', isProd
    ? 'public, max-age=300, stale-while-revalidate=3600'
    : 'no-store');
  res.sendFile(path.join(__dirname, 'widget.js'));
});

app.get('/widget-demo.html', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'widget-demo.html'));
});

// ── Middleware: validate API key ──────────────────────────────────────────────

async function requireApiKey(req, res, next) {
  const apiKey = req.get('x-api-key');
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header' });

  const store = await getStoreByApiKey(apiKey).catch(() => null);
  if (!store) return res.status(401).json({ error: 'Invalid API key' });

  req.store = store; // attach store config
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Simple liveness probe.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'promotion-engine', timestamp: new Date().toISOString() });
});

/**
 * GET /widget/config
 * Returns widget configuration for a store, keyed by API key.
 * The widget caches this in localStorage (5-min TTL) so subsequent page loads
 * have zero-latency config and only refresh in the background.
 *
 * Headers: X-API-Key
 */
app.get('/widget/config', requireApiKey, (req, res) => {
  const store  = req.store;
  const sc     = store.siteConfig || {};
  const ct     = sc.clickTracking || {};
  const ci     = ct.cartInterceptor || {};

  return res.json({
    server:         process.env.PUBLIC_URL || `http://localhost:${PORT}`,
    dbName:         store.dbName,
    platform:       sc.platform        || 'unknown',
    lang:           store.lang         || 'he',
    limit:          store.limit        ?? 20,
    // cart intercept
    atcPatterns:    ci.urlPatterns      || [],
    checkoutPatterns: ci.checkoutPatterns || [],
    productIdField: ci.productIdField   || 'id',
    quantityField:  ci.quantityField    || 'quantity',
    atcSelector:    ct.addToCartSelector || '',
  });
});

/**
 * GET /promotions/summary
 * Returns how many products are on sale and which categories they cover.
 * Useful for a "Sales" badge or dashboard widget.
 *
 * Headers: X-API-Key
 */
app.get('/promotions/summary', requireApiKey, async (req, res) => {
  const { dbName } = req.store;
  const productsCol = req.store.collections?.products || 'products';

  try {
    const client = await getMongoClient();
    const col = client.db(dbName).collection(productsCol);

    const pipeline = [
      { $match: buildSaleFilter() },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          categories: { $addToSet: '$category' },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          avgPrice: { $avg: '$price' },
        },
      },
    ];

    const [agg] = await col.aggregate(pipeline).toArray();
    if (!agg) return res.json({ total: 0, categories: [], minPrice: 0, maxPrice: 0, avgPrice: 0 });

    // Flatten nested category arrays
    const flatCats = [...new Set(
      (agg.categories || []).flat().filter(Boolean)
    )];

    return res.json({
      total: agg.total,
      categories: flatCats,
      minPrice: Math.round(agg.minPrice * 100) / 100,
      maxPrice: Math.round(agg.maxPrice * 100) / 100,
      avgPrice: Math.round(agg.avgPrice * 100) / 100,
    });
  } catch (err) {
    console.error('[PROMO /summary]', err.message);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

/**
 * POST /promotions/discover
 *
 * Body:
 *   session_id  {string}          — optional; enables profile-based personalization
 *   limit       {number}          — max products to return (default 20)
 *   category    {string|string[]} — optional hard-category filter
 *
 * Headers: X-API-Key
 *
 * Response:
 *   {
 *     session_id,
 *     personalized: bool,         — true if a profile was found & used
 *     profileSnapshot: {          — top 5 soft-cat affinities (debug/transparency)
 *       topCategories: [{category, affinity}]
 *     },
 *     total: number,              — total on-sale products in store
 *     returned: number,
 *     products: [...]             — ranked product list
 *   }
 */
app.post('/promotions/discover', requireApiKey, async (req, res) => {
  const { session_id, limit = 20, category } = req.body;
  const { dbName } = req.store;
  const productsCol = req.store.collections?.products || 'products';

  console.log(`[PROMO /discover] store=${dbName} session=${session_id || 'anon'} limit=${limit}${category ? ` cat=${category}` : ''}`);

  try {
    const client = await getMongoClient();
    const db = client.db(dbName);

    // ── 1. Load profile ──────────────────────────────────────────────────────
    const profile         = session_id ? await getSessionProfile(dbName, session_id) : null;
    const affinityMap     = buildAffinityMap(profile);
    const hardCategoryMap = buildHardCategoryMap(profile);
    const cartSets        = buildCartSets(profile);

    // Top-5 categories by affinity (soft + hard combined, for response transparency)
    const combinedAffinities = { ...affinityMap };
    for (const [cat, score] of Object.entries(hardCategoryMap)) {
      combinedAffinities[cat] = (combinedAffinities[cat] || 0) + score;
    }
    const topCategories = Object.entries(combinedAffinities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, affinity]) => ({ category: cat, affinity }));

    // ── 2. Fetch on-sale products ─────────────────────────────────────────────
    const saleFilter = buildSaleFilter(category);
    const onSaleProducts = await db
      .collection(productsCol)
      .find(saleFilter)
      .project(SALE_PROJECTION)
      .toArray();

    console.log(`[PROMO /discover] ${onSaleProducts.length} on-sale products found`);

    if (onSaleProducts.length === 0) {
      return res.json({
        session_id: session_id || null,
        personalized: false,
        profileSnapshot: { topCategories: [] },
        total: 0,
        returned: 0,
        products: [],
      });
    }

    // ── 3. Score & rank ───────────────────────────────────────────────────────
    const scored = onSaleProducts.map((product) => {
      const relevanceScore = scoreProduct(product, profile, affinityMap, hardCategoryMap, cartSets);
      return { product, relevanceScore };
    });

    // Personalized sort: score desc; anonymous fallback: boost desc then price asc
    if (profile) {
      scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    } else {
      scored.sort((a, b) => {
        const boostDiff = (b.product.boost || 0) - (a.product.boost || 0);
        if (boostDiff !== 0) return boostDiff;
        return (parseFloat(a.product.price) || 0) - (parseFloat(b.product.price) || 0);
      });
    }

    // ── 4. Shape output ───────────────────────────────────────────────────────
    const results = scored.slice(0, limit).map(({ product, relevanceScore }) => {
      // Resolve sale price and original price from whichever field names are present
      const salePrice = product.sale_price ?? product.salePrice ?? null;
      const regularPrice = product.regularPrice ?? null;

      // Prefer specialSales array; fall back to a synthetic label from price/salePrice
      let promotions = [];
      if (Array.isArray(product.specialSales) && product.specialSales.length > 0) {
        promotions = product.specialSales;
      } else if (salePrice != null || regularPrice != null) {
        const orig = parseFloat(regularPrice ?? product.price);
        const sale = parseFloat(salePrice ?? product.price);
        if (!isNaN(orig) && !isNaN(sale) && orig > sale) {
          const pct = Math.round(((orig - sale) / orig) * 100);
          promotions = [{ title: `${pct}% off`, originalPrice: orig }];
        } else {
          promotions = [{ title: 'On Sale' }];
        }
      }

      // Show the sale price as the primary price when available;
      // original price comes from regularPrice, or falls back to price when sale_price is present
      const displayPrice = salePrice ?? product.price;
      const originalPrice = regularPrice ?? (salePrice != null ? product.price : undefined);

      return {
        _id: product._id.toString(),
        id: product.id,
        name: product.name,
        description: product.description,
        price: displayPrice,
        originalPrice,
        image: product.image,
        url: product.url,
        category: product.category,
        softCategory: product.softCategory,
        onSale: true,
        promotions,
        stockStatus: product.stockStatus,
        _relevanceScore: Math.round(relevanceScore * 100) / 100,
      };
    });

    return res.json({
      session_id: session_id || null,
      personalized: !!profile,
      profileSnapshot: { topCategories },
      total: onSaleProducts.length,
      returned: results.length,
      products: results,
    });
  } catch (err) {
    console.error('[PROMO /discover]', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

/**
 * POST /events
 *
 * Receives behavioural events from the widget and updates the session profile.
 *
 * Body:
 *   session_id   {string}          — auto-generated by the widget (required)
 *   event_type   {string}          — 'view' | 'click' | 'cart'
 *   product_id   {string}
 *   product_name {string}
 *   category     {string|string[]} — hard categories of the product
 *   softCategory {string|string[]} — soft tags of the product
 *
 * Headers: X-API-Key
 */
app.post('/events', requireApiKey, async (req, res) => {
  const { session_id, event_type, product_id, product_name, category, softCategory } = req.body;
  const { dbName } = req.store;

  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const validTypes = ['view', 'click', 'cart', 'purchase'];
  if (!validTypes.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of: ${validTypes.join(', ')}` });
  }

  // Map event type → profile counter field
  const fieldMap = { view: 'clicks', click: 'clicks', cart: 'carts', purchase: 'purchases' };
  const counterField = fieldMap[event_type];

  try {
    const client = await getMongoClient();
    const col    = client.db(dbName).collection('profiles');

    const $inc  = {};
    const $set  = { updated_at: new Date() };
    const now   = new Date();

    // Increment soft-category counters
    for (const sc of [].concat(softCategory || []).filter(Boolean)) {
      $inc[`preferences.softCategories.${sc}.${counterField}`] = 1;
    }

    // Increment hard-category counters
    for (const hc of [].concat(category || []).filter(Boolean)) {
      $inc[`hardCategories.${hc}.${counterField}`] = 1;
    }

    const updateOps = {
      $inc,
      $set,
      $setOnInsert: { session_id, created_at: now },
    };

    // For cart events, also push to cartItems (cap at last 100)
    if (event_type === 'cart' && product_id) {
      updateOps.$push = {
        cartItems: {
          $each:  [{ id: product_id, name: product_name || '', addedAt: now }],
          $slice: -100,
        },
      };
    }

    await col.updateOne({ session_id }, updateOps, { upsert: true });

    console.log(`[EVENTS] ${event_type} | session=${session_id} | product=${product_id || '—'}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[EVENTS]', err.message);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🏷️  Promotion Engine running on http://localhost:${PORT}`);
  console.log('   POST /promotions/discover  — personalized on-sale products');
  console.log('   POST /events               — track view / click / cart events');
  console.log('   GET  /promotions/summary   — store-wide sale stats');
  console.log('   GET  /health\n');

  // Warm up the DB connection
  try {
    await getMongoClient();
  } catch (err) {
    console.error('[PROMO] Could not connect to MongoDB on startup:', err.message);
  }
});
