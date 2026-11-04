// @effect-diagnostics nodeBuiltinImport:off -- Runs the real publisher CLI against isolated command/HTTP fixtures; never reaches real publication tools.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { npmLauncherPackageManifest } from "./build-npm-launcher.ts";
import { desktopAssetGroups, forkReleasePlan, forkReleaseTitle } from "./lib/fork-release.ts";
import { releaseCommandError } from "./fork-release.ts";
import { serializeUpdateManifest } from "./lib/update-manifest.ts";

const shim = `import fs from 'node:fs'; import crypto from 'node:crypto'; import cp from 'node:child_process';
const file=process.env.FIXTURE_STATE; const s=JSON.parse(fs.readFileSync(file,'utf8'));
const [command,...args]=process.argv.slice(2);
// npm runs concurrently, so it appends to its own log instead of rewriting the state.
if(command==='npm') {
 // Like npm, a second publish of a version is refused, even while review hides it.
 const again=args[0]==='publish' && fs.readFileSync(process.env.FIXTURE_NPM_LOG,'utf8').split('\\n').filter(Boolean).some(line=>{const e=JSON.parse(line); return e.args?.[0]==='publish' && e.args[1]===args[1]});
 fs.appendFileSync(process.env.FIXTURE_NPM_LOG,JSON.stringify({args,draft:s.release.draft,assets:s.release.assets.map(a=>a.name)})+'\\n');
 if(again) { process.stderr.write('npm error code E403\\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/shuv2code - You cannot publish over the previously published versions: '+s.release.tag_name.slice(1)+'. PRIVATE_RESPONSE_BODY'); process.exit(1); }
 if(args[0]==='dist-tag' || (args[0]==='publish' && s.mode.startsWith('fresh'))) process.exit(0);
 process.stderr.write('fixture failure (HTTP 401) PRIVATE_RESPONSE_BODY'); process.exit(1);
}
s.commands.push([command,...args]);
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=(status)=>{save();process.stderr.write('fixture failure (HTTP '+status+') PRIVATE_RESPONSE_BODY');process.exit(1)};
// Like gh: --jq runs once per page, and --slurp cannot be combined with it.
const respond=(pages)=>{
 const jq=args.indexOf('--jq');
 if(jq>=0 && args.includes('--slurp')) fail(400);
 save();
 if(jq<0) return void console.log(JSON.stringify(args.includes('--slurp')?pages:pages[0]));
 for(const page of pages) process.stdout.write(cp.execFileSync('jq',['-r',args[jq+1]],{input:JSON.stringify(page),maxBuffer:1<<30}));
};
if(command==='git' && args.join(' ')==='rev-parse HEAD') { save(); console.log(s.release.target_commitish); }
else if(command==='gh') {
 const endpoint=args.find(a=>a.startsWith('repos/')||a.startsWith('https://uploads.github.com/'));
 if(args[0]==='release') fail(422); // An existing draft must never be recreated.
 if(endpoint?.includes('/releases/tags/')) { if(s.release.draft) fail(404); respond([s.release]); process.exit(0); } // Published-only lookup cannot see a draft.
 if(endpoint?.endsWith('/releases?per_page=100')) {
   if(s.mode==='gh-error') fail(503);
   // Like GitHub, the list can lag a draft created moments ago. In draft-race
   // a draft already exists but the list only shows it after a create attempt.
   const listed=s.mode==='new-release' || (s.mode==='draft-race' && !s.posted) ? [] : [s.release];
   const bulk=s.bulkReleases ? JSON.parse(fs.readFileSync(s.bulkReleases,'utf8')) : [];
   const all=[{...s.release,id:999,tag_name:s.release.tag_name+'0'},...bulk,...listed];
   respond(Array.from({length:Math.ceil(all.length/100)},(_,page)=>all.slice(page*100,page*100+100)));
 } else if(endpoint?.endsWith('/releases') && args.includes('POST')) {
   s.posted=true;
   if(s.mode!=='new-release') fail(422); // GitHub refuses a second release for this tag.
   const need=['tag_name='+s.release.tag_name,'target_commitish='+s.release.target_commitish,'draft=true','prerelease='+s.prerelease,'name='+s.title];
   if(need.some(arg=>!args.includes(arg)) || !args.some(arg=>arg.startsWith('body=') && arg.endsWith('Source: '+s.release.target_commitish+'.'))) fail(400);
   respond([s.release]);
 } else if(endpoint?.startsWith('https://uploads.github.com/')) {
   if(!endpoint.includes('/releases/1234/assets?')) fail(404);
   const name=new URL(endpoint).searchParams.get('name'); const bytes=fs.readFileSync(args[args.indexOf('--input')+1]);
   const asset={id:s.release.assets.length+1,name,size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')};
   if(name==='release.json') s.releaseJson=bytes.toString('utf8');
   s.release.assets.push(asset); save(); console.log(JSON.stringify(asset));
 } else if(endpoint?.includes('/releases/assets/')) {
   const asset=s.release.assets.find(a=>endpoint.endsWith('/releases/assets/'+a.id));
   if(!asset || asset.name!=='release.json' || !args.includes('Accept: application/octet-stream')) fail(404);
   save(); console.log(s.releaseJson);
 } else if(endpoint?.endsWith('/releases/1234')) {
   // fresh-unpublished: GitHub accepts the PATCH but the release never turns public.
   if(args.includes('PATCH')) { if(!args.includes('draft=false')) fail(400); if(s.mode!=='fresh-unpublished') s.release.draft=false; }
   respond([s.release]);
 } else if(endpoint?.endsWith('/contents/index.json')) {
   const body=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
   s.index=Buffer.from(body.content,'base64').toString('utf8'); save(); console.log('{}');
 } else fail(400);
} else fail(400);
`;
const http = `import fs from 'node:fs';
// A flaky registry: every Nth request of a kind fails with a retryable status.
// Counted in this process, where every registry request is made, so the shim's
// state file is never contended, and per package so concurrent polls of other
// packages cannot line every read of one package up with a failure.
const flakyTags=Number(process.env.FIXTURE_FLAKY_TAGS??0);
const flakyVersions=Number(process.env.FIXTURE_FLAKY_VERSIONS??0);
const reads={};
const flaky=(key,every)=>every>0 && (reads[key]=(reads[key]??0)+1)%every===0;
const npmLog=()=>fs.readFileSync(process.env.FIXTURE_NPM_LOG,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));
const tagsOf=(s,name)=>{
 const tags={...s.tags[name]};
 for(const {args} of npmLog()) if(args?.[0]==='dist-tag' && args[2].slice(0,args[2].lastIndexOf('@'))===name) tags[args[3]]=args[2].slice(args[2].lastIndexOf('@')+1);
 return tags;
};
// fresh*: nothing is on npm until this run publishes it, and review hides each
// new version for its first two reads. fresh-pending never finishes review in
// this run; fresh-reviewed finished it before this run started.
const reviewed=new Set();
const freshVersion=(s,name)=>{
 if(!npmLog().some(({args})=>args?.[0]==='publish' && args[1]==='prepared/npm-packages/'+name+'.tgz')) return undefined;
 if(s.mode==='fresh-pending') return undefined;
 if(!reviewed.has(name) && s.mode!=='fresh-reviewed') {
   if((reads['review '+name]=(reads['review '+name]??0)+1)<=2) return undefined;
   reviewed.add(name); fs.appendFileSync(process.env.FIXTURE_NPM_LOG,JSON.stringify({visible:name})+'\\n');
 }
 if(s.mode==='fresh-mismatch' && name==='shuv2code') return {...s.registry[name],dist:{integrity:'sha512-someoneElsesBytes'}};
 return s.registry[name];
};
globalThis.fetch=async input=>{
 const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8')); const url=new URL(String(input));
 if(url.hostname==='registry.npmjs.org') {
   const parts=url.pathname.slice(1).split('/');
   if(s.mode==='http-error') return new Response('PRIVATE_RESPONSE_BODY',{status:502});
   // Like npm: tags live under /-/package/, and /<name>/dist-tags is a version lookup.
   if(parts[0]==='-' && parts[1]==='package' && parts[3]==='dist-tags') {
     if(flaky('tags '+parts[2],flakyTags)) return new Response('PRIVATE_RESPONSE_BODY',{status:503});
     return Response.json(tagsOf(s,decodeURIComponent(parts[2])));
   }
   if(parts[1]==='dist-tags') return Response.json('version not found: dist-tags',{status:404});
   const name=decodeURIComponent(parts[0]);
   if(flaky('version '+name,flakyVersions)) return new Response('PRIVATE_RESPONSE_BODY',{status:429});
   if(s.mode==='npm-error') return new Response(null,{status:404});
   if(!s.registry[name]) throw new Error('Unexpected registry package');
   if(s.mode.startsWith('fresh')) {
     // fresh-down: once this run publishes, the registry answers only errors.
     if(s.mode==='fresh-down' && npmLog().some(({args})=>args?.[0]==='publish')) return new Response('PRIVATE_RESPONSE_BODY',{status:503});
     const version=freshVersion(s,name);
     return version ? Response.json(version) : new Response(null,{status:404});
   }
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
  signing = { mac: false, win: false, unsigned: true },
  /** Other releases GitHub lists ahead of this one. */
  bulkReleases: ReadonlyArray<unknown> = [],
  runner: Record<string, string> = { RUNNER_ENVIRONMENT: "github-hosted" },
  /** A second run against the same release and registry, such as a re-run or a promotion. */
  followUp?: { mode: string; args: string[]; env?: Record<string, string> },
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-publisher-"));
  const plan = forkReleasePlan({
    repository: "shuv1337/s2code",
    sha: "ab".repeat(20),
    channel,
    version: `1.2.3-${channel}.20261014.1`,
    signing,
    npm,
    windows: true,
  });
  try {
    const prepared = NodePath.join(root, "prepared");
    const assetDir = NodePath.join(prepared, "release-assets");
    NodeFS.mkdirSync(assetDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "release-plan.json"), JSON.stringify(plan));
    // What the build jobs upload, before publish shapes it.
    const windows = runner.WINDOWS_BUILT !== "false";
    // What build-npm-launcher pins, with --allow-missing when Windows did not build.
    const npmKeys = CLI_ARCHIVE_PLATFORM_KEYS.filter((key) => windows || !key.startsWith("win32-"));
    const desktops = desktopAssetGroups(plan.version, windows).map((group) => group[0]!);
    for (const name of [...desktops, ...forkReleasePlan({ ...plan, windows }).cliAssets])
      NodeFS.writeFileSync(NodePath.join(assetDir, name), `immutable fixture bytes ${name}`);
    const feed = (name: string, test: (file: string) => boolean) =>
      NodeFS.writeFileSync(
        NodePath.join(assetDir, name),
        serializeUpdateManifest(
          {
            version: plan.version,
            releaseDate: "2026-10-14T12:00:00Z",
            extras: {},
            files: desktops.filter(test).map((url) => {
              const bytes = NodeFS.readFileSync(NodePath.join(assetDir, url));
              const sha512 = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
              return { url, size: bytes.length, sha512 };
            }),
          },
          { platformLabel: "fixture" },
        ),
      );
    if (channel !== "preview") {
      const prefix = channel === "stable" ? "latest" : "nightly";
      feed(`${prefix}-mac.yml`, (file) => file.endsWith(".zip"));
      if (windows) feed(`${prefix}-win-x64.yml`, (file) => file.endsWith(".exe"));
      feed(`${prefix}-linux.yml`, (file) => file.endsWith(".AppImage") && !file.includes("arm64"));
      feed(
        `${prefix}-linux-arm64.yml`,
        (file) => file.endsWith(".AppImage") && file.includes("arm64"),
      );
    }
    const registry: Record<string, unknown> = {};
    const packageDir = NodePath.join(root, "package");
    NodeFS.mkdirSync(packageDir);
    {
      const manifest = npmLauncherPackageManifest(plan.version, 79);
      const file = NodePath.join(prepared, "npm-packages", manifest.name + ".tgz");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(packageDir, "package.json"), JSON.stringify(manifest));
      const checksums = Object.fromEntries(
        npmKeys.map((key) => {
          const archive = cliArchiveFileName(plan.version, key);
          const bytes = NodeFS.readFileSync(NodePath.join(assetDir, archive));
          return [
            key,
            { archive, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") },
          ];
        }),
      );
      NodeFS.writeFileSync(NodePath.join(packageDir, "checksums.json"), JSON.stringify(checksums));
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
    const npmLogFile = NodePath.join(root, "npm.log");
    NodeFS.writeFileSync(npmLogFile, "");
    const bulkFile = NodePath.join(root, "bulk-releases.json");
    NodeFS.writeFileSync(bulkFile, JSON.stringify(bulkReleases));
    NodeFS.writeFileSync(
      stateFile,
      JSON.stringify({
        mode,
        registry,
        tags,
        bulkReleases: bulkFile,
        commands: [],
        // What a create must send, so a dropped field fails the fixture.
        prerelease: plan.channel !== "stable",
        title: forkReleaseTitle(plan),
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
    // A re-run downloads the build artifacts again, before publish shaped them.
    const unshaped = NodePath.join(root, "unshaped");
    NodeFS.cpSync(prepared, unshaped, { recursive: true });
    const output = NodePath.join(root, "github-output");
    const summary = NodePath.join(root, "step-summary");
    const runPublisher = (args: string[], env: Record<string, string> = {}) => {
      NodeFS.writeFileSync(output, "");
      NodeFS.writeFileSync(summary, "");
      return NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          NodePath.join(root, "http.mjs"),
          NodePath.resolve(import.meta.dirname, "fork-release.ts"),
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: root + NodePath.delimiter + process.env.PATH,
            FIXTURE_STATE: stateFile,
            FIXTURE_NPM_LOG: npmLogFile,
            GITHUB_ACTIONS: "true",
            GITHUB_REPOSITORY: plan.repository,
            GITHUB_WORKFLOW_REF: `${plan.repository}/.github/workflows/release.yml@${ref}`,
            GITHUB_REF: ref,
            GITHUB_DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            WINDOWS_BUILT: "true",
            PROMOTE_VERSION: plan.version,
            ...runner,
            ACTIONS_ID_TOKEN_REQUEST_URL: "fixture",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
            ...(npm ? { FORK_NPM_TRUSTED_PUBLISHING_READY: "true" } : {}),
            // Same number of polls as CI, without the fifteen-second waits.
            FORK_RELEASE_NPM_POLL_MS: "1",
            FIXTURE_FLAKY_TAGS: String(flaky.tags ?? 0),
            FIXTURE_FLAKY_VERSIONS: String(flaky.versions ?? 0),
            GH_TOKEN: "fixture",
            ...env,
          },
        },
      );
    };
    let result = runPublisher(["publish", "--execute"]);
    let firstRun: typeof result | undefined;
    // The follow-up reports only its own commands, against the state the first run left.
    let npmLogStart = 0;
    if (followUp) {
      firstRun = result;
      const first = JSON.parse(NodeFS.readFileSync(stateFile, "utf8")) as { commands: unknown[] };
      NodeFS.writeFileSync(
        stateFile,
        JSON.stringify({ ...first, mode: followUp.mode, commands: [] }),
      );
      npmLogStart = NodeFS.readFileSync(npmLogFile, "utf8").split("\n").filter(Boolean).length;
      NodeFS.rmSync(prepared, { recursive: true });
      NodeFS.cpSync(unshaped, prepared, { recursive: true });
      result = runPublisher(followUp.args, followUp.env);
    }
    const state = JSON.parse(NodeFS.readFileSync(stateFile, "utf8")) as {
      commands: string[][];
      index?: string;
      releaseJson?: string;
      tags: Record<string, Record<string, string>>;
      release: { draft: boolean; assets: { name: string }[] };
    };
    /** npm invocations, with the release's draft state when each ran, and npm review completions, in order. */
    const fullNpmLog = NodeFS.readFileSync(npmLogFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as
            | { args: string[]; draft: boolean; assets: string[] }
            | { visible: string },
      );
    const npmLog = fullNpmLog.slice(npmLogStart);
    for (const [index, entry] of fullNpmLog.entries()) {
      if (!("args" in entry)) continue;
      if (index >= npmLogStart) state.commands.push(["npm", ...entry.args]);
      const [subcommand, , spec, tag] = entry.args;
      if (subcommand === "dist-tag")
        (state.tags[spec!.slice(0, spec!.lastIndexOf("@"))] ??= {})[tag!] = spec!.slice(
          spec!.lastIndexOf("@") + 1,
        );
    }
    return {
      result,
      firstRun,
      plan,
      state,
      npmLog,
      output: NodeFS.readFileSync(output, "utf8"),
      summary: NodeFS.readFileSync(summary, "utf8"),
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("fork publication fixtures", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32").each([
    { mac: true, win: false },
    { mac: true, win: true },
    { mac: false, win: true },
    { mac: false, win: false },
  ])("creates platform-specific release notes for macOS=$mac and Windows=$win", ({ mac, win }) => {
    const { result, state, plan } = publishFixture(
      "new-release",
      "refs/heads/main",
      false,
      "preview",
      {},
      {},
      { mac, win, unsigned: !mac || !win },
    );
    expect(result.status, result.stderr).toBe(0);
    const create = state.commands.find((args) => args.includes("POST"))!;
    expect(create).toContain(`name=S2Code preview v${plan.version}`);
    const body = create.find((arg) => arg.startsWith("body="))!;
    expect(body).not.toContain("UNSIGNED build:");
    expect(body.includes("are signed and notarized")).toBe(mac);
    expect(body.includes("WARNING: The macOS desktop apps are unsigned")).toBe(!mac);
    expect(body.includes("### Windows\n\nThe Windows installers are unsigned.")).toBe(!win);
    expect(body.includes("### Windows\n\nThe Windows installers are signed.")).toBe(win);
    expect(state.release.draft).toBe(false);
  });
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resumes an existing draft invisible to the tags API and uploads/publishes by its exact ID",
    () => {
      const { result, state, plan } = publishFixture();
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(state.release.assets.map((asset) => asset.name).sort()).toEqual(
        [
          ...desktopAssetGroups(plan.version).map((group) => group[0]!),
          ...plan.cliAssets,
          ...plan.cliLegacyAssets,
          ...plan.cliPreviousAssets,
          "SHA256SUMS",
          "release.json",
        ].sort(),
      );
      expect(state.commands.some((args) => args.includes("--jq"))).toBe(true);
      expect(
        state.commands.some((args) => args.some((arg) => arg.includes("/releases/1234/assets?"))),
      ).toBe(true);
      expect(
        state.commands.some(
          (args) => args.includes("PATCH") && args.includes("repos/shuv1337/s2code/releases/1234"),
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
      const { result, state } = publishFixture(mode);
      expect(result.status).not.toBe(0);
      expect(
        state.commands.filter(
          ([command, subcommand]) => command === "npm" && subcommand === "dist-tag",
        ),
      ).toEqual([]);
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
    "keeps npm publication hosted-only, even for the shuvbot runner on main",
    () => {
      const { result, state } = publishFixture(
        "resume",
        "refs/heads/main",
        true,
        "preview",
        {},
        {},
        { mac: false, win: false, unsigned: true },
        [],
        {
          RUNNER_ENVIRONMENT: "self-hosted",
          RUNNER_NAME: "shuvbot-macos",
          GITHUB_EVENT_NAME: "workflow_dispatch",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("GitHub-hosted OIDC with id-token: write is required.");
      expect(state.commands.some((args) => args[0] === "npm")).toBe(false);
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
        [
          ...desktopAssetGroups(plan.version).map((group) => group[0]!),
          ...plan.cliAssets,
          ...plan.cliLegacyAssets,
          ...plan.cliPreviousAssets,
          "SHA256SUMS",
          "release.json",
          ...plan.feedAssets,
        ].sort(),
      );
      expect(plan.feedAssets).toEqual(["nightly-linux.yml", "nightly-linux-arm64.yml"]);
      // Without macOS and Windows feeds the release is not a complete index
      // entry, and publication proceeds with the index unchanged.
      expect(JSON.parse(state.index!)).toEqual([]);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes npm without the Windows package when the Windows build failed, and says so",
    () => {
      const { result, state } = publishFixture(
        "new-release",
        "refs/heads/main",
        true,
        "nightly",
        {},
        {},
        { mac: true, win: true, unsigned: false },
        [],
        { RUNNER_ENVIRONMENT: "github-hosted", WINDOWS_BUILT: "false" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      // Every other package still moves to this version, launchers included.
      const promoted = new Set(
        state.commands
          .filter(([command, subcommand]) => command === "npm" && subcommand === "dist-tag")
          .map((args) => args[3]!.slice(0, args[3]!.lastIndexOf("@"))),
      );
      expect([...promoted]).toEqual(["shuv2code"]);
      const names = state.release.assets.map((asset) => asset.name);
      expect(names).toContain("nightly-mac.yml");
      expect(
        names.filter(
          (name) => name.includes("win32") || name.includes(".exe") || name === "nightly.yml",
        ),
      ).toEqual([]);
      const body = state.commands
        .find((args) => args.includes("POST"))!
        .find((arg) => arg.startsWith("body="))!;
      expect(body).toContain("### Windows\n\nThe Windows x64 build failed");
      expect(body).toContain("`npx shuv2code` is unavailable on Windows for this version.");
      // A release without Windows is not a complete index entry.
      expect(JSON.parse(state.index!)).toEqual([]);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "finds the draft and builds the index from a release history far past the exec buffer",
    () => {
      // Full GitHub release objects carry an uploader record on every asset.
      const uploader = { login: "fixture", node_id: "x".repeat(400) };
      const history = Array.from({ length: 1000 }, (_, index) => {
        const value = forkReleasePlan({
          repository: "shuv1337/s2code",
          sha: "cd".repeat(20),
          channel: "nightly",
          version: `1.2.2-nightly.20261013.${index + 1}`,
          signing: { mac: true, win: true, unsigned: false },
          npm: false,
          windows: true,
        });
        return {
          id: 10_000 + index,
          tag_name: value.tag,
          draft: false,
          target_commitish: value.sha,
          assets: [
            ...value.cliAssets,
            ...value.cliLegacyAssets,
            ...value.cliPreviousAssets,
            ...desktopAssetGroups(value.version).map((group) => group[0]!),
            ...value.feedAssets,
            "SHA256SUMS",
            "release.json",
          ].map((name) => ({ name, size: 1, digest: "sha256:fixture", uploader })),
        };
      });
      const { result, state } = publishFixture(
        "resume",
        "refs/heads/main",
        false,
        "nightly",
        {},
        {},
        undefined,
        history,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(state.commands.some((args) => args.includes("--slurp"))).toBe(false);
      // Drafts are invisible to the tags API, so the draft is still found by scanning the list.
      expect(
        state.commands.some((args) => args.some((arg) => arg.includes("/releases/tags/"))),
      ).toBe(false);
      expect(JSON.parse(state.index!)).toEqual(
        history.map((release) => ({ tag_name: release.tag_name, draft: false })),
      );
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "promotes nightly, and latest unless a newer version holds it",
    () => {
      const { result, state, plan } = publishFixture("resume", "refs/heads/main", true, "nightly", {
        // A newer published version must keep `latest`, without failing the run.
        shuv2code: { latest: "9.9.9" },
      });
      expect(result.status, result.stderr).toBe(0);
      const promotions = state.commands
        .filter(([command, subcommand]) => command === "npm" && subcommand === "dist-tag")
        .map((args) => args[4]);
      expect(promotions).toEqual(["nightly"]);
      expect(state.tags["shuv2code"]).toEqual({ nightly: plan.version, latest: "9.9.9" });
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "makes the release public with every pinned archive and feed before npm, then promotes",
    () => {
      const { result, state, plan, npmLog, output, summary } = publishFixture(
        "fresh",
        "refs/heads/main",
        true,
        "nightly",
        {},
        {},
        { mac: true, win: true, unsigned: false },
      );
      expect(result.status, result.stderr).toBe(0);
      const at = (match: (entry: (typeof npmLog)[number]) => boolean) =>
        npmLog.flatMap((entry, index) => (match(entry) ? [index] : []));
      const command = (subcommand: string) =>
        at((entry) => "args" in entry && entry.args[0] === subcommand);
      const publishes = npmLog.flatMap((entry) =>
        "args" in entry && entry.args[0] === "publish" ? [entry] : [],
      );
      expect(publishes.map((entry) => entry.args)).toEqual([
        expect.arrayContaining([
          "prepared/npm-packages/shuv2code.tgz",
          "--provenance",
          "--tag",
          plan.stagingTag,
        ]),
      ]);
      // The launcher downloads from the release, so it is public, with every
      // archive the launcher pins and every feed, before npm sees anything.
      expect(publishes[0]!.draft).toBe(false);
      expect(publishes[0]!.assets).toEqual(
        expect.arrayContaining([...plan.cliAssets, ...plan.feedAssets]),
      );
      expect(state.index).toBeDefined();
      const reviews = at((entry) => "visible" in entry);
      expect(reviews).toHaveLength(1);
      expect(Math.max(...command("publish"))).toBeLessThan(Math.min(...reviews));
      expect(Math.max(...reviews)).toBeLessThan(Math.min(...command("dist-tag")));
      expect(command("dist-tag")).toHaveLength(2);
      expect(state.release.draft).toBe(false);
      expect(state.tags["shuv2code"]).toEqual({ nightly: plan.version, latest: plan.version });
      expect(output).toBe("npm=promoted\n");
      expect(summary).toContain(`shuv2code@${plan.version} is on nightly, latest.`);
      // What promote-only later checks npm against.
      expect((JSON.parse(state.releaseJson!) as { npmPackages: unknown }).npmPackages).toEqual([
        { name: "shuv2code", integrity: expect.stringMatching(/^sha512-/) },
      ]);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "succeeds with the dist-tags left alone while npm still reviews the version",
    () => {
      const previous = { nightly: "1.2.2-nightly.20261013.1", latest: "1.2.2-nightly.20261013.1" };
      const { result, state, plan, npmLog, output, summary } = publishFixture(
        "fresh-pending",
        "refs/heads/main",
        true,
        "nightly",
        { shuv2code: previous },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(npmLog.filter((entry) => "args" in entry && entry.args[0] === "publish")).toHaveLength(
        1,
      );
      expect(npmLog.filter((entry) => "args" in entry && entry.args[0] === "dist-tag")).toEqual([]);
      expect(state.tags["shuv2code"]).toEqual(previous);
      expect(result.stdout).toMatch(/^::warning::npm pending review: /m);
      expect(output).toBe("npm=pending\n");
      expect(summary).toContain("npm pending review");
      expect(summary).toContain(
        `gh workflow run release.yml --ref main -f promote_version=${plan.version}`,
      );
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32").each([
    { name: "a publish re-run", args: ["publish", "--execute"] },
    { name: "a promote-only run", args: ["promote", "--execute"] },
  ])("changes nothing but the dist-tags in $name once npm shows the version", ({ args }) => {
    const { result, firstRun, state, plan, npmLog, output } = publishFixture(
      "fresh-pending",
      "refs/heads/main",
      true,
      "nightly",
      {},
      {},
      { mac: true, win: true, unsigned: false },
      [],
      undefined,
      { mode: "fresh-reviewed", args },
    );
    expect(firstRun!.status, firstRun!.stderr).toBe(0);
    expect(result.status, result.stderr).toBe(0);
    // No release create, upload or edit, and no second npm publish.
    expect(
      state.commands.filter((command) =>
        command.some(
          (arg) => arg === "POST" || arg === "PATCH" || arg.startsWith("https://uploads."),
        ),
      ),
    ).toEqual([]);
    expect(npmLog.flatMap((entry) => ("args" in entry ? [entry.args.slice(0, 2)] : []))).toEqual([
      ["dist-tag", "add"],
      ["dist-tag", "add"],
    ]);
    expect(state.tags["shuv2code"]).toEqual({ nightly: plan.version, latest: plan.version });
    expect(output).toBe("npm=promoted\n");
  });
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "promotes nothing onto a release that is not public",
    () => {
      const { result, state } = publishFixture(
        "fresh-unpublished",
        "refs/heads/main",
        true,
        "nightly",
        {},
        {},
        undefined,
        [],
        undefined,
        { mode: "fresh-reviewed", args: ["promote", "--execute"] },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/releases\/tags\/.*HTTP 404/);
      expect(state.commands.some(([command]) => command === "npm")).toBe(false);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32").each([
    { mode: "fresh", status: "promoted", tags: 2 },
    { mode: "fresh-pending", status: "pending", tags: 0 },
  ])(
    "re-runs publish while npm still reviews: the refused publish counts as published ($status)",
    ({ mode, status, tags }) => {
      const { result, firstRun, state, npmLog, output } = publishFixture(
        "fresh-pending",
        "refs/heads/main",
        true,
        "nightly",
        {},
        {},
        { mac: true, win: true, unsigned: false },
        [],
        undefined,
        { mode, args: ["publish", "--execute"] },
      );
      expect(firstRun!.status, firstRun!.stderr).toBe(0);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("npm already has shuv2code@");
      expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE_RESPONSE_BODY");
      const commands = npmLog.flatMap((entry) => ("args" in entry ? [entry.args[0]] : []));
      expect(commands).toEqual(["publish", ...Array<string>(tags).fill("dist-tag")]);
      expect(output).toBe(`npm=${status}\n`);
      expect(state.release.draft).toBe(false);
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "reports a failed npm check, not a review, when the registry answers only errors",
    () => {
      const { result, state, npmLog, output, summary } = publishFixture(
        "fresh-down",
        "refs/heads/main",
        true,
        "nightly",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(npmLog.filter((entry) => "args" in entry && entry.args[0] === "dist-tag")).toEqual([]);
      const warning = result.stdout.split("\n").find((line) => line.startsWith("::warning::"))!;
      expect(warning).toMatch(/^::warning::npm check failed: .*Last error: GET .*HTTP 503/);
      expect(warning).not.toContain("pending review");
      expect(output).toMatch(
        /^npm=failed\nnpm_error=GET https:\/\/registry\.npmjs\.org\/.*HTTP 503\)\.\n$/,
      );
      expect(summary).toContain("npm check failed");
      expect(summary).toContain("HTTP 503");
      expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE_RESPONSE_BODY");
    },
  );
  it.skipIf(HostProcess.Platform.defaultValue() === "win32").each([
    {
      name: "a release that published no npm package",
      npm: false,
      mode: "fresh-reviewed",
      error: "recorded no shuv2code launcher bytes",
    },
    {
      name: "npm bytes the release did not record",
      npm: true,
      mode: "fresh-mismatch",
      error: "immutable package bytes",
    },
  ])("promote-only refuses $name", ({ npm, mode, error }) => {
    const { result, firstRun, npmLog } = publishFixture(
      "fresh-pending",
      "refs/heads/main",
      npm,
      "nightly",
      {},
      {},
      { mac: true, win: true, unsigned: false },
      [],
      undefined,
      {
        mode,
        args: ["promote", "--execute"],
        env: { FORK_NPM_TRUSTED_PUBLISHING_READY: "true" },
      },
    );
    expect(firstRun!.status, firstRun!.stderr).toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(npmLog.filter((entry) => "args" in entry)).toEqual([]);
  });
  it.skipIf(HostProcess.Platform.defaultValue() === "win32").each([
    { mode: "fresh-mismatch", error: "immutable package bytes", published: 1, draft: false },
    { mode: "fresh-unpublished", error: "HTTP 422", published: 0, draft: true },
  ])(
    "moves no dist-tag unless the release is public and npm shows this run's bytes ($mode)",
    ({ mode, error, published, draft }) => {
      const { result, state, npmLog } = publishFixture(mode, "refs/heads/main", true, "nightly");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
      expect(npmLog.filter((entry) => "args" in entry && entry.args[0] === "publish")).toHaveLength(
        published,
      );
      expect(npmLog.filter((entry) => "visible" in entry)).toHaveLength(published);
      expect(npmLog.filter((entry) => "args" in entry && entry.args[0] === "dist-tag")).toEqual([]);
      expect(state.release.draft).toBe(draft);
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
        { shuv2code: { latest: "0.0.0" } },
        { versions: 2, tags: 2 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(state.release.draft).toBe(false);
      expect(
        state.commands.some(
          ([command, subcommand]) => command === "npm" && subcommand === "publish",
        ),
      ).toBe(false);
      expect(state.tags["shuv2code"]).toEqual({ nightly: plan.version, latest: plan.version });
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
      // npm comes after the release, so the release is already public.
      expect(state.release.draft).toBe(false);
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
