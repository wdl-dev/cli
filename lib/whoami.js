import { CliError, isNonEmptyString, readJsonOrFail } from "./common.js";
import { escapeTerminalText } from "./output.js";
import { currentCliVersion } from "./package-info.js";

/**
 * @typedef {object} WhoamiPrincipal
 * @property {string} kind
 * @property {string} [ns]
 */

/**
 * Public-facing subset of a whoami principal, after stripping non-public fields.
 * @typedef {object} PublicPrincipal
 * @property {string} kind
 * @property {string} [ns]
 */

/**
 * Raw whoami response body as returned by the control plane.
 * @typedef {object} WhoamiBody
 * @property {boolean} [ok]
 * @property {WhoamiPrincipal} [principal]
 * @property {string} [tokenId]
 * @property {string} [requestId]
 * @property {string} [platformVersion]
 * @property {string} [minCliVersion]
 * @property {Record<string, unknown>} [urls]
 */

/**
 * @typedef {object} CliCompatibility
 * @property {boolean} ok
 * @property {string} label
 * @property {string} detail
 */

/**
 * @param {{
 *   controlUrl: string,
 *   headers: Record<string, string>,
 *   controlFetch: typeof import("./control-fetch.js").controlFetch,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {Promise<WhoamiBody>}
 */
export async function fetchWhoami({ controlUrl, headers, controlFetch, env }) {
  const init = env ? { headers, env } : { headers };
  const res = await controlFetch(`${controlUrl}/whoami`, init);
  const body = /** @type {WhoamiBody} */ (await readJsonOrFail(res, "whoami"));
  if (body?.ok !== true) throw new CliError("whoami failed: invalid control response");
  return body;
}

/**
 * @param {WhoamiBody | null | undefined} body
 * @param {string} [cliVersion]
 */
export function summarizeWhoami(body, cliVersion = currentCliVersion()) {
  const minCliVersion = stringField(body?.minCliVersion);
  return {
    ok: body?.ok === true,
    principal: publicPrincipal(body?.principal),
    principalLabel: formatPrincipal(body?.principal),
    tokenId: stringField(body?.tokenId),
    requestId: stringField(body?.requestId),
    platformVersion: stringField(body?.platformVersion),
    minCliVersion,
    cliVersion,
    compatibility: cliCompatibility(cliVersion, minCliVersion),
    urls: publicUrls(body?.urls),
  };
}

/**
 * @param {string | undefined} cliVersion
 * @param {string} minCliVersion
 * @returns {CliCompatibility}
 */
export function cliCompatibility(cliVersion, minCliVersion) {
  if (!minCliVersion) {
    return {
      ok: true,
      label: "unknown",
      detail: "control did not report a minimum CLI version",
    };
  }
  const cmp = compareSemver(cliVersion, minCliVersion);
  if (cmp === null) {
    return {
      ok: false,
      label: "unknown",
      detail: `cannot compare CLI ${cliVersion} with required ${minCliVersion}`,
    };
  }
  return {
    ok: cmp >= 0,
    label: cmp >= 0 ? "supported" : "unsupported",
    detail: cmp >= 0
      ? `CLI ${cliVersion} satisfies control minimum ${minCliVersion}`
      : `CLI ${cliVersion} is older than control minimum ${minCliVersion}`,
  };
}

/**
 * @param {string | undefined} left
 * @param {string} right
 * @returns {number | null}
 */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i] ? 1 : -1;
  }
  // Per semver, X.Y.Z-pre < X.Y.Z. Identifier-level ordering between two
  // pre-releases is overkill for a minimum-version gate; treat them equal.
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

/**
 * @param {unknown} principal
 * @returns {string}
 */
export function formatPrincipal(principal) {
  const publicShape = publicPrincipal(principal);
  if (!publicShape) return "(unavailable)";
  return publicShape.ns ? `${publicShape.kind}/${publicShape.ns}` : publicShape.kind;
}

/**
 * @param {unknown} principal
 * @returns {string | null}
 */
export function namespaceFromPrincipal(principal) {
  const publicShape = publicPrincipal(principal);
  return publicShape?.ns || null;
}

/**
 * @param {unknown} principal
 * @returns {PublicPrincipal | null}
 */
function publicPrincipal(principal) {
  if (!principal || typeof principal !== "object" || !("kind" in principal) || typeof principal.kind !== "string") {
    return null;
  }
  const ns = /** @type {{ ns?: unknown }} */ (principal).ns;
  if (isNonEmptyString(ns)) {
    return { kind: principal.kind, ns };
  }
  return { kind: principal.kind };
}

/**
 * @param {Record<string, unknown> | undefined} urls
 * @returns {Record<string, string>}
 */
function publicUrls(urls) {
  if (!urls || typeof urls !== "object") return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of ["control", "namespace", "assets"]) {
    const value = stringField(urls[key]);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {{ nums: number[], prerelease: boolean } | null}
 */
function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(String(value || ""));
  if (!match) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringField(value) {
  return isNonEmptyString(value) ? value : "";
}

/**
 * @param {{
 *   controlUrl: import("./config-state.js").ConfigEntry,
 *   token: import("./config-state.js").ConfigEntry,
 * }} state
 * @returns {{ controlUrl: string, token: string, headers: Record<string, string> }}
 */
export function ensureControlContextFromConfigState(state) {
  if (state.controlUrl.error) throw new CliError(state.controlUrl.error);
  // Fail closed: a null value with no error shouldn't happen given config-state's
  // resolver (it sets `error` on failure), but never return null typed as string.
  if (!state.controlUrl.value) {
    throw new CliError("No control URL configured. Set CONTROL_URL (e.g. in ./.env), or pass --control-url.");
  }
  if (!state.token.value) throw new CliError("Missing admin token. Run 'wdl token set --ns <ns> --control-url <url>' (recommended), pass --token <tok>, or set ADMIN_TOKEN.");
  return {
    controlUrl: state.controlUrl.value,
    token: state.token.value,
    headers: { "x-admin-token": state.token.value },
  };
}

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function displayRemoteValue(value) {
  return escapeTerminalText(value || "(unavailable)");
}
