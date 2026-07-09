import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { isHelpAlias } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, handleCliError, isMain, isNonEmptyString, optionHelp, optionParseOptions } from "../lib/common.js";
import { NS_PATTERN, RESERVED_TENANT_NS, isReservedNs } from "../lib/ns-pattern.js";
import { escapeTerminalText } from "../lib/output.js";
import { WRANGLER_WDL_TMP_PREFIX } from "../lib/wrangler/config.js";

const NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;
const WORKER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const TENANT_NS_RE = new RegExp(`^${NS_PATTERN}$`);
const IGNORABLE_DIR_ENTRIES = new Set([".git", ".DS_Store"]);
const DEFAULT_COMPATIBILITY_DATE = "2026-06-17";

const CLI_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const INIT_OPTIONS = [
  defineCliOption("ns", { type: "string" }, "--ns <ns>", "Tenant namespace baked into the deploy script (optional)."),
  defineCliOption("worker", { type: "string" }, "--worker <name>", "Worker name in wrangler.jsonc (defaults to <target>)."),
  defineCliOption("help", { type: "boolean", short: "h" }, "-h, --help", "Show this help."),
];

// init is not a defineCommand (no control plane / namespace), so its metadata
// is declared directly for the bin registry's help table. autoloadEnv is false:
// init only scaffolds files locally, so it must not load .env control vars or
// read the token store — a corrupt store must never block project scaffolding.
export const meta = {
  name: "init",
  summary: "Scaffold a new WDL Worker project.",
  autoloadEnv: false,
  parseOptions: optionParseOptions(INIT_OPTIONS),
};

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printHelp(0);
      return;
    }
    if (!args.target) {
      throw new CliError("missing <target> argument. Run `wdl init --help`.");
    }

    const { targetDir, packageName, isInPlace } = resolveTarget(args.target);

    if (!NAME_REGEX.test(packageName)) {
      throw new CliError(
        `project name "${escapeTerminalText(packageName)}" must match ${NAME_REGEX} ` +
        `(letter, then letters / digits / hyphens).`,
      );
    }

    const ns = args.ns ? args.ns.trim() : null;
    if (ns) validateNs(ns, "--ns");

    const workerName = (args.worker ? args.worker.trim() : "") || packageName;
    validateWorker(workerName, args.worker ? "--worker" : "worker name");

    await ensureEmpty(targetDir, isInPlace);
    await fs.mkdir(targetDir, { recursive: true });

    await writeStarter(targetDir, { packageName, workerName, ns });
    await copyAgentsDoc(targetDir);
    await fs.writeFile(path.join(targetDir, "CLAUDE.md"), "See AGENTS.md.\n");

    printNextSteps(args.target, { packageName, workerName, ns, isInPlace });
  } catch (err) {
    handleCliError(err);
  }
}

/**
 * @param {string[]} argv
 * @returns {{ target: string | null, ns: string | null, worker: string | null, help: boolean }}
 */
function parseArgs(argv) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      options: optionParseOptions(INIT_OPTIONS),
      allowPositionals: true,
    });
  } catch (err) {
    // node:util phrases this as "Unknown option '--x'."; re-map to the historical
    // "unknown flag: <flag>" wording (flag name best-effort from the message).
    if (err instanceof Error && /** @type {{ code?: unknown }} */ (err).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const flag = /'([^']+)'/.exec(err.message)?.[1] ?? "";
      throw new CliError(`unknown flag: ${escapeTerminalText(flag)}`);
    }
    throw err;
  }

  /** @type {{ ns?: string, worker?: string, help?: boolean }} */
  const values = parsed.values;
  const { positionals } = parsed;
  if (positionals.length > 1) {
    throw new CliError(`unexpected argument: ${escapeTerminalText(positionals[1])}`);
  }
  const helpAlias = isHelpAlias(positionals);
  return {
    target: helpAlias ? null : positionals[0] ?? null,
    ns: values.ns ?? null,
    worker: values.worker ?? null,
    help: Boolean(values.help || helpAlias),
  };
}

/**
 * @param {string} target
 * @returns {{ targetDir: string, packageName: string, isInPlace: boolean }}
 */
function resolveTarget(target) {
  if (target === ".") {
    const targetDir = process.cwd();
    return {
      targetDir,
      packageName: path.basename(targetDir),
      isInPlace: true,
    };
  }
  return {
    targetDir: path.resolve(process.cwd(), target),
    packageName: target,
    isInPlace: false,
  };
}

/**
 * @param {string} value
 * @param {string} label
 */
function validateNs(value, label) {
  if (!TENANT_NS_RE.test(value) || RESERVED_TENANT_NS.has(value) || isReservedNs(value)) {
    throw new CliError(
      `${escapeTerminalText(label)} "${escapeTerminalText(value)}" is not a valid tenant namespace ` +
      `(1-63 lowercase letters / digits / hyphens, start and end with a letter or digit; reserved names are not allowed).`,
    );
  }
}

/**
 * @param {string} value
 * @param {string} label
 */
function validateWorker(value, label) {
  if (!WORKER_NAME_REGEX.test(value)) {
    throw new CliError(
      `${escapeTerminalText(label)} "${escapeTerminalText(value)}" must match ${WORKER_NAME_REGEX} ` +
      `(letter or digit, then letters / digits / underscores / hyphens; up to 255 chars).`,
    );
  }
}

/**
 * @param {string} dir
 * @param {boolean} isInPlace
 */
async function ensureEmpty(dir, isInPlace) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err instanceof Error && /** @type {{ code?: unknown }} */ (err).code === "ENOENT") return;
    throw err;
  }
  const offending = entries.filter(name => !IGNORABLE_DIR_ENTRIES.has(name));
  if (offending.length === 0) return;
  const where = isInPlace ? "current directory" : escapeTerminalText(dir);
  throw new CliError(
    `${where} is not empty (found: ${offending.slice(0, 5).map(escapeTerminalText).join(", ")}` +
    (offending.length > 5 ? ", …" : "") +
    `). Refusing to overwrite.`,
  );
}

/**
 * @param {string} targetDir
 * @param {{ packageName: string, workerName: string, ns: string | null }} arg
 */
async function writeStarter(targetDir, { packageName, workerName, ns }) {
  const [wdlCliDep, wranglerDep] = await Promise.all([
    resolveWdlCliDep(process.env),
    resolveWranglerDep(),
  ]);

  const packageJson = JSON.stringify({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      deploy: ns ? `wdl deploy . --ns ${ns}` : "wdl deploy .",
      "dry-run": "wrangler deploy --dry-run --outdir=.deploy-dist",
    },
    devDependencies: {
      wrangler: wranglerDep,
      "@wdl-dev/cli": wdlCliDep,
    },
  }, null, 2) + "\n";

  const wranglerJsonc =
`{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${workerName}",
  "main": "src/index.js",
  "compatibility_date": "${DEFAULT_COMPATIBILITY_DATE}",
  // Add bindings as needed — see AGENTS.md.
}
`;

  const indexJs =
`export default {
  async fetch(request, env, ctx) {
    return new Response("Hello from ${workerName}");
  },
};
`;

  const gitignore =
`node_modules/
.deploy-dist/
.wrangler/
${WRANGLER_WDL_TMP_PREFIX}*.json
*.log

# Never commit tenant credentials
.env
.env.*
!.env.example
`;

  await fs.mkdir(path.join(targetDir, "src"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(targetDir, "package.json"), packageJson),
    fs.writeFile(path.join(targetDir, "wrangler.jsonc"), wranglerJsonc),
    fs.writeFile(path.join(targetDir, "src", "index.js"), indexJs),
    fs.writeFile(path.join(targetDir, ".gitignore"), gitignore),
  ]);
}

/** @param {NodeJS.ProcessEnv} env */
async function resolveWdlCliDep(env) {
  const localPath = env && env.WDL_CLI_LOCAL_PATH;
  if (isNonEmptyString(localPath)) {
    return `file:${localPath}`;
  }
  return `^${(await readWdlCliPackage()).version}`;
}

async function resolveWranglerDep() {
  const pkg = await readWdlCliPackage();
  const dep = pkg.dependencies?.wrangler;
  if (typeof dep !== "string" || dep.length === 0) {
    throw new CliError("could not read wrangler dependency from package.json");
  }
  return dep;
}

/**
 * @returns {Promise<{ version: string, dependencies?: Record<string, string> }>}
 */
async function readWdlCliPackage() {
  const text = await fs.readFile(path.join(CLI_ROOT, "package.json"), "utf8");
  const parsed = /** @type {{ version?: unknown, dependencies?: Record<string, string> }} */ (JSON.parse(text));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new CliError("could not read wdl-cli version from package.json");
  }
  return /** @type {{ version: string, dependencies?: Record<string, string> }} */ (parsed);
}

/** @param {string} targetDir */
async function copyAgentsDoc(targetDir) {
  const src = path.join(CLI_ROOT, "templates", "AGENTS.md");
  const dest = path.join(targetDir, "AGENTS.md");
  try {
    await fs.copyFile(src, dest);
  } catch (err) {
    if (err instanceof Error && /** @type {{ code?: unknown }} */ (err).code === "ENOENT") {
      throw new CliError(
        `templates/AGENTS.md missing from the wdl-cli package. ` +
        `If you installed from npm, please re-install; ` +
        `if you cloned, the file should live at ${src}.`,
      );
    }
    throw err;
  }
}

/**
 * @param {string} target
 * @param {{ packageName: string, workerName: string, ns: string | null, isInPlace: boolean }} arg
 */
function printNextSteps(target, { packageName, workerName, ns, isInPlace }) {
  const url = `https://${ns || "<namespace>"}.<platform-domain>/${workerName}/`;
  const lines = [
    "",
    `Scaffolded ${packageName}.`,
    "",
    "Worker URL after deploy (`npm run deploy` prints the actual URL):",
    `  ${url}`,
    "",
    "Next steps:",
  ];
  if (!isInPlace) lines.push(`  cd ${target}`);
  lines.push("  npm install");
  lines.push("");
  lines.push("Then open the project in your AI agent (Claude Code, Codex, etc.)");
  lines.push("and describe what you want to build. AGENTS.md is the entry point;");
  lines.push("the agent reads it to find the right per-feature docs under");
  lines.push("node_modules/@wdl-dev/cli/docs/.");
  lines.push("");
  if (ns) {
    lines.push(`Deploy (--ns ${ns} is baked into the npm script):`);
    lines.push("  npm run deploy");
  } else {
    lines.push("Deploy — pick a namespace (none is baked in):");
    lines.push("  npm run deploy -- --ns <namespace>");
    lines.push("  # or set WDL_NS / a project .env / a `wdl token` default, then: npm run deploy");
  }
  lines.push("");
  console.log(lines.join("\n"));
}

/** @param {number} exitCode */
function printHelp(exitCode) {
  console.log(formatHelp({
    usage: [
      "wdl init <target> [--ns <ns>] [--worker <name>]",
      "wdl init --help",
    ],
    description:
      "Scaffold a new WDL Worker project. <target> is a directory " +
      "name (creates ./<name>/) or '.' to scaffold into the current directory.",
    options: optionHelp(INIT_OPTIONS),
  }));
  process.exit(exitCode);
}

export const __test__ = { parseArgs, resolveTarget, validateNs, validateWorker, resolveWdlCliDep };

if (isMain(import.meta.url)) {
  await main();
}
