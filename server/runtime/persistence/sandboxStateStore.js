function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    templateVersion: 'sandbox-v1',
    baselineAppliedAt: null,
    mechanics: [],
    units: [],
    actions: [],
    ui: [],
    assets: [],
  };
}

export class InMemorySandboxStateStore {
  constructor(initialState = null) {
    this.state = initialState ? clone(initialState) : defaultState();
  }

  async load() {
    return clone(this.state);
  }

  async save(nextState) {
    this.state = clone(nextState);
    return this.load();
  }

  async reset() {
    this.state = defaultState();
    return this.load();
  }
}

export function createBaselineSandboxState() {
  return defaultState();
}
