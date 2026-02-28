import { compileMechanicArtifact, validateMechanicArtifact } from './mechanicsArtifact.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePatchCollections(artifact) {
  const patch = artifact?.sandboxPatch ?? {};
  return {
    ui: toArray(patch.ui),
    mechanics: toArray(patch.mechanics),
    units: toArray(patch.units),
    actions: toArray(patch.actions),
  };
}

function compileMechanicsBranch(mechanics, primitiveRegistry, logger) {
  const compiledMechanics = [];
  const appliedMechanics = [];
  const skippedMechanics = [];

  for (const mechanic of mechanics) {
    const mechanicId = mechanic?.id ?? '<unknown>';
    const validation = validateMechanicArtifact(mechanic, primitiveRegistry);
    if (!validation.ok) {
      logger?.warn?.('[sandbox] skipped mechanic', mechanicId, validation.error);
      skippedMechanics.push({ id: mechanicId, reason: validation.error });
      continue;
    }

    try {
      const compiled = compileMechanicArtifact(mechanic, primitiveRegistry);
      compiledMechanics.push(compiled);
      appliedMechanics.push({
        id: mechanic.id,
        name: mechanic.name,
        lifecycle: mechanic.lifecycle,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger?.warn?.('[sandbox] failed to compile mechanic', mechanicId, error);
      skippedMechanics.push({ id: mechanicId, reason });
    }
  }

  return {
    compiledMechanics,
    appliedMechanics,
    skippedMechanics,
  };
}

function activateMechanicsBranch(compiledMechanics, mechanicRuntime) {
  let activatedMechanics = 0;
  for (const compiled of compiledMechanics) {
    mechanicRuntime.registerMechanic(compiled);
    activatedMechanics += 1;
  }
  return { activatedMechanics };
}

export async function runAgenticApplyWorkflow({
  artifact,
  envelope,
  templateVersion,
  primitiveRegistry,
  mechanicRuntime,
  sandboxStateStore,
  generateAssets,
  resetToBaseline,
  logger = console,
}) {
  if (!artifact?.sandboxPatch) {
    return {
      assets: [],
      activatedMechanics: 0,
      appliedMechanics: [],
      skippedMechanics: [],
    };
  }

  if (artifact.sandboxPatch.resetToBaselineFirst) {
    await resetToBaseline('artifact-apply');
  }

  const patchCollections = normalizePatchCollections(artifact);
  const patchPromise = Promise.resolve().then(() =>
    compileMechanicsBranch(patchCollections.mechanics, primitiveRegistry, logger)
  );
  const assetsPromise = Promise.resolve()
    .then(() => generateAssets({ envelope, artifact }))
    .catch((error) => {
      logger?.warn?.('[sandbox] asset generation failed', error);
      return {
        jobs: [],
        assets: [],
      };
    });
  const activationPromise = Promise.all([patchPromise, assetsPromise]).then(([patchResult]) =>
    activateMechanicsBranch(patchResult.compiledMechanics, mechanicRuntime)
  );

  const [patchResult, assetsResult, activationResult] = await Promise.all([
    patchPromise,
    assetsPromise,
    activationPromise,
  ]);

  const prior = await sandboxStateStore.load();
  await sandboxStateStore.save({
    ...prior,
    templateVersion: templateVersion ?? prior.templateVersion,
    mechanics: patchResult.appliedMechanics,
    units: patchCollections.units,
    actions: patchCollections.actions,
    ui: patchCollections.ui,
    assets: toArray(assetsResult.assets),
  });

  return {
    assets: toArray(assetsResult.assets),
    activatedMechanics: activationResult.activatedMechanics,
    appliedMechanics: patchResult.appliedMechanics,
    skippedMechanics: patchResult.skippedMechanics,
  };
}
