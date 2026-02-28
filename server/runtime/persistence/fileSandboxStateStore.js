import { readFile, writeFile } from 'node:fs/promises';

import { createBaselineSandboxState } from './sandboxStateStore.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FileSandboxStateStore {
  constructor(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('FileSandboxStateStore requires non-empty filePath');
    }
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return createBaselineSandboxState();
      }
      throw error;
    }
  }

  async save(nextState) {
    await writeFile(this.filePath, JSON.stringify(nextState, null, 2), 'utf-8');
    return clone(nextState);
  }

  async reset() {
    const baseline = createBaselineSandboxState();
    await this.save(baseline);
    return baseline;
  }
}
