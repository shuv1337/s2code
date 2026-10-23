// @effect-diagnostics nodeBuiltinImport:off -- Runs the real publisher CLI against isolated command/HTTP fixtures; never reaches real publication tools.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { CLI_ARCHIVE_PLATFORM_KEYS } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  npmPlatformPackageManifest,
  npmLauncherPackageManifest,
} from "./build-npm-platform-packages.ts";
import { forkReleasePlan } from "./lib/fork-release.ts";
import { releaseCommandError } from "./fork-release.ts";

const shim = `import fs from 'node:fs'; import crypto from 'node:crypto';
const file=process.env.FIXTURE_STATE; const s=JSON.parse(fs.readFileSync(file,'utf8'));
const [command,...args]=process.argv.slice(2); s.commands.push([command,...args]);
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=(status)=>{save();process.stderr.write('fixture failure (HTTP '+status+') PRIVATE_RESPONSE_BODY');process.exit(1)};
if(command==='git' && args.join(' ')==='rev-parse HEAD') { save(); console.log(s.release.target_commitish); }
else if(command==='npm' && args[0]==='dist-tag') { const spec=args[2]; const at=spec.lastIndexOf('@'); (s.tags[spec.slice(0,at)]??={})[args[3]]=spec.slice(at+1); save(); }
else if(command==='npm') fail(401);
else if(command==='gh') {
 const endpoint=args.find(a=>a.startsWith('repos/')||a.startsWith('https://uploads.github.com/'));
 if(args[0]==='release') fail(422); // An existing draft must never be recreated.
 if(endpoint?.includes('/releases/tags/')) fail(404); // Published-only lookup cannot see this draft.
 if(endpoint?.endsWith('/releases?per_page=100')) {
   if(s.mode==='gh-error') fail(503);
   // Like GitHub, the list can lag a draft created moments ago. In draft-race
   // a draft already exists but the list only shows it after a create attempt.
   const listed=s.mode==='new-release' || (s.mode==='draft-race' && !s.posted) ? [] : [s.release];
   save(); console.log(JSON.stringify([[{...s.release,id:999,tag_name:s.release.tag_name+'0'},...listed]]));
 } else if(endpoint?.endsWith('/releases') && args.includes('POST')) {
   s.posted=true;
   if(s.mode!=='new-release') fail(422); // GitHub refuses a second release for this tag.
   const need=['tag_name='+s.release.tag_name,'target_commitish='+s.release.target_commitish,'draft=true','prerelease='+s.prerelease,'name='+s.title];
   if(need.some(arg=>!args.includes(arg)) || !args.some(arg=>arg.startsWith('body=') && arg.endsWith('Source: '+s.release.target_commitish+'.'))) fail(400);
   save(); console.log(JSON.stringify(s.release));
 } else if(endpoint?.startsWith('https://uploads.github.com/')) {
   if(!endpoint.includes('/releases/1234/assets?')) fail(404);
   const name=new URL(endpoint).searchParams.get('name'); const bytes=fs.readFileSync(args[args.indexOf('--input')+1]);
   const asset={name,size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')};
   s.release.assets.push(asset); save(); console.log(JSON.stringify(asset));
 } else if(endpoint?.endsWith('/releases/1234')) {
   if(args.includes('PATCH')) { if(!args.includes('draft=false')) fail(400); s.release.draft=false; }
   save(); console.log(JSON.stringify(s.release));
 } else if(endpoint?.endsWith('/contents/index.json')) {
   const body=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
   s.index=Buffer.from(body.content,'base64').toString('utf8'); save(); console.log('{}');
 } else fail(400);
} else fail(400);
`;
const http = `import fs from 'node:fs';
// A flaky registry: every Nth request of a kind fails with a retryable status.
// Counted in this process, where every registry request is made, so the shim's
// state file is never contended, and spread so no single poll is exhausted.
const flakyTags=Number(process.env.FIXTURE_FLAKY_TAGS??0);
const flakyVersions=Number(process.env.FIXTURE_FLAKY_VERSIONS??0);
let tagReads=0, versionReads=0;
globalThis.fetch=async input=>{
 const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8')); const url=new URL(String(input));
 if(url.hostname==='registry.npmjs.org') {
   const parts=url.pathname.slice(1).split('/');
   if(s.mode==='http-error') return new Response('PRIVATE_RESPONSE_BODY',{status:502});
   // Like npm: tags live under /-/package/, and /<name>/dist-tags is a version lookup.
   if(parts[0]==='-' && parts[1]==='package' && parts[3]==='dist-tags') {
     if(flakyTags>0 && ++tagReads%flakyTags===0) return new Response('PRIVATE_RESPONSE_BODY',{status:503});
     return Response.json(s.tags[decodeURIComponent(parts[2])]??{});
   }
   if(parts[1]==='dist-tags') return Response.json('version not found: dist-tags',{status:404});
   const name=decodeURIComponent(parts[0]);
   if(flakyVersions>0 && ++versionReads%flakyVersions===0) return new Response('PRIVATE_RESPONSE_BODY',{status:429});
   if(s.mode==='npm-error') return new Response(null,{status:404});
   if(!s.registry[name]) throw new Error('Unexpected registry package');
   // Bytes that are not this run's: never retried, never republished.
   if(s.mode==='integrity-mismatch')
     return Response.json({...s.registry[name],dist:{integrity:'sha512-someoneElsesBytes'}});
   return Response.json(s.registry[name]);
 }
 if(url.hostname==='api.github.com' && url.pathname.includes('/commits/')) {
   // GitHub's answers: an unresolved ref, or a generic validation failure.
   if(s.mode==='tag-validation') return Response.json({message:'Validation Failed',status:'422'},{status:422});
   return s.release.draft ? Response.json({message:'No commit found for SHA: '+url.pathname.split('/').pop(),status:'422'},{status:422}) : Response.json({sha:s.release.target_commitish});
 }
 if(url.hostname==='api.github.com' && url.pathname.endsWith('/git/ref/heads/fork-release-index')) return Response.json({ref:'refs/heads/fork-release-index'});
 if(url.hostname==='api.github.com' && url.pathname.endsWith('/contents/index.json'))
   return s.index===undefined ? new Response(null,{status:404}) : Response.json({sha:'index-blob',encoding:'base64',content:Buffer.from(s.index).toString('base64')});
 throw new Error('Unexpected HTTP fixture request');
};
`;

const createCount = (commands: string[][]) =>
  commands.filter((args) => args.includes("POST") && args.some((arg) => arg.endsWith("/releases")))
    .length;

function publishFixture(
  mode = "resume",
  ref = "refs/heads/main",
  npm = true,
  channel = "preview",
  /** dist-tags the registry already holds, by package name. */
  tags: Record<string, Record<string, string>> = {},
  /** Every Nth registry answer of a kind fails with a retryable status. */
  flaky: { tags?: number; versions?: number } = {},
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-publisher-"));
  const plan = forkReleasePlan({
    repository: "shuv1337/shuv2code",
    sha: "ab".repeat(20),
    channel,
    version: `1.2.3-${channel}.20261014.1`,
    signing: { mac: false, win: false, unsigned: true },
    npm,
  });
  try {
    const prepared = NodePath.join(root, "prepared");
    NodeFS.mkdirSync(NodePath.join(prepared, "release-assets"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prepared, "release-plan.json"), JSON.stringify(plan));
    NodeFS.writeFileSync(
      NodePath.join(prepared, "release-assets/fixture.bin"),
      "immutable fixture bytes",
    );
    for (const feed of plan.feedAssets)
      NodeFS.writeFileSync(NodePath.join(prepared, "release-assets", feed), `feed ${feed}`);
    const registry: Record<string, unknown> = {};
    const packageDir = NodePath.join(root, "package");
    NodeFS.mkdirSync(packageDir);
    for (const manifest of [
      ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => npmPlatformPackageManifest(key, plan.version, {})),
      npmLauncherPackageManifest(plan.version, CLI_ARCHIVE_PLATFORM_KEYS),
      npmLauncherPackageManifest(plan.version, CLI_ARCHIVE_PLATFORM_KEYS, "shuv2code"),
    ]) {
      const file = NodePath.join(prepared, "npm-packages", manifest.name + ".tgz");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(packageDir, "package.json"), JSON.stringify(manifest));
      NodeChildProcess.execFileSync("tar", ["-czf", file, "-C", root, "package"]);
      registry[manifest.name] = {
        ...manifest,
        dist: {
          integrity:
            "sha512-" +
            NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(file)).digest("base64"),
        },
      };
    }
    const stateFile = NodePath.join(root, "state.json");
    NodeFS.writeFileSync(
      stateFile,
      JSON.stringify({
        mode,
        registry,
        tags,
        commands: [],
        // What a create must send, so a dropped field fails the fixture.
        prerelease: plan.channel !== "stable",
        title: plan.title,
        release: {
          id: 1234,
          tag_name: plan.tag,
          draft: true,
          target_commitish: plan.sha,
          assets: [],
        },
      }),
    );
    NodeFS.writeFileSync(NodePath.join(root, "shim.mjs"), shim);
    NodeFS.writeFileSync(NodePath.join(root, "http.mjs"), http);
    for (const command of ["git", "gh", "npm"])
      NodeFS.writeFileSync(
        NodePath.join(root, command),
        `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(root, "shim.mjs")}" ${command} "$@"\n`,
        { mode: 0o700 },
      );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        NodePath.join(root, "http.mjs"),
        NodePath.resolve(import.meta.dirname, "fork-release.ts"),
        "publish",
        "--execute",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: root + NodePath.delimiter + process.env.PATH,
          FIXTURE_STATE: stateFile,
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: plan.repository,
          GITHUB_WORKFLOW_REF: `${plan.repository}/.github/workflows/release.yml@${ref}`,
          GITHUB_REF: ref,
          GITHUB_DEFAULT_BRANCH: "main",
          RUNNER_ENVIRONMENT: "github-hosted",
          ACTIONS_ID_TOKEN_REQUEST_URL: "fixture",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
          ...(npm
            ? {
                S2CODE_NPM_TRUSTED_PUBLISHING_READY: "true",
                FORK_NPM_TRUSTED_PUBLISHING_READY: "true",
              }
            : {}),
          // Same number of polls as CI, without the fifteen-second waits.
          FORK_RELEASE_NPM_POLL_MS: "1",
          FIXTURE_FLAKY_TAGS: String(flaky.tags ?? 0),
          FIXTURE_FLAKY_VERSIONS: String(flaky.versions ?? 0),
          GH_TOKEN: "fixture",
        },
      },
    );
    return {
      result,
      plan,
      state: JSON.parse(NodeFS.readFileSync(stateFile, "utf8")) as {
        commands: string[][];
        index?: string;
        tags: Record<string, Record<string, string>>;
        release: { draft: boolean; assets: { name: string }[] };
      },
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("fork publication fixtures", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resumes an existing draft invisible to the tags API and uploads/publishes by its exact ID",
    () => {
      const { result, state } = publishFixture();
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(state.release.assets).toEqual([expect.objectContaining({ name: "fixture.bin" })]);
      expect(state.commands.some((args) => args.includes("--slurp"))).toBe(true);
      expect(
        state.commands.some((args) => args.some((arg) => arg.includes("/releases/1234/assets?"))),
      ).toBe(true);
      expect(
        state.commands.some(
          (args) =>
            args.includes("PATCH") && args.includes("repos/shuv1337/shuv2code/releases/1234"),
        ),
      ).toBe(true);
      expect(
        state.commands.some(
          (args) => args.includes("create") || args.some((arg) => arg.includes("/releases/tags/")),
        ),
      ).toBe(false);
    },
  );
  it
    .skipIf(HostProcess.Platform.defaultValue() === "win32")
    .each(["gh-error", "http-error", "npm-error"])(
    "keeps command/HTTP context without response bodies (%s)",
    (mode) => {
      const { result } = publishFixture(mode);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        mode === "gh-error"
          ? /gh .*HTTP 503/
          : mode === "http-error"
            ? /GET https:\/\/registry\.npmjs\.org\/.*HTTP 502/
            : /npm .*publish.*HTTP 401/,
      );
      expect(result.stderr).not.toContain("PRIVATE_RESPONSE_BODY");
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "stops before the draft when the tag lookup fails validation rather than finding no ref",
    () => {
      const { result, state } = publishFixture("tag-validation");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/commits\/.*HTTP 422/);
      expect(state.commands.some(([command]) => command === "npm")).toBe(false);
      expect(
        state.commands.some((args) => args.some((arg) => arg.includes("/releases/1234/assets?"))),
      ).toBe(false);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "creates the draft once and reads it by id while the release list still lags",
    () => {
      const { result, state } = publishFixture("new-release");
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(createCount(state.commands)).toBe(1);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "reuses a draft the list had not shown yet when GitHub refuses a second create",
    () => {
      const { result, state } = publishFixture("draft-race");
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(createCount(state.commands)).toBe(1);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes the GitHub release without touching npm when npm is not ready",
    () => {
      // The registry fixture fails every request in this mode, so success proves npm was skipped.
      const { result, state } = publishFixture("http-error", "refs/heads/main", false);
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(state.commands.some(([command]) => command === "npm")).toBe(false);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes an unsigned nightly publicly, with Linux feeds only and no npm",
    () => {
      // The registry fixture fails every request in this mode, so success proves npm was skipped.
      const { result, state, plan } = publishFixture(
        "http-error",
        "refs/heads/main",
        false,
        "nightly",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(state.commands.some(([command]) => command === "npm")).toBe(false);
      expect(state.release.assets.map((asset) => asset.name).sort()).toEqual(
        ["fixture.bin", ...plan.feedAssets].sort(),
      );
      expect(plan.feedAssets).toEqual(["nightly-linux.yml", "nightly-linux-arm64.yml"]);
      // Without macOS and Windows feeds the release is not a complete index
      // entry, and publication proceeds with the index unchanged.
      expect(JSON.parse(state.index!)).toEqual([]);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "promotes nightly and latest, platform packages before the launcher",
    () => {
      const held = "@s2code/t3-linux-x64";
      const { result, state, plan } = publishFixture("resume", "refs/heads/main", true, "nightly", {
        ...Object.fromEntries(
          CLI_ARCHIVE_PLATFORM_KEYS.map((key) => [`@s2code/t3-${key}`, { latest: "0.0.0" }]),
        ),
        s2code: { latest: "0.0.0" },
        // A newer published version must keep `latest`, without failing the run.
        [held]: { latest: "9.9.9" },
      });
      expect(result.status, result.stderr).toBe(0);
      const promotions = state.commands
        .filter(([command, subcommand]) => command === "npm" && subcommand === "dist-tag")
        .map((args) => [args[3]!.slice(0, args[3]!.lastIndexOf("@")), args[4]!] as const);
      for (const name of CLI_ARCHIVE_PLATFORM_KEYS.map((key) => `@s2code/t3-${key}`))
        expect(promotions.filter(([pkg]) => pkg === name).map(([, tag]) => tag)).toEqual(
          name === held ? ["nightly"] : ["nightly", "latest"],
        );
      expect(promotions.filter(([pkg]) => pkg === "s2code").map(([, tag]) => tag)).toEqual([
        "nightly",
        "latest",
      ]);
      expect(promotions.findIndex(([pkg]) => pkg === "s2code")).toBe(promotions.length - 4);
      expect(promotions.slice(-2).map(([pkg]) => pkg)).toEqual(["shuv2code", "shuv2code"]);
      expect(state.tags["s2code"]).toEqual({ nightly: plan.version, latest: plan.version });
      expect(state.tags["shuv2code"]).toEqual({ nightly: plan.version, latest: plan.version });
      expect(state.tags[held]).toEqual({ nightly: plan.version, latest: "9.9.9" });
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "polls through transient registry failures instead of failing the release",
    () => {
      // Every version already exists in this fixture, so a 429 mistaken for
      // "absent" would republish and the npm shim would fail the run. Failing
      // every other answer spans the backwards guard, the review poll and the
      // promotion verification.
      const { result, state, plan } = publishFixture(
        "resume",
        "refs/heads/main",
        true,
        "nightly",
        { s2code: { latest: "0.0.0" } },
        { versions: 2, tags: 2 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(
        state.commands.some(
          ([command, subcommand]) => command === "npm" && subcommand === "publish",
        ),
      ).toBe(false);
      expect(state.tags["s2code"]).toEqual({ nightly: plan.version, latest: plan.version });
      expect(result.stderr).not.toContain("PRIVATE_RESPONSE_BODY");
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "fails immediately when the published version is not this run's bytes",
    () => {
      const { result, state } = publishFixture("integrity-mismatch");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("immutable package bytes");
      // A retried answer would have ended in the poll's exhaustion message.
      expect(result.stderr).not.toContain("Last registry failure");
      expect(state.commands.some(([command]) => command === "npm")).toBe(false);
      expect(state.release.draft).toBe(true);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a branch dispatch before any publisher commands",
    () => {
      const { result, state } = publishFixture("resume", "refs/heads/feature");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("default branch");
      expect(state.commands).toEqual([]);
    },
  );
  it("formats subprocess diagnostics without stdout/stderr bodies", () => {
    const error = releaseCommandError("gh", ["api", "fixture"], {
      status: 1,
      stderr: Buffer.from("HTTP 409 PRIVATE_RESPONSE_BODY"),
    });
    expect(error.message).toContain('gh "api" "fixture"');
    expect(error.message).toContain("HTTP 409");
    expect(error.message).not.toContain("PRIVATE_RESPONSE_BODY");
    expect(
      releaseCommandError(
        "npm",
        ["publish"],
        { code: 1 },
        "npm error code E401 PRIVATE_RESPONSE_BODY",
      ).message,
    ).toContain("HTTP 401");
  });
  it("allows OIDC publication only from the default branch", () => {
    const { isAllowedForkPublishRef } = NodeModule.createRequire(import.meta.url)(
      "../.github/scripts/check-nightly-release.cjs",
    ) as { isAllowedForkPublishRef: (ref: string, branch: string) => boolean };
    expect(isAllowedForkPublishRef("refs/heads/main", "main")).toBe(true);
    for (const ref of [
      "refs/heads/feature",
      "refs/tags/v1.2.3",
      "refs/tags/v1.2.3-preview.20261014.1",
      "refs/tags/vanything",
      "refs/pull/1/merge",
    ])
      expect(isAllowedForkPublishRef(ref, "main")).toBe(false);
    expect(isAllowedForkPublishRef("refs/heads/trunk", "trunk")).toBe(true);
  });
});
