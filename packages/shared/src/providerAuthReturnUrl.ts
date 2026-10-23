import { isLoopbackHost } from "./preview.ts";
import { forkHostedOrigin } from "./hostedConfig.ts";

export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppUrl?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop =
      [
        "t3code:",
        "t3code-dev:",
        "s2code:",
        "s2code-dev:",
        "s2code-nightly:",
        "s2code-preview:",
        "shuv2code:",
        "shuv2code-dev:",
        "shuv2code-nightly:",
        "shuv2code-preview:",
      ].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || url.origin === forkHostedOrigin(hostedAppUrl));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
