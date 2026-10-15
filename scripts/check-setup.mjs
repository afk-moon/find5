// Runs automatically before `npm run dev` and catches common setup mistakes with a clear message
// (instead of "'next' is not recognized as an internal or external command").
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const problems = [];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  problems.push(`Node.js ${process.versions.node} is too old. Install Node 20.9 or newer (24 LTS recommended); see README step 1.`);
}

const root = process.cwd();
let installed = true;
try {
  createRequire(path.join(root, "package.json")).resolve("next/package.json");
} catch {
  installed = false;
  problems.push("Dependencies aren't installed in this folder yet. Run `npm install` first (README step 3).");
}

const shim = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
if (installed && !existsSync(shim)) {
  problems.push(
    "node_modules looks incomplete, or was copied from another computer. Delete the node_modules folder, then run `npm install` again.",
  );
}

if (problems.length) {
  console.error(`\n⚠️  FiveStack can't start yet:\n${problems.map((p) => `  • ${p}`).join("\n")}\n`);
  process.exit(1);
}
