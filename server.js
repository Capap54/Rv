const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));

const userWallets = new Map();
const userSessions = new Map();
const userPremiumUntil = new Map();
const userReferrals = new Map();

let marketListings = [
  { id: 'lot_vortex', username: 'vortexix', priceTon: 8.5, sellerName: 'Player', createdAt: Date.now() },
  { id: 'lot_zenith', username: 'zenithon', priceTon: 6.0, sellerName: 'Player', createdAt: Date.now() }
];

const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const RARE_ROOTS = [
  'vortex', 'zenith', 'kobra', 'shadow', 'pulse', 'cyber', 'ghost', 'drift',
  'venom', 'frost', 'storm', 'titan', 'blade', 'spark', 'apex', 'nova',
  'aura', 'echo', 'flux', 'core', 'onyx', 'volt', 'lynx', 'hawk', 'wolf', 'neon'
];

function rand(max) { return crypto.randomInt(0, max); }
function cleanName(raw) { return String(raw || '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, ''); }
function isValidName(u) { return /^[a-z][a-z0-9_]{4,31}$/.test(u); }

function getPremiumUntil(uid) {
  const until = Number(userPremiumUntil.get(String(uid)) || 0);
  return until > Date.now() ? until : 0;
}
function getRefCount(uid) { return Math.max(0, Number(userReferrals.get(String(uid)) || 0)); }

function makeSyllables(len) {
  let out = '';
  let useConsonant = rand(2) === 0;
  while (out.length < len) {
    out += useConsonant ? CONSONANTS[rand(CONSONANTS.length)] : VOWELS[rand(VOWELS.length)];
    useConsonant = !useConsonant;
  }
  return out.slice(0, len);
}

function generateByStyle(style) {
  if (style === 'len5') return makeSyllables(5);
  if (style === 'short6') return makeSyllables(6);
  if (style === 'premium_hunt') {
    const roots = RARE_ROOTS.filter((r) => r.length <= 7);
    const root = roots[rand(roots.length)] || 'vortex';
    const targetLen = 5 + rand(3);
    if (root.length >= targetLen) return root.slice(0, targetLen);
    return (root + makeSyllables(targetLen - root.length)).slice(0, targetLen);
  }
  if (style === 'rare') {
    const len = 6 + rand(3);
    const roots = RARE_ROOTS.filter((r) => r.length <= len);
    const root = roots[rand(roots.length)] || 'vortex';
    return (root + makeSyllables(Math.max(0, len - root.length))).slice(0, len);
  }
  if (style === 'with_num') {
    const len = 6 + rand(3);
    return makeSyllables(Math.max(4, len - 2)) + String(rand(90) + 10);
  }
  if (style === 'with_under') {
    const len = 6 + rand(3);
    const half = Math.max(2, Math.floor((len - 1) / 2));
    return (makeSyllables(half) + '_' + makeSyllables(Math.max(2, len - 1 - half))).slice(0, len);
  }
  return makeSyllables(6 + rand(3));
}

async function fetchSafe(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5500);
  try {
    return await fetch(url, { ...opts, redirect: 'follow', signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkBotApiStrict(username) {
  if (!BOT_TOKEN) return { checked: false, taken: false };
  try {
    const r = await fetchSafe(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${encodeURIComponent(username)}`);
    const j = await r.json();
    if (j && j.ok) return { checked: true, taken: true };
    const desc = String(j?.description || '').toLowerCase();
    if (desc.includes('chat not found') || desc.includes('username not occupied')) return { checked: true, taken: false };
    return { checked: true, taken: true };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkTMeStrict(username) {
  try {
    const r = await fetchSafe(`https://t.me/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await r.text();
    const low = html.toLowerCase();
    const hasEntity =
      html.includes('tgme_page_title') ||
      html.includes('tgme_page_extra') ||
      html.includes('tgme_page_description') ||
      html.includes('tgme_action_button_new') ||
      low.includes('subscribers') ||
      low.includes('members');
    const notOccupiedHint = low.includes('if you have <strong>telegram</strong>, you can contact');
    return { checked: true, taken: Boolean(hasEntity && !notOccupiedHint) };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkFragmentStrict(username) {
  try {
    const r = await fetchSafe(`https://fragment.com/username/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const low = (await r.text()).toLowerCase();
    const busyMarkers = [
      'on auction', 'place a bid', 'highest bid', 'make an offer', 'buy now',
      'sold', 'unavailable', 'taken', 'collectible', 'auction ends', 'minimum bid', 'ton'
    ];
    const busy = busyMarkers.some((m) => low.includes(m));
    const free = low.includes('username is available') || low.includes('this username is available');
    return { checked: true, taken: busy && !free };
  } catch (_) {
    return { checked: false, taken: false };
  }
}

async function checkAllSourcesStrict(username) {
  const [botApi, tMe, fragment] = await Promise.all([
    checkBotApiStrict(username),
    checkTMeStrict(username),
    checkFragmentStrict(username)
  ]);
  const anyTaken = Boolean(botApi.taken || tMe.taken || fragment.taken);
  const available = !anyTaken;
  const isRare = RARE_ROOTS.some((root) => username.includes(root)) || username.length <= 6;
  const badge = fragment.taken
    ? { code: 'fragment', label: 'На Fragment / Занят' }
    : (anyTaken
      ? { code: 'taken', label: 'Занят' }
      : (isRare ? { code: 'rare_premium', label: '1 редкий (премиум)' } : { code: 'available', label: 'Свободен везде' }));
  return { ok: true, username, length: username.length, available, badge, checks: { botApi, tMe, fragment } };
}

function buildProfilePayload(uid) {
  const existing = userSessions.get(uid) || {
    userId: uid, name: 'Игрок', tgUsername: '', platform: 'Web / Mini App', searches: 0, checks: 0, valuations: 0
  };
  const premiumUntil = getPremiumUntil(uid);
  const referrals = getRefCount(uid);
  return {
    ...existing,
    premium: premiumUntil > Date.now(),
    premiumUntil,
    referrals,
    canClaimDay: referrals >= 2,
    wallet: userWallets.get(uid) || ''
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: '2.0.0' }));

app.post('/api/session', (req, res) => {
  const uid = String(req.body?.userId || '').trim() || 'web_guest';
  const name = String(req.body?.name || 'Игрок').trim().slice(0, 40) || 'Игрок';
  const tgUsername = cleanName(req.body?.tgUsername || '');
  const platform = String(req.body?.platform || 'Web / Mini App').trim().slice(0, 24);
  const refBy = String(req.body?.refBy || '').trim();
  if (refBy && refBy !== uid) userReferrals.set(refBy, getRefCount(refBy) + 1);
  const prev = userSessions.get(uid) || { searches: 0, checks: 0, valuations: 0 };
  userSessions.set(uid, {
    userId: uid, name, tgUsername, platform,
    searches: prev.searches, checks: prev.checks, valuations: prev.valuations
  });
  res.json({ ok: true, profile: buildProfilePayload(uid) });
});

app.post('/api/referral/add', (req, res) => {
  const uid = String(req.body?.userId || 'web_guest');
  userReferrals.set(uid, getRefCount(uid) + 1);
  res.json({ ok: true, profile: buildProfilePayload(uid) });
});

app.post('/api/referral/redeem', (req, res) => {
  const uid = String(req.body?.userId || 'web_guest');
  const count = getRefCount(uid);
  if (count < 2) {
    return res.status(400).json({ ok: false, error: 'Нужно минимум 2 реферала', profile: buildProfilePayload(uid) });
  }
  userReferrals.set(uid, count - 2);
  userPremiumUntil.set(uid, Math.max(Date.now(), getPremiumUntil(uid)) + ONE_DAY_MS);
  res.json({ ok: true, profile: buildProfilePayload(uid) });
});

app.post('/api/premium', (req, res) => {
  const uid = String(req.body?.userId || 'web_guest');
  if (req.body?.active !== false) {
    userPremiumUntil.set(uid, Math.max(Date.now(), getPremiumUntil(uid)) + ONE_DAY_MS);
  } else {
    userPremiumUntil.delete(uid);
  }
  res.json({ ok: true, profile: buildProfilePayload(uid) });
});

app.post('/api/stats', (req, res) => {
  const uid = String(req.body?.userId || 'web_guest');
  const action = String(req.body?.action || '');
  const cur = userSessions.get(uid) || {
    userId: uid, name: 'Игрок', tgUsername: '', platform: 'Web / Mini App', searches: 0, checks: 0, valuations: 0
  };
  if (action === 'search') cur.searches += 1;
  if (action === 'check') cur.checks += 1;
  if (action === 'valuation') cur.valuations += 1;
  userSessions.set(uid, cur);
  res.json({ ok: true, profile: buildProfilePayload(uid) });
});

app.get('/api/check', async (req, res) => {
  const u = cleanName(req.query.username || '');
  if (!isValidName(u)) return res.status(400).json({ ok: false, message: 'Нужно 5–32 символа (латиница, цифры, _)' });
  res.json(await checkAllSourcesStrict(u));
});

app.get('/api/generate', async (req, res) => {
  const uid = String(req.query.userId || 'web_guest');
  const isPrem = getPremiumUntil(uid) > 0 || req.query.prem === '1';
  const count = Math.min(Math.max(Number(req.query.count) || 6, 1), 15);
  const style = String(req.query.style || 'rare');
  if ((style === 'premium_hunt' || style === 'len5') && !isPrem) {
    return res.status(403).json({ ok: false, needPremium: true, message: 'Нужен Премиум (или 2 реферала = 1 день)' });
  }
  const seen = new Set();
  const items = [];
  let scanned = 0;
  for (let i = 0; i < count * 15 && items.length < count; i++) {
    const u = generateByStyle(style);
    if (!isValidName(u) || seen.has(u)) continue;
    seen.add(u);
    scanned += 1;
    const resCheck = await checkAllSourcesStrict(u);
    if (resCheck.available) items.push(resCheck);
  }
  res.json({ ok: true, scanned, items });
});

app.get('/api/market', (req, res) => res.json({ ok: true, listings: marketListings }));

app.post('/api/market', (req, res) => {
  const username = cleanName(req.body?.username || '');
  const priceTon = Number(req.body?.priceTon);
  const sellerName = String(req.body?.sellerName || 'Игрок').trim().slice(0, 40) || 'Игрок';
  if (!isValidName(username) || !Number.isFinite(priceTon) || priceTon <= 0) {
    return res.status(400).json({ ok: false, error: 'Проверь юзернейм и цену TON' });
  }
  const lot = { id: 'lot_' + Date.now(), username, priceTon, sellerName, createdAt: Date.now() };
  marketListings.unshift(lot);
  res.json({ ok: true, listing: lot });
});

app.post('/api/wallet', (req, res) => {
  const uid = String(req.body?.userId || 'web_guest');
  const address = String(req.body?.address || '').trim();
  if (!address) return res.status(400).json({ ok: false, error: 'Введите адрес кошелька' });
  userWallets.set(uid, address);
  res.json({ ok: true, address });
});

app.get('*', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  res.status(404).send('public/index.html not found');
});

app.listen(PORT, () => console.log('Cap-App v2 running on port ' + PORT));
  
