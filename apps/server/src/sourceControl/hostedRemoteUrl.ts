import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";

export function hostedRemoteUrl(url: string | null): string | null {
  if (url === null || /^file:/iu.test(url)) return null;
  return parseGitRemoteHost(url) === null ? null : url;
}
