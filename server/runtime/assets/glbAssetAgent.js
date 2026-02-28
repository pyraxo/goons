const GLB_ASSET_ENDPOINT = '/api/assets/generate-glb';
const MAX_ASSET_JOBS = 8;

function normalizeToken(value, fallback) {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback;
}

function pushJobsFromCollection(jobs, items, sourceType) {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    const sourceId = normalizeToken(item?.id, `${sourceType}_${jobs.length + 1}`);
    const label = String(item?.name ?? item?.title ?? sourceId).trim() || sourceId;
    jobs.push({
      assetId: `${sourceType}_${sourceId}`,
      sourceType,
      sourceId,
      label,
    });
    if (jobs.length >= MAX_ASSET_JOBS) {
      return;
    }
  }
}

export function deriveGlbAssetJobs(artifact) {
  const patch = artifact?.sandboxPatch;
  if (!patch || typeof patch !== 'object') {
    return [];
  }

  const jobs = [];
  pushJobsFromCollection(jobs, patch.mechanics, 'mechanic');
  if (jobs.length < MAX_ASSET_JOBS) {
    pushJobsFromCollection(jobs, patch.units, 'unit');
  }
  if (jobs.length < MAX_ASSET_JOBS) {
    pushJobsFromCollection(jobs, patch.actions, 'action');
  }
  if (jobs.length < MAX_ASSET_JOBS) {
    pushJobsFromCollection(jobs, patch.ui, 'ui');
  }
  return jobs;
}

function normalizeGeneratedAssets(payloadAssets) {
  if (!Array.isArray(payloadAssets)) {
    return [];
  }

  return payloadAssets
    .map((asset) => ({
      id: String(asset?.id ?? asset?.assetId ?? '').trim(),
      name: String(asset?.name ?? '').trim(),
      kind: 'glb',
      path: String(asset?.path ?? '').trim(),
      sourceType: String(asset?.sourceType ?? '').trim(),
      sourceId: String(asset?.sourceId ?? '').trim(),
      generatedAt: String(asset?.generatedAt ?? '').trim(),
      model: String(asset?.model ?? '').trim(),
    }))
    .filter((asset) => asset.id && asset.path);
}

export async function generateGlbAssetsForArtifact({ envelope, artifact }) {
  const jobs = deriveGlbAssetJobs(artifact);
  if (jobs.length === 0) {
    return {
      jobs: [],
      assets: [],
    };
  }

  const response = await fetch(GLB_ASSET_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      promptId: envelope?.id ?? '',
      prompt: envelope?.rawPrompt ?? '',
      jobs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const shortError = errorText.slice(0, 320);
    throw new Error(`GLB generation failed (${response.status}): ${shortError}`);
  }

  const payload = await response.json();
  return {
    jobs,
    assets: normalizeGeneratedAssets(payload?.assets),
  };
}
