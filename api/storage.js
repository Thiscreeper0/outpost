import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

export default async function handler(req, res) {
  const { action, key, prefix, shared, value } = req.body ?? req.query ?? {};
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