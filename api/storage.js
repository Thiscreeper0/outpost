import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

export default async function handler(req, res) {
  const { action, key, prefix, shared, value, keys } = req.body ?? req.query ?? {};
  const sharedFlag = shared === 'true' || shared === true;

  try {
    if (action === 'get') {
      if (!key) return res.status(400).json({ error: 'Missing key parameter' });
      const k = `${sharedFlag}:${key}`;
      const val = await redis.get(k);
      return res.json(val ?? null);
    }

    if (action === 'set') {
      if (!key) return res.status(400).json({ error: 'Missing key parameter' });
      const k = `${sharedFlag}:${key}`;
      await redis.set(k, value);
      return res.json({ key, value, shared: sharedFlag });
    }

    if (action === 'list') {
      const namespace = `${sharedFlag}:${prefix ?? ''}`;
      const keys = await redis.keys(`${namespace}*`);
      const prefixLength = `${sharedFlag}:`.length;
      return res.json(keys.map((k) => k.slice(prefixLength)));
    }

    // New bulk get
    if (action === 'bulkGet') {
      if (!Array.isArray(keys) || keys.length === 0) {
        return res.status(400).json({ error: 'Missing keys array parameter' });
      }
      const fullKeys = keys.map(k => `${sharedFlag}:${k}`);
      const values = await redis.mget(...fullKeys);
      return res.json(values);
    }
    // ... inside the handler, after bulkGet

    if (action === 'oauth_authorize') {
    const { platform } = req.body || req.query;
    if (!platform) return res.status(400).json({ error: 'Platform missing' });
    let authUrl;
    if (platform === 'lichess') {
        authUrl = `https://lichess.org/oauth/authorize?response_type=code&client_id=${process.env.LICHESS_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=profile:read`;
    } else if (platform === 'chesscom') {
        // Chess.com OAuth2 – use the documented endpoint
        authUrl = `https://www.chess.com/oauth/authorize?response_type=code&client_id=${process.env.CHESSCOM_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=profile`;
    } else {
        return res.status(400).json({ error: 'Unsupported platform' });
    }
    return res.json({ authUrl });
    }

    if (action === 'oauth_callback') {
    const { code, platform } = req.body || req.query;
    if (!code || !platform) return res.status(400).json({ error: 'Missing code or platform' });
    let tokenResponse;
    let userData;
    try {
        if (platform === 'lichess') {
        tokenResponse = await fetch('https://lichess.org/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: process.env.LICHESS_CLIENT_ID,
            client_secret: process.env.LICHESS_CLIENT_SECRET,
            redirect_uri: process.env.REDIRECT_URI,
            }),
        });
        const token = await tokenResponse.json();
        const accessToken = token.access_token;
        const profileRes = await fetch('https://lichess.org/api/account', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        userData = await profileRes.json();
        // Structure it like our existing profile
        const perfs = userData.perfs || {};
        const order = ['blitz', 'rapid', 'classical', 'bullet', 'correspondence'];
        const variants = order.filter(v => perfs[v]?.games > 0 && !perfs[v]?.prov)
            .map(v => ({ variant: v, rating: perfs[v].rating, games: perfs[v].games }));
        if (!variants.length) {
            for (const v of order) {
            if (perfs[v] && typeof perfs[v].rating === 'number') {
                variants.push({ variant: v, rating: perfs[v].rating, games: perfs[v].games || 0 });
            }
            }
        }
        if (!variants.length) return res.status(400).json({ error: 'No rated games found for this account.' });
        const top = variants.sort((a,b) => (b.games||0) - (a.games||0))[0];
        return res.json({
            platform: 'lichess',
            usernameDisplay: userData.username,
            variants,
            top,
            verified: true,
        });
        } else if (platform === 'chesscom') {
        // Chess.com OAuth – similar flow
        tokenResponse = await fetch('https://www.chess.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: process.env.CHESSCOM_CLIENT_ID,
            client_secret: process.env.CHESSCOM_CLIENT_SECRET,
            redirect_uri: process.env.REDIRECT_URI,
            }),
        });
        const token = await tokenResponse.json();
        const accessToken = token.access_token;
        const profileRes = await fetch('https://api.chess.com/pub/player/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const user = await profileRes.json();
        // Also fetch stats to get ratings
        const statsRes = await fetch(`https://api.chess.com/pub/player/${user.username}/stats`);
        const stats = await statsRes.json();
        const map = [['chess_blitz','blitz'], ['chess_rapid','rapid'], ['chess_bullet','bullet'], ['chess_daily','daily']];
        const variants = [];
        for (const [key, label] of map) {
            const block = stats[key];
            if (block?.last && typeof block.last.rating === 'number') {
            const rec = block.record || {};
            variants.push({ variant: label, rating: block.last.rating, games: (rec.win||0)+(rec.loss||0)+(rec.draw||0) });
            }
        }
        if (!variants.length) return res.status(400).json({ error: 'No rated games found for this account.' });
        const top = variants.sort((a,b) => (b.games||0) - (a.games||0))[0];
        return res.json({
            platform: 'chesscom',
            usernameDisplay: user.username,
            variants,
            top,
            verified: true,
        });
        }
    } catch (e) {
        return res.status(500).json({ error: 'OAuth exchange failed: ' + e.message });
    }
    }

    if (action === 'delete') {
      if (!key) return res.status(400).json({ error: 'Missing key parameter' });
      const k = `${sharedFlag}:${key}`;
      const deletedCount = await redis.del(k);
      return res.json(deletedCount > 0 ? { key, shared: sharedFlag } : null);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}