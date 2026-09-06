import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export default async function handler(req, res) {
  const { action, key, prefix, shared, value } = req.body ?? req.query;
  const sharedFlag = shared === 'true' || shared === true;

  try {
    if (action === 'get') {
      const k = `${sharedFlag}:${key}`;
      const val = await kv.get(k);
      return res.json(val ?? null);
    }
    if (action === 'set') {
      const k = `${sharedFlag}:${key}`;
      await kv.set(k, value);
      return res.json({ key, value, shared: sharedFlag });
    }
    if (action === 'list') {
      const namespace = `${sharedFlag}:${prefix}`;
      const keys = await kv.keys(`${namespace}*`);
      const prefixLength = `${sharedFlag}:`.length;
      return res.json(keys.map((k) => k.slice(prefixLength)));
    }
    if (action === 'delete') {
      const k = `${sharedFlag}:${key}`;
      const deletedCount = await kv.del(k);
      return res.json(deletedCount > 0 ? { key, shared: sharedFlag } : null);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}