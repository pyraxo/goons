import { createBaselineSandboxState } from './sandboxStateStore.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class RedisSandboxStateStore {
  constructor(redisClient, options = {}) {
    if (!redisClient || typeof redisClient.get !== 'function' || typeof redisClient.set !== 'function') {
      throw new Error('RedisSandboxStateStore requires a redis client with get/set methods');
    }
    this.redis = redisClient;
    this.key = options.key ?? 'goons:sandbox:state';
  }

  async load() {
    const raw = await this.redis.get(this.key);
    if (!raw) {
      return createBaselineSandboxState();
    }
    return JSON.parse(raw);
  }

  async save(nextState) {
    await this.redis.set(this.key, JSON.stringify(nextState));
    return clone(nextState);
  }

  async reset() {
    const baseline = createBaselineSandboxState();
    await this.save(baseline);
    return baseline;
  }
}
