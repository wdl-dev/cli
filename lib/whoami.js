import { CliError, escapeTerminalText, readJsonOrFail } from "./common.js";
import { currentCliVersion } from "./package-info.js";

export async function fetchWhoami({ controlUrl, headers, controlFetch }) {
  const res = await controlFetch(`${controlUrl}/whoami`, { headers });
  const body = await readJsonOrFail(res, "whoami");
  if (body?.ok !== true) throw new CliError("whoami failed: invalid control response");
  return body;
}

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

export function formatPrincipal(principal) {
  const publicShape = publicPrincipal(principal);
  if (!publicShape) return "(unavailable)";
  return publicShape.ns ? `${publicShape.kind}/${publicShape.ns}` : publicShape.kind;
}

export function namespaceFromPrincipal(principal) {
  const publicShape = publicPrincipal(principal);
  return publicShape?.ns || null;
}

function publicPrincipal(principal) {
  if (!principal || typeof principal !== "object" || typeof principal.kind !== "string") return null;
  if (typeof principal.ns === "string" && principal.ns) {
    return { kind: principal.kind, ns: principal.ns };
  }
  return { kind: principal.kind };
}

function publicUrls(urls) {
  if (!urls || typeof urls !== "object") return {};
  const out = {};
  for (const key of ["control", "namespace", "assets"]) {
    const value = stringField(urls[key]);
    if (value) out[key] = value;
  }
  return out;
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(String(value || ""));
  if (!match) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

function stringField(value) {
  return typeof value === "string" && value ? value : "";
}

export function ensureControlContextFromConfigState(state) {
  if (state.controlUrl.error) throw new CliError(state.controlUrl.error);
  if (!state.token.value) throw new CliError("Missing admin token. Run 'wdl token set --ns <ns> --control-url <url>' (recommended), pass --token <tok>, or set ADMIN_TOKEN.");
  return {
    controlUrl: state.controlUrl.value,
    token: state.token.value,
    headers: { "x-admin-token": state.token.value },
  };
}

export function displayRemoteValue(value) {
  return escapeTerminalText(value || "(unavailable)");
}
