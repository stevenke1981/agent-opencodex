import { AcceptanceError } from "../errors.mjs";

const CHECK_TYPES = new Set(["file", "json", "command", "http", "llm"]);

export function validateAcceptanceSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) errors.push("spec must be an object");
  if (spec?.version !== 1) errors.push("spec.version must be 1");
  if (typeof spec?.name !== "string" || !spec.name.trim()) errors.push("spec.name is required");
  if (spec?.services != null && !Array.isArray(spec.services)) errors.push("services must be an array");
  if (!Array.isArray(spec?.checks) || spec.checks.length === 0) errors.push("checks must be a non-empty array");

  const serviceIds = new Set();
  for (const [index, service] of (spec?.services ?? []).entries()) {
    if (!service || typeof service !== "object") { errors.push(`services[${index}] must be an object`); continue; }
    if (typeof service.id !== "string" || !service.id) errors.push(`services[${index}].id is required`);
    else if (serviceIds.has(service.id)) errors.push(`duplicate service id '${service.id}'`);
    else serviceIds.add(service.id);
    validateCommand(service.command, `services[${index}].command`, errors);
    if (service.ports != null && (typeof service.ports !== "object" || Array.isArray(service.ports))) errors.push(`services[${index}].ports must be an object`);
    if (!service.ready || typeof service.ready.url !== "string") errors.push(`services[${index}].ready.url is required`);
  }

  const checkIds = new Set();
  for (const [index, check] of (spec?.checks ?? []).entries()) {
    if (!check || typeof check !== "object") { errors.push(`checks[${index}] must be an object`); continue; }
    if (typeof check.id !== "string" || !check.id) errors.push(`checks[${index}].id is required`);
    else if (checkIds.has(check.id)) errors.push(`duplicate check id '${check.id}'`);
    else checkIds.add(check.id);
    if (!CHECK_TYPES.has(check.type)) errors.push(`checks[${index}].type is unsupported: ${check.type}`);
    if (check.type === "command") validateCommand(check.command, `checks[${index}].command`, errors);
    if (["file", "json"].includes(check.type) && typeof check.path !== "string") errors.push(`checks[${index}].path is required`);
    if (["http", "llm"].includes(check.type) && typeof (check.url ?? check.endpoint) !== "string") errors.push(`checks[${index}] requires url or endpoint`);
  }

  if (errors.length) throw new AcceptanceError("Acceptance specification validation failed", errors);
  return spec;
}

function validateCommand(command, label, errors) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    errors.push(`${label} must be a non-empty array of strings`);
  }
}
