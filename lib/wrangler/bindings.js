import {
  NS_PATTERN,
  BINDING_NAME_RE,
  R2_BUCKET_NAME_RE,
  RESERVED_OBJECT_KEYS,
  WORKFLOW_NAME_RE,
  WDL_RESERVED_BINDING_RE,
  WDL_RESERVED_ENTRYPOINT_RE,
  isValidJsClassDeclarationName,
  isAdminAcceptableNs,
  isValidJsIdentifier,
} from "../ns-pattern.js";
import { escapeTerminalText, formatDiagnosticValue } from "../output.js";

import { asRecord } from "./utils.js";

/** @typedef {import("./config.js").WranglerConfig} WranglerConfig */

const NS_RE = new RegExp(`^${NS_PATTERN}$`);
const MAX_QUEUE_DELAY_SECONDS = 86_400;

// UPPER_SNAKE for `as` / `platform` / required_caller_secrets - narrower
// than binding names to read as registered identifiers.
const PLATFORM_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** @param {unknown} value */
function formatConfigLabel(value) {
  return escapeTerminalText(String(value));
}

/** @param {string} configRel */
function formatConfigRel(configRel) {
  return formatConfigLabel(configRel);
}

/** @param {Iterable<string>} keys */
function formatConfigKeyList(keys) {
  return [...keys].map(formatConfigLabel).join(", ");
}

/**
 * The caller may hand any value: these helpers validate via regex, which
 * stringifies its argument, so `binding` is the unvalidated config value.
 * @param {string} configRel
 * @param {string} scope
 * @param {unknown} binding
 */
export function assertNotRuntimeReservedBinding(configRel, scope, binding) {
  configRel = formatConfigRel(configRel);
  if (WDL_RESERVED_BINDING_RE.test(String(binding))) {
    throw new Error(
      `${configRel}: ${scope} ${formatConfigLabel(binding)}: binding name is reserved for runtime-internal bindings`
    );
  }
}

// Manifest env bindings (kv/d1/r2/services/durable_objects/queues) must be JS
// identifiers so `env.<NAME>` resolves at runtime. workflows validate the same
// way in their own parser; platform_bindings/exports use the narrower
// PLATFORM_KEY_RE instead.
/**
 * @param {string} configRel
 * @param {string} scope
 * @param {unknown} binding  Unvalidated config value; regex `.test` stringifies it.
 */
export function assertValidBindingName(configRel, scope, binding) {
  configRel = formatConfigRel(configRel);
  if (!BINDING_NAME_RE.test(String(binding))) {
    throw new Error(`${configRel}: ${scope} ${formatConfigLabel(binding)}: binding must match ${BINDING_NAME_RE}`);
  }
}

/**
 * @param {unknown} triggers
 * @param {string} [configRel]
 * @returns {Array<{ cron: string, timezone: string }>}
 */
export function parseTriggers(triggers, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (triggers == null) return [];
  const triggersTable = asRecord(triggers);
  if (!triggersTable) {
    throw new Error(`${configRel}: [triggers] must be a table`);
  }
  /** @type {Array<{ cron: string, timezone: string }>} */
  const out = [];
  if (triggersTable.crons != null) {
    if (!Array.isArray(triggersTable.crons)) {
      throw new Error(`${configRel}: triggers.crons must be an array of strings`);
    }
    for (const entry of triggersTable.crons) {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error(`${configRel}: triggers.crons entries must be non-empty strings`);
      }
      out.push({ cron: entry.trim(), timezone: "UTC" });
    }
  }
  if (triggersTable.schedules != null) {
    if (!Array.isArray(triggersTable.schedules)) {
      throw new Error(`${configRel}: [[triggers.schedules]] must be an array of tables`);
    }
    for (const rawEntry of triggersTable.schedules) {
      const entry = asRecord(rawEntry);
      if (!entry) {
        throw new Error(`${configRel}: [[triggers.schedules]] entry must be a table`);
      }
      if (typeof entry.cron !== "string" || !entry.cron.trim()) {
        throw new Error(`${configRel}: [[triggers.schedules]].cron is required`);
      }
      const tz = entry.timezone == null ? "UTC" : entry.timezone;
      if (typeof tz !== "string" || !tz.trim()) {
        throw new Error(`${configRel}: [[triggers.schedules]].timezone must be a string`);
      }
      out.push({ cron: entry.cron.trim(), timezone: tz.trim() });
    }
  }
  return out;
}

/**
 * @typedef {object} QueueProducer
 * @property {string} binding
 * @property {string} queue
 * @property {number} [deliveryDelaySeconds]
 */

/**
 * @typedef {object} QueueConsumer
 * @property {string} queue
 * @property {unknown} [maxBatchSize]
 * @property {number} [maxBatchTimeoutMs]
 * @property {unknown} [maxRetries]
 * @property {number} [retryDelaySeconds]
 * @property {unknown} [deadLetterQueue]
 */

/**
 * @param {unknown} queues
 * @param {string} [configRel]
 * @returns {{ producers: QueueProducer[], consumers: QueueConsumer[] }}
 */
export function parseQueues(queues, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (queues == null) return { producers: [], consumers: [] };
  const queuesTable = asRecord(queues);
  if (!queuesTable) {
    throw new Error(`${configRel}: [queues] must be a table`);
  }
  /** @type {QueueProducer[]} */
  const producers = [];
  if (queuesTable.producers != null) {
    if (!Array.isArray(queuesTable.producers)) {
      throw new Error(`${configRel}: [[queues.producers]] must be an array of tables`);
    }
    for (const rawProducer of queuesTable.producers) {
      const p = asRecord(rawProducer);
      if (!p) {
        throw new Error(`${configRel}: [[queues.producers]] entry must be a table`);
      }
      if (typeof p.binding !== "string" || !p.binding.trim()) {
        throw new Error(`${configRel}: [[queues.producers]].binding is required`);
      }
      assertNotRuntimeReservedBinding(configRel, "[[queues.producers]]", p.binding);
      assertValidBindingName(configRel, "[[queues.producers]]", p.binding);
      if (typeof p.queue !== "string" || !p.queue.trim()) {
        throw new Error(`${configRel}: [[queues.producers]].queue is required`);
      }
      /** @type {QueueProducer} */
      const producer = { binding: p.binding, queue: p.queue };
      if (p.delivery_delay != null) {
        producer.deliveryDelaySeconds = normalizeQueueDelayConfig(
          p.delivery_delay,
          configRel,
          `[[queues.producers]] ${formatConfigLabel(p.binding)}.delivery_delay`
        );
      }
      producers.push(producer);
    }
  }
  /** @type {QueueConsumer[]} */
  const consumers = [];
  if (queuesTable.consumers != null) {
    if (!Array.isArray(queuesTable.consumers)) {
      throw new Error(`${configRel}: [[queues.consumers]] must be an array of tables`);
    }
    for (const rawConsumer of queuesTable.consumers) {
      const c = asRecord(rawConsumer);
      if (!c) {
        throw new Error(`${configRel}: [[queues.consumers]] entry must be a table`);
      }
      if (typeof c.queue !== "string" || !c.queue.trim()) {
        throw new Error(`${configRel}: [[queues.consumers]].queue is required`);
      }
      if (c.max_concurrency != null) {
        throw new Error(
          `${configRel}: [[queues.consumers]] ${formatConfigLabel(c.queue)}: max_concurrency not supported`
        );
      }
      /** @type {QueueConsumer} */
      const entry = { queue: c.queue };
      if (c.max_batch_size != null) entry.maxBatchSize = c.max_batch_size;
      if (c.max_batch_timeout != null) {
        entry.maxBatchTimeoutMs = normalizeQueueDelayConfig(
          c.max_batch_timeout,
          configRel,
          `[[queues.consumers]] ${formatConfigLabel(c.queue)}.max_batch_timeout`
        ) * 1000;
      }
      if (c.max_retries != null) entry.maxRetries = c.max_retries;
      if (c.retry_delay != null) {
        entry.retryDelaySeconds = normalizeQueueDelayConfig(
          c.retry_delay,
          configRel,
          `[[queues.consumers]] ${formatConfigLabel(c.queue)}.retry_delay`
        );
      }
      if (c.dead_letter_queue != null) entry.deadLetterQueue = c.dead_letter_queue;
      consumers.push(entry);
    }
  }
  return { producers, consumers };
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ binding: string, id: string }>}
 */
export function parseKvNamespacesFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.kv_namespaces == null) return [];
  if (!Array.isArray(cfg.kv_namespaces)) {
    throw new Error(`${configRel}: [[kv_namespaces]] must be an array of tables`);
  }
  // preview_id and remote are Wrangler `wrangler dev` (local-dev) concepts WDL
  // doesn't use; allow them (ignored — only binding/id are forwarded) but reject
  // other unknown keys, matching the d1/r2 parsers.
  const allowedKeys = new Set(["binding", "id", "preview_id", "remote"]);
  /** @type {Array<{ binding: string, id: string }>} */
  const out = [];
  for (const rawEntry of cfg.kv_namespaces) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[kv_namespaces]] entry must be a table`);
    }
    const unknownKeys = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(
        `${configRel}: [[kv_namespaces]] contains unknown field(s): ${formatConfigKeyList(unknownKeys)}`
      );
    }
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      throw new Error(`${configRel}: [[kv_namespaces]] entry needs a non-empty string 'binding'`);
    }
    assertNotRuntimeReservedBinding(configRel, "[[kv_namespaces]]", entry.binding);
    assertValidBindingName(configRel, "[[kv_namespaces]]", entry.binding);
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error(`${configRel}: [[kv_namespaces]] ${formatConfigLabel(entry.binding)}: 'id' must be a non-empty string`);
    }
    // Store trimmed values like the d1/r2 parsers, so a stray "abc " id isn't
    // forwarded with whitespace.
    out.push({ binding: entry.binding.trim(), id: entry.id.trim() });
  }
  return out;
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ binding: string, databaseId: string }>}
 */
export function parseD1DatabasesFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.d1_databases == null) return [];
  if (!Array.isArray(cfg.d1_databases)) {
    throw new Error(`${configRel}: [[d1_databases]] must be an array of tables`);
  }

  const allowedKeys = new Set([
    "binding",
    "database_id",
    "database_name",
    "preview_database_id",
    "migrations_dir",
    "migrations_table",
  ]);
  /** @type {Array<{ binding: string, databaseId: string }>} */
  const out = [];
  for (const rawEntry of cfg.d1_databases) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[d1_databases]] entry must be a table`);
    }
    const unknownKeys = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(
        `${configRel}: [[d1_databases]] contains unknown field(s): ${formatConfigKeyList(unknownKeys)}`
      );
    }
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      throw new Error(`${configRel}: [[d1_databases]].binding is required`);
    }
    assertNotRuntimeReservedBinding(configRel, "[[d1_databases]]", entry.binding);
    assertValidBindingName(configRel, "[[d1_databases]]", entry.binding);

    const databaseRef = typeof entry.database_id === "string" && entry.database_id.trim()
      ? entry.database_id.trim()
      : entry.database_name;
    if (typeof databaseRef !== "string" || !databaseRef.trim()) {
      throw new Error(`${configRel}: [[d1_databases]] ${formatConfigLabel(entry.binding)}: database_name or database_id is required`);
    }
    out.push({ binding: entry.binding.trim(), databaseId: databaseRef.trim() });
  }
  return out;
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ binding: string, bucketName: string }>}
 */
export function parseR2BucketsFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.r2_buckets == null) return [];
  if (!Array.isArray(cfg.r2_buckets)) {
    throw new Error(`${configRel}: [[r2_buckets]] must be an array of tables`);
  }
  const allowedKeys = new Set(["binding", "bucket_name", "preview_bucket_name", "jurisdiction"]);
  /** @type {Array<{ binding: string, bucketName: string }>} */
  const out = [];
  for (const rawEntry of cfg.r2_buckets) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[r2_buckets]] entry must be a table`);
    }
    const unknownKeys = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(
        `${configRel}: [[r2_buckets]] contains unknown field(s): ${formatConfigKeyList(unknownKeys)}`
      );
    }
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      throw new Error(`${configRel}: [[r2_buckets]].binding is required`);
    }
    assertNotRuntimeReservedBinding(configRel, "[[r2_buckets]]", entry.binding);
    assertValidBindingName(configRel, "[[r2_buckets]]", entry.binding);
    if (typeof entry.bucket_name !== "string" || !entry.bucket_name.trim()) {
      throw new Error(`${configRel}: [[r2_buckets]] ${formatConfigLabel(entry.binding)}: bucket_name is required`);
    }
    if (entry.preview_bucket_name != null) {
      throw new Error(
        `${configRel}: [[r2_buckets]] ${formatConfigLabel(entry.binding)}: preview_bucket_name is not supported by WDL R2`
      );
    }
    if (entry.jurisdiction != null) {
      throw new Error(
        `${configRel}: [[r2_buckets]] ${formatConfigLabel(entry.binding)}: jurisdiction is not supported by WDL R2`
      );
    }
    const bucketName = entry.bucket_name.trim();
    if (!R2_BUCKET_NAME_RE.test(bucketName)) {
      throw new Error(
        `${configRel}: [[r2_buckets]] ${formatConfigLabel(entry.binding)}: bucket_name must match ${R2_BUCKET_NAME_RE}`
      );
    }
    out.push({ binding: entry.binding.trim(), bucketName });
  }
  return out;
}

/**
 * `binding` and `service` are validated as non-empty strings; `entrypoint` and
 * `ns`, when present, are validated as a JS identifier / admin-acceptable
 * namespace (both narrowed to string by their type-predicate validators).
 * @typedef {object} ServiceBinding
 * @property {string} binding
 * @property {string} service
 * @property {string} [entrypoint]
 * @property {string} [ns]
 */

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {ServiceBinding[]}
 */
export function parseServicesFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.services == null) return [];
  if (!Array.isArray(cfg.services)) {
    throw new Error(`${configRel}: [[services]] must be an array of tables`);
  }
  /** @type {ServiceBinding[]} */
  const out = [];
  for (const rawEntry of cfg.services) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[services]] entry must be a table`);
    }
    if (entry.binding == null || entry.service == null) {
      throw new Error(`${configRel}: [[services]] entry needs both 'binding' and 'service'`);
    }
    // Nullish (not truthy) above, so a present-but-empty/invalid value reaches
    // these string checks instead of the generic "needs both" error. They match
    // the d1/r2 parsers: without them a non-string truthy `service` flows into
    // the manifest, and a non-string `binding` (e.g. ["AB"]) would be silently
    // String()-coerced past the BINDING_NAME_RE check below.
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      throw new Error(`${configRel}: [[services]] binding must be a non-empty string, got ${formatDiagnosticValue(entry.binding)}`);
    }
    if (typeof entry.service !== "string" || !entry.service.trim()) {
      throw new Error(`${configRel}: [[services]] ${formatConfigLabel(entry.binding)}: service must be a non-empty string, got ${formatDiagnosticValue(entry.service)}`);
    }
    assertNotRuntimeReservedBinding(configRel, "[[services]]", entry.binding);
    assertValidBindingName(configRel, "[[services]]", entry.binding);
    // Validate and capture in the same block so the predicate narrowing flows
    // into the typed entrypoint/ns fields below.
    /** @type {string | undefined} */
    let entrypoint;
    if (entry.entrypoint != null) {
      if (!isValidJsIdentifier(entry.entrypoint)) {
        throw new Error(
          `${configRel}: [[services]] ${formatConfigLabel(entry.binding)}: entrypoint must be a JS identifier, got ${formatDiagnosticValue(entry.entrypoint)}`
        );
      }
      if (WDL_RESERVED_ENTRYPOINT_RE.test(entry.entrypoint)) {
        throw new Error(
          `${configRel}: [[services]] ${formatConfigLabel(entry.binding)}: entrypoint ${formatDiagnosticValue(entry.entrypoint)} is reserved for runtime-injected entrypoints`
        );
      }
      entrypoint = entry.entrypoint;
    }
    /** @type {string | undefined} */
    let ns;
    if (entry.ns != null) {
      if (!isAdminAcceptableNs(entry.ns)) {
        throw new Error(
          `${configRel}: [[services]] ${formatConfigLabel(entry.binding)}: ns must match ${NS_PATTERN} or an operator-reserved namespace, got ${formatDiagnosticValue(entry.ns)}`
        );
      }
      ns = entry.ns;
    }
    /** @type {ServiceBinding} */
    const normalized = {
      binding: entry.binding,
      service: entry.service,
    };
    if (entrypoint != null) normalized.entrypoint = entrypoint;
    if (ns != null) normalized.ns = ns;
    out.push(normalized);
  }
  return out;
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ binding: string, className: string }>}
 */
export function parseDurableObjectsFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.durable_objects == null) return [];
  const durableObjects = asRecord(cfg.durable_objects);
  if (!durableObjects) {
    throw new Error(`${configRel}: [durable_objects] must be a table`);
  }
  const bindingList = durableObjects.bindings;
  if (bindingList == null) return [];
  if (!Array.isArray(bindingList)) {
    throw new Error(`${configRel}: [[durable_objects.bindings]] must be an array of tables`);
  }
  /** @type {Set<string>} */
  const newClasses = new Set();
  const migrations = cfg.migrations == null ? [] : cfg.migrations;
  if (!Array.isArray(migrations)) {
    throw new Error(`${configRel}: [[migrations]] must be an array of tables`);
  }
  for (const rawMigration of migrations) {
    const migration = asRecord(rawMigration);
    if (!migration) {
      throw new Error(`${configRel}: [[migrations]] entry must be a table`);
    }
    for (const key of ["renamed_classes", "deleted_classes", "transferred_classes"]) {
      if (migration[key] != null) {
        throw new Error(`${configRel}: [[migrations]].${key} is not supported by WDL Durable Objects yet`);
      }
    }
    for (const key of ["new_classes", "new_sqlite_classes"]) {
      const classNames = migration[key];
      if (classNames == null) continue;
      if (!Array.isArray(classNames)) {
        throw new Error(`${configRel}: [[migrations]].${key} must be an array of strings`);
      }
      for (const className of classNames) {
        if (!isValidJsClassDeclarationName(className)) {
          throw new Error(
            `${configRel}: [[migrations]].${key} entries must be valid JS class declaration names, got ${formatDiagnosticValue(className)}`
          );
        }
        if (WDL_RESERVED_ENTRYPOINT_RE.test(String(className))) {
          throw new Error(
            `${configRel}: [[migrations]].${key} entry ${formatDiagnosticValue(className)} is reserved for runtime-injected entrypoints`
          );
        }
        newClasses.add(className);
      }
    }
  }

  /** @type {Array<{ binding: string, className: string }>} */
  const out = [];
  for (const rawEntry of bindingList) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[durable_objects.bindings]] entry must be a table`);
    }
    if (entry.script_name != null) {
      throw new Error(`${configRel}: [[durable_objects.bindings]] ${formatConfigLabel(entry.name)}: script_name is not supported by WDL Durable Objects yet`);
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`${configRel}: [[durable_objects.bindings]].name is required`);
    }
    assertNotRuntimeReservedBinding(configRel, "[[durable_objects.bindings]]", entry.name);
    assertValidBindingName(configRel, "[[durable_objects.bindings]]", entry.name);
    if (!isValidJsClassDeclarationName(entry.class_name)) {
      throw new Error(
        `${configRel}: [[durable_objects.bindings]] ${formatConfigLabel(entry.name)}: class_name must be a valid JS class declaration name, got ${formatDiagnosticValue(entry.class_name)}`
      );
    }
    if (WDL_RESERVED_ENTRYPOINT_RE.test(String(entry.class_name))) {
      throw new Error(
        `${configRel}: [[durable_objects.bindings]] ${formatConfigLabel(entry.name)}: class_name ${formatDiagnosticValue(entry.class_name)} is reserved for runtime-injected entrypoints`
      );
    }
    if (!newClasses.has(entry.class_name)) {
      throw new Error(
        `${configRel}: [[durable_objects.bindings]] ${formatConfigLabel(entry.name)}: class_name ${formatConfigLabel(entry.class_name)} must be listed in [[migrations]].new_classes or [[migrations]].new_sqlite_classes`
      );
    }
    out.push({ binding: entry.name.trim(), className: entry.class_name });
  }
  return out;
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ name: string, binding: string, className: string }>}
 */
export function parseWorkflowsFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.workflows == null) return [];
  if (!Array.isArray(cfg.workflows)) {
    throw new Error(`${configRel}: [[workflows]] must be an array of tables`);
  }
  /** @type {Array<{ name: string, binding: string, className: string }>} */
  const out = [];
  /** @type {Set<string>} */
  const seenNames = new Set();
  /** @type {Set<string>} */
  const seenBindings = new Set();
  for (const rawEntry of cfg.workflows) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[workflows]] entry must be a table`);
    }
    if (entry.script_name != null) {
      throw new Error(`${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: script_name is not supported by WDL Workflows`);
    }
    if (typeof entry.name !== "string" || !WORKFLOW_NAME_RE.test(entry.name)) {
      throw new Error(
        `${configRel}: [[workflows]].name must match ${WORKFLOW_NAME_RE}, got ${formatDiagnosticValue(entry.name)}`
      );
    }
    if (RESERVED_OBJECT_KEYS.has(entry.name)) {
      throw new Error(`${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: name is a reserved Object.prototype key`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`${configRel}: [[workflows]] duplicate name ${formatDiagnosticValue(entry.name)}`);
    }
    seenNames.add(entry.name);
    if (typeof entry.binding !== "string" || !BINDING_NAME_RE.test(entry.binding)) {
      throw new Error(
        `${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: binding must match ${BINDING_NAME_RE}, got ${formatDiagnosticValue(entry.binding)}`
      );
    }
    assertNotRuntimeReservedBinding(configRel, "[[workflows]]", entry.binding);
    if (RESERVED_OBJECT_KEYS.has(entry.binding)) {
      throw new Error(`${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: binding is a reserved Object.prototype key`);
    }
    if (seenBindings.has(entry.binding)) {
      throw new Error(`${configRel}: [[workflows]] duplicate binding ${formatDiagnosticValue(entry.binding)}`);
    }
    seenBindings.add(entry.binding);
    if (!isValidJsClassDeclarationName(entry.class_name)) {
      throw new Error(
        `${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: class_name must be a valid JS class declaration name, got ${formatDiagnosticValue(entry.class_name)}`
      );
    }
    if (WDL_RESERVED_ENTRYPOINT_RE.test(String(entry.class_name))) {
      throw new Error(
        `${configRel}: [[workflows]] ${formatConfigLabel(entry.name)}: class_name ${formatDiagnosticValue(entry.class_name)} is reserved for runtime-injected entrypoints`
      );
    }
    out.push({
      name: entry.name,
      binding: entry.binding,
      className: entry.class_name,
    });
  }
  return out;
}

/**
 * @typedef {object} ExportEntry
 * @property {string} entrypoint  Either "default" or a validated JS class name.
 * @property {string[]} allowedCallers
 * @property {string} [as]
 * @property {string[]} [requiredCallerSecrets]
 */

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {ExportEntry[]}
 */
export function parseExportsFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.exports == null) return [];
  if (!Array.isArray(cfg.exports)) {
    throw new Error(`${configRel}: [[exports]] must be an array of tables`);
  }
  /** @type {ExportEntry[]} */
  const out = [];
  for (const rawEntry of cfg.exports) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[exports]] entry must be a table`);
    }
    if (entry.entrypoint !== "default" && !isValidJsClassDeclarationName(entry.entrypoint)) {
      throw new Error(
        `${configRel}: [[exports]].entrypoint must be a valid JS class declaration name or "default", got ${formatDiagnosticValue(entry.entrypoint)}`
      );
    }
    if (WDL_RESERVED_ENTRYPOINT_RE.test(String(entry.entrypoint))) {
      throw new Error(
        `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: entrypoint is reserved for runtime-injected entrypoints`
      );
    }
    const allowedCallers = entry.allowed_callers;
    if (!Array.isArray(allowedCallers)) {
      throw new Error(
        `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: allowed_callers must be an array of strings`
      );
    }
    for (const c of allowedCallers) {
      if (typeof c !== "string" || (c !== "*" && !NS_RE.test(c))) {
        throw new Error(
          `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: allowed_callers entries must be "*" or match ${NS_PATTERN}, got ${formatDiagnosticValue(c)}`
        );
      }
    }
    /** @type {ExportEntry} */
    const wire = {
      entrypoint: entry.entrypoint,
      allowedCallers: /** @type {string[]} */ ([...allowedCallers]),
    };
    if (entry.as !== undefined) {
      if (typeof entry.as !== "string" || !PLATFORM_KEY_RE.test(entry.as)) {
        throw new Error(
          `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: as must match ${PLATFORM_KEY_RE}, got ${formatDiagnosticValue(entry.as)}`
        );
      }
      wire.as = entry.as;
    }
    if (entry.required_caller_secrets !== undefined) {
      const requiredCallerSecrets = entry.required_caller_secrets;
      if (!Array.isArray(requiredCallerSecrets)) {
        throw new Error(
          `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: required_caller_secrets must be an array`
        );
      }
      for (const k of requiredCallerSecrets) {
        if (typeof k !== "string" || !PLATFORM_KEY_RE.test(k)) {
          throw new Error(
            `${configRel}: [[exports]] ${formatConfigLabel(entry.entrypoint)}: required_caller_secrets entries must match ${PLATFORM_KEY_RE}, got ${formatDiagnosticValue(k)}`
          );
        }
      }
      wire.requiredCallerSecrets = /** @type {string[]} */ ([...requiredCallerSecrets]);
    }
    out.push(wire);
  }
  return out;
}

/**
 * @param {WranglerConfig} cfg
 * @param {string} [configRel]
 * @returns {Array<{ binding: string, platform: string }>}
 */
export function parsePlatformBindingsFromCfg(cfg, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  if (cfg.platform_bindings == null) return [];
  if (!Array.isArray(cfg.platform_bindings)) {
    throw new Error(`${configRel}: [[platform_bindings]] must be an array of tables`);
  }
  /** @type {Array<{ binding: string, platform: string }>} */
  const out = [];
  for (const rawEntry of cfg.platform_bindings) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`${configRel}: [[platform_bindings]] entry must be a table`);
    }
    if (typeof entry.binding !== "string" || !PLATFORM_KEY_RE.test(entry.binding)) {
      throw new Error(
        `${configRel}: [[platform_bindings]].binding must match ${PLATFORM_KEY_RE}, got ${formatDiagnosticValue(entry.binding)}`
      );
    }
    assertNotRuntimeReservedBinding(configRel, "[[platform_bindings]]", entry.binding);
    const platform = entry.platform == null ? entry.binding : entry.platform;
    if (typeof platform !== "string" || !PLATFORM_KEY_RE.test(platform)) {
      throw new Error(
        `${configRel}: [[platform_bindings]] ${formatConfigLabel(entry.binding)}: platform must match ${PLATFORM_KEY_RE}, got ${formatDiagnosticValue(entry.platform)}`
      );
    }
    out.push({ binding: entry.binding, platform });
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} configRel
 * @param {string} field
 * @returns {number}
 */
function normalizeQueueDelayConfig(value, configRel, field) {
  configRel = formatConfigRel(configRel);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_QUEUE_DELAY_SECONDS) {
    throw new Error(`${configRel}: ${formatConfigLabel(field)} must be an integer in [0, ${MAX_QUEUE_DELAY_SECONDS}]`);
  }
  return value;
}
