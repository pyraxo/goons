import { readFileSync } from 'node:fs';

const CATALOG = loadSpellTemplateCatalog();

export function getSpellTemplateCatalogVersion() {
  return CATALOG.version;
}

export function matchSpellTemplate(prompt) {
  return matchSpellTemplateFromCatalog(prompt, CATALOG);
}

export function matchSpellTemplateFromCatalog(prompt, catalog) {
  if (typeof prompt !== 'string') {
    return null;
  }

  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  const templates = Array.isArray(catalog?.templates) ? catalog.templates : [];
  const exactCandidates = [];
  const phraseCandidates = [];

  for (let templateIndex = 0; templateIndex < templates.length; templateIndex += 1) {
    const template = templates[templateIndex];
    const aliases = aliasesForTemplate(template);
    for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
      const alias = aliases[aliasIndex];
      if (!alias) {
        continue;
      }
      if (normalizedPrompt === alias) {
        exactCandidates.push(candidate(template, templateIndex, alias, aliasIndex));
        continue;
      }
      if (containsAliasPhrase(normalizedPrompt, alias)) {
        phraseCandidates.push(candidate(template, templateIndex, alias, aliasIndex));
      }
    }
  }

  const selected = pickBestCandidate(exactCandidates.length > 0 ? exactCandidates : phraseCandidates);
  if (!selected) {
    return null;
  }

  return {
    key: selected.key,
    alias: selected.alias,
    expansion: selected.expansion,
  };
}

function loadSpellTemplateCatalog() {
  const url = new URL('./spell-templates.json', import.meta.url);
  const raw = readFileSync(url, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('spell template catalog must be an object');
  }

  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!version) {
    throw new Error('spell template catalog version is required');
  }

  if (!Array.isArray(parsed.templates) || parsed.templates.length === 0) {
    throw new Error('spell template catalog templates are required');
  }

  const templates = parsed.templates.map((entry, index) => {
    const key = normalizeText(entry?.key);
    if (!key) {
      throw new Error(`template key missing at index ${index}`);
    }
    const expansion = typeof entry?.expansion === 'string' ? entry.expansion.trim() : '';
    if (!expansion) {
      throw new Error(`template expansion missing for key ${key}`);
    }
    const aliases = aliasesForTemplate(entry);
    if (aliases.length === 0) {
      throw new Error(`template aliases missing for key ${key}`);
    }
    return {
      key,
      aliases,
      expansion,
    };
  });

  return { version, templates };
}

function aliasesForTemplate(template) {
  const dedupe = new Set();
  const ordered = [];
  const key = normalizeText(template?.key);

  if (Array.isArray(template?.aliases)) {
    for (const alias of template.aliases) {
      const normalizedAlias = normalizeText(alias);
      if (normalizedAlias && !dedupe.has(normalizedAlias)) {
        dedupe.add(normalizedAlias);
        ordered.push(normalizedAlias);
      }
    }
  }

  if (key && !dedupe.has(key)) {
    dedupe.add(key);
    ordered.push(key);
  }

  return ordered;
}

function candidate(template, templateIndex, alias, aliasIndex) {
  return {
    key: template.key,
    expansion: template.expansion,
    alias,
    aliasLength: alias.length,
    templateIndex,
    aliasIndex,
  };
}

function pickBestCandidate(candidates) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    if (b.aliasLength !== a.aliasLength) {
      return b.aliasLength - a.aliasLength;
    }
    if (a.templateIndex !== b.templateIndex) {
      return a.templateIndex - b.templateIndex;
    }
    return a.aliasIndex - b.aliasIndex;
  });

  return sorted[0] || null;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function containsAliasPhrase(prompt, alias) {
  const escapedAlias = escapeRegex(alias);
  const re = new RegExp(`(^|[^a-z0-9])${escapedAlias}($|[^a-z0-9])`);
  return re.test(prompt);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
