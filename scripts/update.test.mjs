import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Drives the real updater against throwaway repositories: update.bat (and its
// PowerShell ZIP converter) on Windows, update.sh everywhere else.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const UPDATER_FILES = ["update.sh", "update.bat", "scripts/convert-zip-install.ps1"];

function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=vlo-test", "-c", "user.email=vlo-test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    if (content === null) {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

const BASE_FILES = {
  ".gitattributes": "*.bat text eol=crlf\n",
  ".gitignore": "/projects\n.vlo-update-backups/\n",
  "package.json": "{}\n",
  "keep.txt": "v1\n",
  "settings.json": '{"shipped": true}\n',
  "removed.txt": "only in v1\n",
  "newdir": "a file where v2 has a folder\n",
  "extensions/.gitignore": "/installed/*\n!/installed/.gitkeep\n",
  "extensions/installed/.gitkeep": "",
  // The installer stub records what the updater passed through.
  "install.sh": '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$VLO_TEST_INSTALL_LOG"\n',
  "install.bat":
    '@echo off\r\n(for %%A in (%*) do @echo %%~A) > "%VLO_TEST_INSTALL_LOG%"\r\n',
};

const V2_CHANGES = {
  ".gitignore": "/projects\n.vlo-update-backups/\nruntime/\n",
  "keep.txt": "v2\n",
  "removed.txt": null,
  "newdir": null,
  "newdir/file.txt": "new in v2\n",
};

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "vlo-updater-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFiles(origin, BASE_FILES);
  for (const file of UPDATER_FILES) {
    cpSync(join(REPOSITORY_ROOT, file), join(origin, file));
  }
  for (const script of ["install.sh", "update.sh"]) {
    chmodSync(join(origin, script), 0o755);
  }
  git(origin, "add", "-A");
  git(origin, "update-index", "--chmod=+x", "install.sh", "update.sh");
  git(origin, "commit", "-qm", "v1");

  return {
    root,
    origin,
    installLog: join(root, "installer-args.txt"),
    commitV2() {
      writeFiles(origin, V2_CHANGES);
      // Shift every line of the updaters, as a real update to them would, so
      // a script still reading its old offsets would land mid-line.
      const padding = (marker) =>
        `${marker} padding the updater so its old line offsets move\n`.repeat(40);
      const bat = readFileSync(join(origin, "update.bat"), "utf8");
      writeFileSync(
        join(origin, "update.bat"),
        bat.replace("@echo off\n", `@echo off\n${padding("::")}`),
      );
      const sh = readFileSync(join(origin, "update.sh"), "utf8");
      writeFileSync(
        join(origin, "update.sh"),
        sh.replace("set -euo pipefail\n", `set -euo pipefail\n${padding("#")}`),
      );
      git(origin, "add", "-A");
      git(origin, "commit", "-qm", "v2");
    },
    extractZip(name = "install") {
      // git archive is what GitHub's "Download ZIP" is built from.
      const target = join(root, name);
      mkdirSync(target);
      const archive = join(root, `${name}.tar`);
      git(origin, "archive", "--format=tar", "-o", archive, "HEAD");
      const extracted = spawnSync("tar", ["-xf", archive, "-C", target]);
      assert.equal(extracted.status, 0, String(extracted.stderr));
      return target;
    },
  };
}

function runUpdater(fixture, installation, args = []) {
  const env = {
    ...process.env,
    VLO_UPDATE_REPOSITORY: pathToFileURL(fixture.origin).href,
    VLO_TEST_INSTALL_LOG: fixture.installLog,
  };
  // stdin is not a terminal, exactly like a provisioning script.
  const options = { cwd: installation, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] };
  const result = IS_WINDOWS
    ? spawnSync("cmd.exe", ["/d", "/c", "update.bat", ...args], options)
    : spawnSync("bash", ["update.sh", ...args], options);
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function updateRunners() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("vlo-update-runner-"));
}

function installerArgs(fixture) {
  return readFileSync(fixture.installLog, "utf8").split(/\r?\n/).filter(Boolean);
}

function backupDirectories(installation) {
  const root = join(installation, ".vlo-update-backups");
  return existsSync(root) ? readdirSync(root).filter((name) => !name.startsWith(".")) : [];
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
}

test("fast-forwards a Git checkout that rewrites the updater itself", (t) => {
  const fixture = createFixture(t);
  const checkout = join(fixture.root, "checkout");
  git(fixture.root, "clone", "-q", fixture.origin, checkout);
  fixture.commitV2();
  const runnersBefore = updateRunners();

  const result = runUpdater(fixture, checkout, ["--profiles", "none"]);

  assert.equal(result.status, 0, result.output);
  assert.match(read(checkout, "update.sh"), /padding the updater/);
  assert.deepEqual(updateRunners(), runnersBefore);
  assert.equal(read(checkout, "keep.txt"), "v2\n");
  assert.equal(existsSync(join(checkout, "removed.txt")), false);
  assert.deepEqual(installerArgs(fixture), ["--profiles", "none"]);
});

test("refuses to update a Git checkout with tracked local changes", (t) => {
  const fixture = createFixture(t);
  const checkout = join(fixture.root, "checkout");
  git(fixture.root, "clone", "-q", fixture.origin, checkout);
  fixture.commitV2();
  writeFiles(checkout, { "settings.json": '{"mine": true}\n' });

  const result = runUpdater(fixture, checkout);

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Tracked source files have local changes/);
  assert.equal(read(checkout, "keep.txt"), "v1\n");
  assert.equal(existsSync(fixture.installLog), false);
});

test("converts an unmodified ZIP installation without asking", (t) => {
  const fixture = createFixture(t);
  const installation = fixture.extractZip();

  const result = runUpdater(fixture, installation);

  assert.equal(result.status, 0, result.output);
  assert.equal(git(installation, "status", "--porcelain"), "");
  assert.deepEqual(backupDirectories(installation), []);
  assert.equal(existsSync(fixture.installLog), true);
});

test("changes nothing when it cannot ask before replacing ZIP files", (t) => {
  const fixture = createFixture(t);
  const installation = fixture.extractZip();
  fixture.commitV2();
  writeFiles(installation, { "settings.json": '{"mine": true}\n' });

  const result = runUpdater(fixture, installation);

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /--confirm-zip-conversion/);
  assert.match(result.output, /settings\.json/);
  assert.match(result.output, /removed\.txt/);
  assert.equal(existsSync(join(installation, ".git")), false);
  assert.equal(read(installation, "settings.json"), '{"mine": true}\n');
  assert.equal(read(installation, "keep.txt"), "v1\n");
  assert.equal(read(installation, "newdir"), "a file where v2 has a folder\n");
  assert.deepEqual(backupDirectories(installation), []);
  assert.equal(existsSync(fixture.installLog), false);
});

test("backs up replaced, obstructing and leftover files before converting a ZIP", (t) => {
  const fixture = createFixture(t);
  const installation = fixture.extractZip();
  fixture.commitV2();
  writeFiles(installation, {
    "settings.json": '{"mine": true}\n',
    // Ignored by the ZIP's own rules, and by the new rules only, respectively.
    "projects/demo/project.json": "project data\n",
    "runtime/state.json": "runtime data\n",
  });

  const result = runUpdater(fixture, installation, [
    "--confirm-zip-conversion",
    "--profiles",
    "none",
  ]);

  assert.equal(result.status, 0, result.output);
  assert.equal(git(installation, "status", "--porcelain"), "");
  assert.equal(read(installation, "settings.json"), '{"shipped": true}\n');
  assert.equal(read(installation, "newdir/file.txt"), "new in v2\n");
  assert.equal(existsSync(join(installation, "removed.txt")), false);
  assert.equal(read(installation, "projects/demo/project.json"), "project data\n");
  assert.equal(read(installation, "runtime/state.json"), "runtime data\n");
  assert.deepEqual(installerArgs(fixture), ["--profiles", "none"]);

  const backups = backupDirectories(installation);
  assert.equal(backups.length, 1);
  const backup = join(installation, ".vlo-update-backups", backups[0]);
  assert.equal(read(backup, "settings.json"), '{"mine": true}\n');
  assert.equal(read(backup, "newdir"), "a file where v2 has a folder\n");
  assert.equal(read(backup, "removed.txt"), "only in v1\n");
  assert.equal(existsSync(join(backup, "keep.txt")), true);
  assert.equal(existsSync(join(backup, "projects")), false);
  assert.equal(existsSync(join(backup, "runtime")), false);
  const manifest = read(backup, "MANIFEST.txt");
  for (const path of ["settings.json", "newdir", "removed.txt"]) {
    assert.match(manifest, new RegExp(path.replace(".", "\\.")));
  }
});

test("moves a folder that occupies the path of a new file", (t) => {
  const fixture = createFixture(t);
  const installation = fixture.extractZip();
  writeFiles(fixture.origin, { "slot.txt": "a file in v2\n" });
  git(fixture.origin, "add", "-A");
  git(fixture.origin, "commit", "-qm", "v2");
  writeFiles(installation, { "slot.txt/inside.json": "user data\n" });

  const result = runUpdater(fixture, installation, ["--confirm-zip-conversion"]);

  assert.equal(result.status, 0, result.output);
  assert.equal(read(installation, "slot.txt"), "a file in v2\n");
  const backup = join(installation, ".vlo-update-backups", backupDirectories(installation)[0]);
  assert.equal(read(backup, "slot.txt/inside.json"), "user data\n");
});

test("never swaps a linked folder that holds tracked files for an empty one", (t) => {
  const fixture = createFixture(t);
  const installation = fixture.extractZip();
  const elsewhere = join(fixture.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFiles(elsewhere, { ".gitkeep": "", "my-extension.json": "{}\n" });
  const linked = join(installation, "extensions", "installed");
  rmSync(linked, { recursive: true });
  symlinkSync(elsewhere, linked, IS_WINDOWS ? "junction" : "dir");

  const result = runUpdater(fixture, installation, ["--confirm-zip-conversion"]);

  if (IS_WINDOWS) {
    // Git for Windows reads through a junction as if it were a folder, so the
    // conversion leaves it in place.
    assert.equal(result.status, 0, result.output);
    assert.equal(git(installation, "status", "--porcelain"), "");
  } else {
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /extensions\/installed/);
    assert.equal(existsSync(join(installation, ".git")), false);
    assert.equal(existsSync(fixture.installLog), false);
  }
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
  assert.equal(existsSync(join(linked, "my-extension.json")), true);
});
