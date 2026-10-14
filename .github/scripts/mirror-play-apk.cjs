// Mirrors the newest build on a Google Play track to a rolling GitHub
// prerelease as a universal APK. Play generates and signs that APK from the
// uploaded bundle with the app signing key, so it carries the same signature
// as the Play Store install. Run by .github/workflows/mobile-android-apk.yml.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const {
  mirrorConfiguration,
  assertApkIdentity,
  MobileReleaseConfigurationError,
} = require("../../scripts/lib/mobile-release-identity.ts");

const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

// Service account key -> OAuth access token via a self-signed JWT grant.
async function playAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key);
  const response = await fetch(key.token_uri, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature.toString("base64url")}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: HTTP ${response.status}`);
  }
  return (await response.json()).access_token;
}

async function play(token, method, url) {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Google Play request failed: HTTP ${response.status}`);
  }
  return response;
}

// Highest version code the track serves, with its release name. Play names a
// release after the bundle's versionName unless the uploader sets one. This
// endpoint reads without opening an edit; an edit would invalidate any open
// EAS Submit edit made with the same service account.
async function newestTrackBuild(token, appUrl, trackName) {
  const { releases = [] } = await (
    await play(token, "GET", `${appUrl}/tracks/${trackName}/releases`)
  ).json();
  let newest;
  for (const release of releases) {
    if (release.releaseLifecycleState !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") continue;
    for (const { versionCode } of release.activeArtifacts ?? []) {
      if (!newest || versionCode > newest.versionCode) {
        newest = { versionCode, versionName: release.releaseName || String(versionCode) };
      }
    }
  }
  return newest;
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function readRelease(tag) {
  try {
    return JSON.parse(gh("api", `repos/${requireEnv("GH_REPO")}/releases/tags/${tag}`));
  } catch {
    return undefined;
  }
}

// Downloads the build's universal APK and uploads it, creating the release on
// first use. Returns false when Play lists no universal APK, which happens
// while it is still processing a fresh upload.
async function uploadApk(
  { token, appUrl, build, tag, apkName, notes, release, expected },
  dependencies = { play, gh, execFileSync },
) {
  const generated = await (
    await dependencies.play(token, "GET", `${appUrl}/generatedApks/${build.versionCode}`)
  ).json();
  // One entry per app signing key. More than one means a key rotation, so
  // fail rather than guess which signature testers should get.
  const universal = (generated.generatedApks ?? []).filter((entry) => entry.generatedUniversalApk);
  if (universal.length === 0) return false;
  if (universal.length > 1) {
    throw new Error(`Play returned ${universal.length} universal APKs, one per signing key.`);
  }
  const { downloadId } = universal[0].generatedUniversalApk;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shuv2code-apk-"));
  const apkPath = path.join(directory, apkName);
  try {
    const download = await dependencies.play(
      token,
      "GET",
      `${appUrl}/generatedApks/${build.versionCode}/downloads/${encodeURIComponent(downloadId)}:download?alt=media`,
    );
    await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(apkPath));
    const packageName = dependencies.execFileSync(
      "apkanalyzer",
      ["manifest", "application-id", apkPath],
      { encoding: "utf8" },
    );
    // apksigner must succeed before its reported certificate can be trusted.
    const signature = dependencies.execFileSync("apksigner", ["verify", "--print-certs", apkPath], {
      encoding: "utf8",
    });
    assertApkIdentity(packageName, signature, expected);
    const digest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex")}`;
    if (
      release?.assets?.some(
        (asset) => asset.name === apkName && asset.state === "uploaded" && asset.digest === digest,
      )
    )
      return true;

    if (!release) {
      // Prerelease with a non-v tag: release.yml, the desktop updater, the CLI,
      // and the marketing site's latest-release lookup all ignore it.
      dependencies.gh(
        "release",
        "create",
        tag,
        "--prerelease",
        "--latest=false",
        "--title",
        "shuv2code for Android (nightly)",
        "--notes",
        notes,
      );
    }
    // --clobber replaces an asset a failed upload left behind.
    dependencies.gh("release", "upload", tag, apkPath, "--clobber");
    return true;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const expected = mirrorConfiguration(process.env);
  if (process.argv.includes("--check-config")) {
    console.log("Fork APK mirror configuration validated; no artifact delivery attempted.");
    return;
  }
  const packageName = expected.packageName;
  const trackName = expected.track;
  const tag = requireEnv("RELEASE_TAG");
  const key = JSON.parse(requireEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
  const summary = (line) =>
    process.env.GITHUB_STEP_SUMMARY &&
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);

  const token = await playAccessToken(key);
  const appUrl = `${PLAY_API}/${packageName}`;
  const build = await newestTrackBuild(token, appUrl, trackName);
  if (!build) {
    console.log(`The ${trackName} track has no live release.`);
    summary(":hourglass: The configured fork track has no live release; no APK was delivered.");
    throw new Error("APK mirror delivered nothing: the configured track has no live release.");
  }

  const safeName = build.versionName.replace(/[^0-9A-Za-z.]+/g, "-").replace(/^-|-$/g, "");
  const apkName = `shuv2code-android-${safeName}-${build.versionCode}.apk`;
  const notes = [
    `shuv2code for Android, mirrored from the fork Google Play ${trackName} track. Current build: ${build.versionName} (${build.versionCode}).`,
    "",
    "The package name and Play app-signing certificate were verified against the fork configuration before attachment. Only the newest fork build is kept here.",
  ].join("\n");

  const release = readRelease(tag);
  const assets = release?.assets ?? [];
  // A failed upload can leave an empty asset under the final name.
  if (await uploadApk({ token, appUrl, build, tag, apkName, notes, release, expected })) {
    console.log(`Published ${apkName}.`);
    summary(`:white_check_mark: Published \`${apkName}\` to the \`${tag}\` release.`);
  } else {
    // The next run retries.
    console.log(`Play lists no universal APK for ${build.versionCode}.`);
    summary(
      `:hourglass: Play lists no universal APK for ${build.versionName} (${build.versionCode}).`,
    );
    throw new Error(
      "APK mirror delivered nothing: Play has not exposed a universal APK; retry later.",
    );
  }

  // Reconciled on every run so an interrupted cleanup finishes on the next one.
  for (const stale of assets) {
    if (
      stale.name.startsWith("shuv2code-android-") &&
      stale.name.endsWith(".apk") &&
      stale.name !== apkName
    ) {
      gh("release", "delete-asset", tag, stale.name, "--yes");
    }
  }
  if (release && release.body.replace(/\r\n/g, "\n").trim() !== notes) {
    gh("release", "edit", tag, "--notes", notes);
  }
}

module.exports = { uploadApk };
if (require.main === module)
  main().catch((error) => {
    console.error(
      error instanceof MobileReleaseConfigurationError
        ? error.message
        : "Fork APK mirror failed validation or destination access. No unverified APK will be attached.",
    );
    process.exit(1);
  });
