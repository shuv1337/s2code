const DEFAULT_LEGAL_DOCS_BASE_URL = "https://github.com/shuv1337/s2code/blob/main/";

function resolveLegalDocsBaseUrl(override: string | undefined): URL {
  try {
    const url = new URL(override?.trim() || DEFAULT_LEGAL_DOCS_BASE_URL);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname === "t3.codes" ||
      url.hostname.endsWith(".t3.codes")
    ) {
      return new URL(DEFAULT_LEGAL_DOCS_BASE_URL);
    }

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return new URL(DEFAULT_LEGAL_DOCS_BASE_URL);
  }
}

const LEGAL_DOCS_BASE_URL = resolveLegalDocsBaseUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function legalDocumentUrl(path: string): string {
  return new URL(path, LEGAL_DOCS_BASE_URL).toString();
}

export const LEGAL_URL = legalDocumentUrl("docs/user/telemetry.md");
const SECURITY_POLICY_URL = legalDocumentUrl("SECURITY.md");
const LICENSE_URL = legalDocumentUrl("LICENSE");

const ALLOWED_LEGAL_DOCUMENT_URLS = [LEGAL_URL, SECURITY_POLICY_URL, LICENSE_URL] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
