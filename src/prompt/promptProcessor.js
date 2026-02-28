export const MODEL_PRESET_MAP = {
  fast: 'gpt-5.3-codex',
  medium: 'gpt-5.3-codex',
  high: 'gpt-5.3-codex',
};
export const REASONING_EFFORT_PRESET_MAP = {
  fast: 'low',
  medium: 'medium',
  high: 'high',
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 750;
const EXECUTE_ENDPOINT = '/api/prompt/execute';
const MAX_ARTIFACT_LINES = 4;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class NonRetriablePromptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetriablePromptError';
  }
}

function summarizeMechanics(artifact) {
  const mechanics = artifact?.sandboxPatch?.mechanics;
  if (!Array.isArray(mechanics) || mechanics.length === 0) {
    return [];
  }

  return mechanics.map((mechanic) => {
    const name = String(mechanic?.name ?? mechanic?.id ?? 'mechanic').trim() || 'mechanic';
    const description = String(mechanic?.description ?? '').trim();
    const hooks = Array.isArray(mechanic?.hooks)
      ? mechanic.hooks
          .map((hook) => String(hook?.event ?? '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    const primitives = Array.isArray(mechanic?.hooks)
      ? mechanic.hooks
          .flatMap((hook) =>
            Array.isArray(hook?.invocations)
              ? hook.invocations.map((invocation) => String(invocation?.primitiveId ?? '').trim())
              : []
          )
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const rules = Array.isArray(mechanic?.rules)
      ? mechanic.rules
          .map((rule) => String(rule ?? '').trim())
          .filter(Boolean)
          .slice(0, 2)
      : [];
    const details = [
      description,
      hooks.length > 0 ? `hooks=${hooks.join(',')}` : '',
      primitives.length > 0 ? `primitives=${primitives.join(',')}` : '',
      ...rules,
    ]
      .filter(Boolean)
      .join(' | ');
    return details ? `${name}: ${details}` : name;
  });
}

function summarizeArtifacts(artifact, applyRuntime = null) {
  if (!artifact?.sandboxPatch) {
    return [];
  }

  const lines = [];
  for (const type of ['ui', 'mechanics', 'units', 'actions']) {
    const items = Array.isArray(artifact.sandboxPatch[type]) ? artifact.sandboxPatch[type] : [];
    if (items.length > 0) {
      lines.push(`${type}=${items.length}`);
    }
  }
  const generatedAssets = Number(applyRuntime?.generatedAssets);
  if (Number.isFinite(generatedAssets) && generatedAssets > 0) {
    lines.push(`assets=${Math.floor(generatedAssets)}`);
  }
  return lines.slice(0, MAX_ARTIFACT_LINES);
}

function requestedMechanicCount(artifact) {
  const mechanics = artifact?.sandboxPatch?.mechanics;
  return Array.isArray(mechanics) ? mechanics.length : 0;
}

export class PromptProcessor {
  constructor(deps, callbacks = {}, options = {}) {
    this.queue = [];
    this.history = [];
    this.processing = false;

    this.deps = deps;
    this.callbacks = callbacks;
    this.generationMode = options.generationMode ?? 'openai-api-key';
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.executePromptOverride = options.executePrompt;
  }

  getQueueSize() {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  getHistory() {
    return [...this.history];
  }

  getReplayScript() {
    return this.history
      .map((entry, index) => {
        const header = `${index + 1}. [${entry.appliedAt}] preset=${entry.preset} cost=${entry.cost} types=${entry.types.join(',')} prompt="${entry.prompt.replaceAll('"', '\\"')}"`;
        const details = [];

        if (entry.templateVersion) {
          details.push(`   template=${entry.templateVersion}`);
        }
        if (entry.artifactSummary.length > 0) {
          details.push(`   artifacts=${entry.artifactSummary.join(', ')}`);
        }
        if (entry.mechanics.length > 0) {
          details.push(...entry.mechanics.map((line) => `   mechanic: ${line}`));
        } else {
          details.push('   mechanic: none');
        }

        return [header, ...details].join('\n');
      })
      .join('\n');
  }

  async waitForIdle(timeoutMs = 8000) {
    const startedAt = Date.now();
    while (this.processing || this.queue.length > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Timed out waiting for prompt queue to drain');
      }
      await wait(20);
    }
  }

  enqueue(envelope, preset) {
    this.queue.push({ envelope, preset });
    this.callbacks.onQueueUpdated?.(this.getQueueSize());
    void this.processQueue();
  }

  clearQueuedJobs() {
    const dropped = this.queue.length;
    this.queue = [];
    this.callbacks.onQueueUpdated?.(this.getQueueSize());
    return dropped;
  }

  clearHistory() {
    this.history = [];
    this.callbacks.onHistoryUpdated?.(this.getHistory());
  }

  async processQueue() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    this.callbacks.onQueueUpdated?.(this.getQueueSize());

    while (this.queue.length > 0) {
      const nextJob = this.queue.shift();
      if (!nextJob) {
        continue;
      }

      const { envelope, preset } = nextJob;
      const modelName = MODEL_PRESET_MAP[preset];
      const reasoningEffort = REASONING_EFFORT_PRESET_MAP[preset];
      this.callbacks.onStatus?.(`Applying ${envelope.id} with ${modelName} (reasoning: ${reasoningEffort})...`);

      const reservationId = this.deps.reserveGold(envelope.estimatedGoldCost);
      if (!reservationId) {
        this.callbacks.onStatus?.(
          `Apply blocked for ${envelope.id}: insufficient Gold for ${envelope.estimatedGoldCost}`
        );
        this.callbacks.onQueueUpdated?.(this.getQueueSize());
        continue;
      }

      const result = await this.runWithRetries(envelope, preset);
      if (result.success) {
        const artifact = result.applyDetails?.artifact ?? null;
        let applyRuntime = null;
        try {
          applyRuntime =
            (await this.callbacks.onArtifactApplied?.({
              envelope,
              preset,
              templateVersion: result.applyDetails?.templateVersion ?? null,
              artifact,
            })) ?? null;

          const requestedCount = requestedMechanicCount(artifact);
          const activatedCount = Number(applyRuntime?.activatedMechanics ?? 0);
          if (requestedCount > 0 && (!Number.isFinite(activatedCount) || activatedCount < 1)) {
            throw new Error(
              `No mechanics activated (${requestedCount} requested, ${Number.isFinite(activatedCount) ? activatedCount : 0} activated)`
            );
          }
        } catch (error) {
          const applyError = error instanceof Error ? error.message : 'unknown sandbox apply error';
          this.deps.refundReservedGold(reservationId);
          this.callbacks.onStatus?.(
            `Apply failed for ${envelope.id} during sandbox routes: ${applyError}. Gold refunded.`
          );
          this.callbacks.onQueueUpdated?.(this.getQueueSize());
          continue;
        }

        this.deps.commitReservedGold(reservationId);
        this.history.push({
          id: envelope.id,
          prompt: envelope.rawPrompt,
          types: envelope.classifiedTypes,
          cost: envelope.estimatedGoldCost,
          preset,
          appliedAt: new Date().toISOString(),
          templateVersion: result.applyDetails?.templateVersion ?? null,
          mechanics: summarizeMechanics(artifact),
          artifactSummary: summarizeArtifacts(artifact, applyRuntime),
        });
        this.callbacks.onHistoryUpdated?.(this.getHistory());
        this.callbacks.onStatus?.(
          `Applied ${envelope.id} in ${result.attemptCount} attempt${result.attemptCount === 1 ? '' : 's'}`
        );
      } else {
        this.deps.refundReservedGold(reservationId);
        this.callbacks.onStatus?.(
          `Apply failed for ${envelope.id} after ${result.attemptCount} attempts: ${result.error ?? 'unknown error'}. Gold refunded.`
        );
      }

      this.callbacks.onQueueUpdated?.(this.getQueueSize());
    }

    this.processing = false;
    this.callbacks.onQueueUpdated?.(this.getQueueSize());
  }

  async runWithRetries(envelope, preset) {
    let errorMessage;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        let applyDetails = null;
        if (this.executePromptOverride) {
          applyDetails = await this.executePromptOverride(envelope, preset, attempt);
        } else {
          applyDetails = await this.executePrompt(envelope, preset, attempt);
        }

        return {
          success: true,
          attemptCount: attempt,
          applyDetails: applyDetails ?? null,
        };
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'unknown error';
        if (error instanceof NonRetriablePromptError) {
          return {
            success: false,
            attemptCount: attempt,
            error: errorMessage,
          };
        }

        if (attempt < this.maxRetries) {
          this.callbacks.onStatus?.(
            `Attempt ${attempt}/${this.maxRetries} failed for ${envelope.id}: ${errorMessage}. Retrying...`
          );
          await wait(this.retryDelayMs);
        }
      }
    }

    return {
      success: false,
      attemptCount: this.maxRetries,
      error: errorMessage,
    };
  }

  async executePrompt(envelope, preset, attempt) {
    if (this.generationMode === 'mock') {
      await this.executeMock(envelope, preset, attempt);
      return;
    }

    return this.executeWithApiKeyProxy(envelope, preset);
  }

  async executeMock(envelope, preset, attempt) {
    const latencyByPreset = {
      fast: 600,
      medium: 1300,
      high: 2400,
    };
    await wait(latencyByPreset[preset]);

    if (attempt === 1 && envelope.rawPrompt.toLowerCase().includes('fail-once')) {
      throw new Error('Simulated transient artifact build error');
    }

    if (envelope.rawPrompt.toLowerCase().includes('force-fail')) {
      throw new Error('Simulated terminal apply failure');
    }
  }

  async executeWithApiKeyProxy(envelope, preset) {
    const model = MODEL_PRESET_MAP[preset];
    const reasoningEffort = REASONING_EFFORT_PRESET_MAP[preset];

    const response = await fetch(EXECUTE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        reasoningEffort,
        envelope: {
          promptId: envelope.id,
          prompt: envelope.rawPrompt,
          types: envelope.classifiedTypes,
          estimatedGoldCost: envelope.estimatedGoldCost,
        },
      }),
      credentials: 'same-origin',
    });

    if (!response.ok) {
      const errorText = await response.text();
      const shortError = errorText.slice(0, 320);
      if (response.status === 401 || response.status === 403) {
        throw new NonRetriablePromptError(`OpenAI auth/permission error (${response.status}): ${shortError}`);
      }
      throw new Error(`OpenAI generation failed (${response.status}): ${shortError}`);
    }

    const payload = await response.json();
    return {
      templateVersion: payload?.templateVersion ?? null,
      artifact: payload?.artifact ?? null,
      outputText: payload?.outputText ?? '',
    };
  }
}
