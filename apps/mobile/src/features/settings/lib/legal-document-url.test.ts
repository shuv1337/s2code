import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl, LEGAL_URL } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it("points LEGAL_URL at the fork telemetry doc and allows fork legal documents", () => {
    expect(LEGAL_URL).toBe("https://github.com/shuv1337/s2code/blob/main/docs/user/telemetry.md");
    expect(isLegalDocumentUrl(LEGAL_URL)).toBe(true);
    expect(isLegalDocumentUrl("https://github.com/shuv1337/s2code/blob/main/SECURITY.md")).toBe(
      true,
    );
    expect(isLegalDocumentUrl("https://github.com/shuv1337/s2code/blob/main/LICENSE")).toBe(true);
  });

  it.each([
    "https://example.com/legal",
    "https://t3.codes/legal",
    "https://t3.codes/privacy-policy",
    "https://t3.codes/security-policy",
    "https://t3.codes/terms-of-service",
    "javascript:alert(1)",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
