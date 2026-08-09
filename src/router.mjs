import { RequestError } from "./errors.mjs";

export function resolveRouteCandidates(modelSelector, config) {
  const selector = modelSelector || config.defaults.model;
  const namedRoute = config.routes?.[selector];
  if (namedRoute) {
    return namedRoute.map((candidate, index) => materializeCandidate(candidate.provider, candidate.model, selector, index, config));
  }

  const providerId = config.defaults.provider;
  const defaultProvider = config.providers?.[providerId];
  const isDeclaredDefaultModel = selector === config.defaults.model
    || defaultProvider?.models?.includes(selector)
    || Object.prototype.hasOwnProperty.call(defaultProvider?.modelMap ?? {}, selector);
  if (isDeclaredDefaultModel) {
    return [materializeCandidate(providerId, selector, selector, 0, config)];
  }

  const slash = selector.indexOf("/");
  if (slash > 0) {
    const prefix = selector.slice(0, slash);
    const remainder = selector.slice(slash + 1);
    if (config.providers[prefix] && remainder) {
      return [materializeCandidate(prefix, remainder, selector, 0, config)];
    }
  }

  return [materializeCandidate(providerId, selector, selector, 0, config)];
}

function materializeCandidate(providerId, requestedModel, selector, index, config) {
  const provider = config.providers[providerId];
  if (!provider) throw new RequestError(`Unknown provider '${providerId}'`, { code: "unknown_provider" });
  const upstreamModel = provider.modelMap?.[requestedModel] ?? requestedModel;
  return {
    selector,
    index,
    providerId,
    provider,
    requestedModel,
    upstreamModel,
  };
}

export function listModels(config) {
  const seen = new Set();
  const models = [];
  const add = (id, ownedBy, metadata = {}) => {
    if (seen.has(id)) return;
    seen.add(id);
    models.push({
      id,
      object: "model",
      created: 0,
      owned_by: ownedBy,
      ...metadata,
    });
  };

  for (const routeName of Object.keys(config.routes ?? {})) {
    add(routeName, "agent-opencodex", { route: true });
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models ?? []) {
      add(`${providerId}/${model}`, providerId, { upstream_model: provider.modelMap?.[model] ?? model });
      if (providerId === config.defaults.provider) add(model, providerId);
    }
  }
  if (config.defaults.model) add(config.defaults.model, config.defaults.provider, { default: true });
  return models;
}

export function describeRoute(modelSelector, config) {
  return resolveRouteCandidates(modelSelector, config).map((candidate) => ({
    selector: candidate.selector,
    provider: candidate.providerId,
    providerType: candidate.provider.type,
    requestedModel: candidate.requestedModel,
    upstreamModel: candidate.upstreamModel,
    baseUrl: candidate.provider.baseUrl,
  }));
}
