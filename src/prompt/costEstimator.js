const ESTIMATE_ENDPOINT = '/api/prompt/estimate';
const ALLOWED_TYPES = new Set(['ui', 'mechanics', 'units', 'actions']);
const ALLOWED_RISK = new Set(['low', 'medium', 'high']);

function normalizeTypes(value) {
  if (!Array.isArray(value)) {
    return ['actions'];
  }

  const normalized = value
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item, index, array) => item && ALLOWED_TYPES.has(item) && array.indexOf(item) === index);

  return normalized.length > 0 ? normalized : ['actions'];
}

function normalizeRisk(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ALLOWED_RISK.has(normalized) ? normalized : 'medium';
}

function normalizeCost(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Math.max(1, Math.ceil(numeric));
}

export async function estimatePrompt(rawPrompt) {
  const response = await fetch(ESTIMATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: rawPrompt,
    }),
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const errorText = await response.text();
    const shortError = errorText.slice(0, 320);
    throw new Error(`Prompt estimation failed (${response.status}): ${shortError}`);
  }

  const data = await response.json();
  const estimated = data?.estimate ?? {};

  return {
    id: `prompt_${Date.now()}`,
    inputMode: 'text',
    rawPrompt,
    classifiedTypes: normalizeTypes(estimated.classifiedTypes),
    estimatedGoldCost: normalizeCost(estimated.estimatedGoldCost),
    riskLevel: normalizeRisk(estimated.riskLevel),
    requiresReview: Boolean(estimated.requiresReview),
  };
}
