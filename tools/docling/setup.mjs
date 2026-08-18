#!/usr/bin/env node
/**
 * Sets up the Docling conversion sidecar used by myWiki's ingestion pipeline.
 * Creates a private venv next to this script and installs docling into it
 * (~1-2 GB including PyTorch; the first conversion additionally downloads
 * layout models from Hugging Face, ~500 MB).
 *
 * Usage: pnpm setup:docling [python-binary]
 *
 * Written in Node rather than shell on purpose. This replaced a setup.sh that
 * could not run on Windows — not merely because of bash, but because a venv
 * puts its executables in Scripts\ there and bin/ everywhere else, so the
 * hardcoded ./.venv/bin/pip failed even under Git Bash. Node is already a hard
 * requirement of the repo, which makes it the one interpreter guaranteed to be
 * present on every machine that can run myWiki at all.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const venvDir = path.join(here, ".venv");
const isWindows = process.platform === "win32";

/** The one layout difference between platforms, kept in a single place. */
function venvPython() {
  return isWindows
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Docling depends on PyTorch, whose wheels have historically lagged the newest
 * CPython — the reason this script prefers a specific interpreter at all.
 * The upper bound is what has actually been observed to work (docling 2.119
 * with torch 2.13 on 3.14), not a guess; raise it when a newer one is tried,
 * rather than pre-emptively.
 */
const TESTED = { min: 10, max: 14 };

/**
 * Every way an interpreter might be reachable, most specific first.
 *
 * On Windows the `py` launcher is the usual way to ask for a version, but it
 * only knows about *registered* installs — a portable or user-local Python
 * (the only kind available without admin rights) is invisible to it while
 * being perfectly usable on PATH. So the bare names are probed too, and a
 * bare `python` may in turn be the Microsoft Store stub, which is why nothing
 * here is trusted without a version probe.
 */
function candidates() {
  const bare = [
    ["python3.13", []],
    ["python3.12", []],
    ["python3.14", []],
    ["python3.11", []],
    ["python3.10", []],
    ["python3", []],
    ["python", []],
  ];
  return isWindows
    ? [["py", ["-3.13"]], ["py", ["-3.12"]], ...bare, ["py", ["-3"]]]
    : bare;
}

/**
 * Version and pointer size of an interpreter, or null if it isn't one.
 *
 * Asks Python itself rather than parsing `--version`, because the bitness
 * matters as much as the version here and only the interpreter can report it.
 * Running code also weeds out Windows' App Execution Alias stub, which
 * answers `--version` with prose about the Microsoft Store.
 */
function probe(cmd, args) {
  const res = spawnSync(
    cmd,
    [
      ...args,
      "-c",
      "import struct,sys;print(sys.version_info[0],sys.version_info[1],struct.calcsize('P')*8)",
    ],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) return null;
  const match = res.stdout.match(/(\d+) (\d+) (\d+)/);
  if (!match) return null;
  return {
    version: [Number(match[1]), Number(match[2])],
    bits: Number(match[3]),
  };
}

const isTested = ({ version: [major, minor], bits }) =>
  major === 3 && minor >= TESTED.min && minor <= TESTED.max && bits === 64;

/**
 * Deliberately keeps probing past the first hit, because the first hit is
 * routinely the wrong one. On this repo's own Windows machine a bare `python`
 * resolves to a 32-bit build that happens to sit earlier on PATH than the
 * 64-bit one — and PyTorch publishes no 32-bit wheels, so taking it would
 * build a venv that only fails later, during a multi-hundred-megabyte
 * install. Only when nothing suitable turns up does the first working
 * interpreter get used, with a warning naming what is off about it.
 */
function findPython(override) {
  if (override) {
    const found = probe(override, []);
    if (!found) fail(`${override} is not a working Python interpreter.`);
    return { cmd: override, args: [], ...found };
  }

  let firstWorking = null;
  for (const [cmd, args] of candidates()) {
    const found = probe(cmd, args);
    if (!found) continue;
    if (isTested(found)) return { cmd, args, ...found };
    firstWorking ??= { cmd, args, ...found };
  }
  return firstWorking;
}

function fail(message, hint) {
  console.error(`\nError: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) fail(`Could not run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} exited with code ${res.status}`);
}

const pip = venvPython();

// The venv check comes first on purpose. Once one exists it owns its own
// interpreter, and which Python happens to be on PATH today is irrelevant —
// reporting that one (or warning about its version) would describe something
// this run is not going to use.
if (fs.existsSync(pip)) {
  const existing = probe(pip, []);
  console.log(
    `Reusing the existing venv at ${venvDir}` +
      (existing
        ? ` (Python ${existing.version[0]}.${existing.version[1]}, ${existing.bits}-bit)`
        : ""),
  );
  // Say so rather than ignoring it quietly: someone passing an interpreter is
  // usually trying to change the one in use, and would otherwise walk away
  // believing they had.
  if (process.argv[2]) {
    console.log(
      `Ignoring the interpreter you passed (${process.argv[2]}) — the venv\n` +
        "already has its own. Delete tools/docling/.venv to rebuild it with a\n" +
        "different Python.",
    );
  }
} else {
  if (fs.existsSync(venvDir)) {
    fail(
      `${venvDir} exists but has no interpreter at ${pip}.`,
      "It is probably a half-finished or foreign-platform venv. Delete it and\n" +
        "run this again.",
    );
  }

  const python = findPython(process.argv[2]);
  if (!python) {
    fail(
      "No Python interpreter found.",
      isWindows
        ? "Install Python 3.12 or 3.13 from python.org, then run this again.\n" +
            "If it is installed but not on PATH, pass it directly:\n" +
            "  pnpm setup:docling C:\\path\\to\\python.exe"
        : "Install Python 3.12 or 3.13, then run this again, or pass one\n" +
            "directly:\n" +
            "  pnpm setup:docling /usr/local/bin/python3.12",
    );
  }

  const [major, minor] = python.version;
  console.log(
    `Using Python ${major}.${minor} (${python.bits}-bit, ${[python.cmd, ...python.args].join(" ")})`,
  );
  // Warnings rather than refusals: newer CPython does get wheels eventually,
  // and the user may know something this script doesn't. But say precisely
  // what is wrong, so the failure 20 minutes into a download isn't a mystery.
  if (python.bits !== 64) {
    console.warn(
      `Warning: this is a ${python.bits}-bit Python. PyTorch ships no ${python.bits}-bit wheels, so\n` +
        "the install below will almost certainly fail. Point this at a 64-bit\n" +
        "interpreter instead:\n" +
        "  pnpm setup:docling <path-to-64-bit-python>",
    );
  } else if (!isTested(python)) {
    console.warn(
      `Warning: Docling is tested against Python 3.${TESTED.min}-3.${TESTED.max}. On ${major}.${minor}\n` +
        "the PyTorch wheels it needs may not exist yet, and the install below\n" +
        "may fail. Pass a specific interpreter to override:\n" +
        "  pnpm setup:docling <path-to-python>",
    );
  }

  console.log(`Creating a venv at ${venvDir} …`);
  run(python.cmd, [...python.args, "-m", "venv", venvDir]);

  if (!fs.existsSync(pip)) {
    fail(
      `The venv was created but has no interpreter at ${pip}.`,
      "Delete tools/docling/.venv and run this again.",
    );
  }
}

// `python -m pip` rather than the pip executable: the shim embeds an absolute
// path at creation time and breaks if the repo is ever moved or renamed.
console.log("\nInstalling docling (this downloads ~1-2 GB, give it a while) …");
run(pip, ["-m", "pip", "install", "--upgrade", "pip"]);
run(pip, ["-m", "pip", "install", "docling"]);

console.log("\nVerifying the import …");
run(pip, [
  "-c",
  "import docling; print('docling', getattr(docling, '__version__', 'ok'))",
]);

console.log(
  "\nDone. myWiki will now use Docling automatically for new PDF uploads.",
);
