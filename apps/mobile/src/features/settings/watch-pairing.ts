export type WatchPairingMode = "automatic" | "phone";

export function watchPairingMode(origin: string): WatchPairingMode {
  try {
    const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".ts.net")
    ) {
      return "phone";
    }
    if (
      hostname.includes(":") &&
      (hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        /^fe[89ab]/.test(hostname))
    ) {
      return "phone";
    }
    const octets = hostname.split(".").map(Number);
    if (
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168))
    ) {
      return "phone";
    }
  } catch {
    // Saved connection URLs are validated elsewhere. Automatic is the safe fallback.
  }
  return "automatic";
}
