import { isIP } from "node:net";
import { CliError } from "./common.js";
import { formatDiagnosticValue } from "./output.js";

/**
 * @param {string} raw
 * @param {number} defaultPort
 * @returns {{ host: string, port: number }}
 */
export function parseControlConnectHost(raw, defaultPort) {
  const text = raw.trim();
  const display = formatDiagnosticValue(raw);
  if (!text) throw new CliError(`Invalid CONTROL_CONNECT_HOST ${display}: host is required`);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new CliError(`Invalid CONTROL_CONNECT_HOST ${display}: URL scheme must be http or https`);
      }
      const host = bareUrlHostname(parsed);
      if (!host) throw new CliError(`Invalid CONTROL_CONNECT_HOST ${display}: host is required`);
      const port = parsed.port || (parsed.protocol === "http:" ? 80 : 443);
      return { host, port: validPort(port, raw) };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(`Invalid CONTROL_CONNECT_HOST ${display}.`);
    }
  }

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    return { host: bracketed[1], port: validPort(bracketed[2] || defaultPort, raw) };
  }
  const hostPort = /^([^:]+):(\d+)$/.exec(text);
  if (hostPort) return { host: hostPort[1], port: validPort(hostPort[2], raw) };
  if (isIP(text) === 6) return { host: text, port: defaultPort };
  if (text.includes(":")) {
    throw new CliError(`Invalid CONTROL_CONNECT_HOST ${display}: use host:port or [ipv6]:port`);
  }
  return { host: text, port: defaultPort };
}

/**
 * Warning paths should not make a malformed override fail before the request
 * path reports the canonical validation error.
 * @param {string} raw
 */
export function controlConnectHostForWarning(raw) {
  try {
    return parseControlConnectHost(raw, 1).host;
  } catch {
    return raw.trim();
  }
}

/** @param {URL} u */
export function bareUrlHostname(u) {
  const match = /^\[(.*)\]$/.exec(u.hostname);
  return match ? match[1] : u.hostname;
}

/**
 * @param {string | number} value
 * @param {string} raw
 */
function validPort(value, raw) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid CONTROL_CONNECT_HOST ${formatDiagnosticValue(raw)}: port must be in [1, 65535]`);
  }
  return port;
}
