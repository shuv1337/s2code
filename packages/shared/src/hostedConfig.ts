/** Reject upstream hosted defaults in released fork clients. */
export const UPSTREAM_HOSTED_DOMAINS = [
  "t3.codes",
  "t3coderelay.com",
  "t3tools.com",
  "ping.gg",
  "pingdotgg.github.io",
  "t3tools.github.io",
] as const;
export const HOSTED_UNAVAILABLE_MESSAGE =
  "Hosted Connect is unavailable: this fork has no configured cloud service. Use direct or Tailscale pairing instead. Upstream accounts are separate.";

export function isUpstreamHostedDomain(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return UPSTREAM_HOSTED_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`));
}

export function forkHostedOrigin(
  value: string | null | undefined,
  allowLoopback = false,
): string | null {
  try {
    const url = new URL(value ?? "");
    const loopback =
      allowLoopback &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (!loopback && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !/^\/+$/u.test(url.pathname) ||
      url.search ||
      url.hash ||
      isUpstreamHostedDomain(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function forkClerkPublishableKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  if (!key || !/^pk_(test|live)_/.test(key)) return null;
  try {
    const host = atob(key.split("_").slice(2).join("_")).replace(/\$$/, "");
    const origin = forkHostedOrigin(`https://${host}`);
    return origin && new URL(origin).hostname === host.toLowerCase().replace(/\.+$/, "")
      ? key
      : null;
  } catch {
    return null;
  }
}
