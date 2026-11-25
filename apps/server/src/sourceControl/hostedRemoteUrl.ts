import { parseGitRemoteRepository } from "@t3tools/shared/git";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";

export function hostedRemoteUrl(url: string | null): string | null {
  if (url === null || /^file:/iu.test(url)) return null;
  return parseGitRemoteHost(url) !== null || parseGitRemoteRepository(url)?.host.startsWith("[")
    ? url
    : null;
}
