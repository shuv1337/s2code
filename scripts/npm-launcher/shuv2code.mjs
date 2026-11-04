#!/usr/bin/env node
// Downloads this package version's CLI archive from the GitHub Release, checks it against the
// sha256 manifest published inside this package, caches it, and runs it.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fetch is the newest API used here; older Node would fail with a confusing ReferenceError.
if (Number(process.versions.node.split(".")[0]) < 18) {
  process.stderr.write(`shuv2code: needs Node.js 18 or newer; this is ${process.version}.\n`);
  process.exit(1);
}

const launcherPath = fileURLToPath(import.meta.url);
const packageDir = path.join(path.dirname(launcherPath), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
// { [platform-arch]: { archive, sha256 } }, written at build time from the release's archives.
const checksums = JSON.parse(fs.readFileSync(path.join(packageDir, "checksums.json"), "utf8"));
const RELEASES = "https://github.com/shuv1337/s2code/releases";
const EXECUTABLE = process.platform === "win32" ? "t3.exe" : "t3";
const MARKER = ".install-complete";
const DOWNLOAD_TIMEOUT_MS = (Number(process.env.S2CODE_DOWNLOAD_TIMEOUT_SECONDS) || 1800) * 1000;
const DOWNLOAD_IDLE_MS = Math.min(60_000, DOWNLOAD_TIMEOUT_MS / 2);

function cacheRoot() {
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  // The XDG spec says to ignore a relative XDG_CACHE_HOME.
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1 << 20);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function download(url, file) {
  const controller = new AbortController();
  let stopped;
  const stop = (reason) => {
    stopped = reason;
    controller.abort();
  };
  const deadline = setTimeout(
    () => stop(`took longer than ${DOWNLOAD_TIMEOUT_MS / 1000}s`),
    DOWNLOAD_TIMEOUT_MS,
  );
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => stop(`stalled with no data for ${DOWNLOAD_IDLE_MS / 1000}s`),
      DOWNLOAD_IDLE_MS,
    );
  };
  const hash = crypto.createHash("sha256");
  const tty = process.stderr.isTTY;
  let out;
  try {
    touch();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) {
      throw new Error(
        `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
      );
    }
    if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || 0;
    out = fs.openSync(file, "w");
    let received = 0;
    let shown = -1;
    for await (const chunk of response.body) {
      touch();
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Kshuv2code: downloading S2Code ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
    if (total && received !== total)
      throw new Error(`download of ${url} ended after ${received} of ${total} bytes`);
  } catch (error) {
    if (stopped) throw new Error(`download of ${url} ${stopped}`, { cause: error });
    if (error.name === "TypeError")
      throw new Error(`GET ${url} failed: ${error.cause?.message ?? error.message}`, {
        cause: error,
      });
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    if (out !== undefined) fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

/** Windows' own bsdtar reads zip; a Git-for-Windows tar on PATH cannot. */
function tarCommand() {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return `${root}\\System32\\tar.exe`;
}

async function install(dir, key) {
  const { archive, sha256: expected } = checksums[key];
  const base = (process.env.S2CODE_RELEASE_BASE_URL || `${RELEASES}/download`).replace(/\/+$/, "");

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    const actual = await download(`${base}/v${version}/${archive}`, file);
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${archive}: expected sha256 ${expected}, downloaded ${actual}. Nothing was installed.`,
      );
    }
    const extract = spawnSync(tarCommand(), ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    const validate = spawnSync(path.join(staging, EXECUTABLE), ["--version"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (validate.status !== 0) {
      throw executableError(
        key,
        validate.error?.message ||
          validate.stderr?.trim() ||
          `--version exited with ${validate.signal || validate.status}`,
      );
    }
    // The executable's own hash, so every later run can re-verify what it is about to start.
    fs.writeFileSync(
      path.join(staging, MARKER),
      `${version}\n${sha256File(path.join(staging, EXECUTABLE))}\n`,
    );
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Complete means this version's marker is present and the executable still has the hash it recorded. */
const isComplete = (dir) => {
  try {
    const [markerVersion, markerHash] = fs.readFileSync(path.join(dir, MARKER), "utf8").split("\n");
    return markerVersion === version && markerHash === sha256File(path.join(dir, EXECUTABLE));
  } catch {
    return false;
  }
};

/** Preserve concurrently published complete installs; replace only incomplete folders without the completion marker. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another shuv2code is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    // A peer may have published between our marker check and taking the lock.
    if (isComplete(dir)) return;
    // Move it aside rather than deleting in place: once the folder is empty, a
    // peer's first rename can land in it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!isComplete(dir)) throw error;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

/**
 * Keeps this version and the most recently installed other version, so going back one release
 * needs no download. In-flight `.staging-`, `.lock` and `.stale` folders belong to running peers.
 */
function prune(versionsDir) {
  const installedAt = (name) => {
    try {
      return fs.statSync(path.join(versionsDir, name, MARKER)).mtimeMs;
    } catch {
      return -1;
    }
  };
  const others = fs
    .readdirSync(versionsDir)
    .filter((name) => name !== version && !/\.(?:staging-|lock$)/.test(name));
  const previous = others
    .filter((name) => installedAt(name) >= 0)
    .sort((a, b) => installedAt(b) - installedAt(a))[0];
  for (const name of others) {
    if (name === previous) continue;
    try {
      fs.rmSync(path.join(versionsDir, name), { recursive: true, force: true });
    } catch {
      // Windows refuses to delete an executable that is still running; try again next install.
    }
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(checksums, key)) {
    throw new Error(
      `${key} is not supported. The CLI is built for ${Object.keys(checksums).join(", ")}.\n` +
        `The desktop app and release archives are at ${RELEASES}`,
    );
  }
  const versionsDir = path.join(cacheRoot(), "s2code", "runtime");
  const dir = path.join(versionsDir, version);
  if (!isComplete(dir)) {
    if (fs.existsSync(path.join(dir, MARKER)))
      process.stderr.write(
        `shuv2code: the cached S2Code ${version} no longer matches its recorded sha256; downloading it again.\n`,
      );
    await install(dir, key);
    prune(versionsDir);
  }

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const child = spawn(path.join(dir, EXECUTABLE), process.argv.slice(2), {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    // The executable lives in the cache, so this is how it knows npm launched it.
    env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: launcherPath },
  });
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(executableError(key, error.message)));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function executableError(key, detail) {
  return new Error(
    `could not run S2Code ${version} for ${key}: ${detail}` +
      (process.platform === "linux"
        ? "\nThe Linux release requires glibc; musl-based systems such as Alpine are not supported. Use a glibc-based Linux environment."
        : ""),
  );
}

function fail(error) {
  process.stderr.write(`shuv2code: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
