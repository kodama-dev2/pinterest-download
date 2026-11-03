const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const releaseDir = path.join(root, "release");

if (!fs.existsSync(releaseDir)) process.exit(0);

const keepName = (name) => {
  if (name.endsWith(".blockmap") || name.endsWith(".nsis.7z")) return false;
  if (name === "builder-debug.yml" || name.startsWith("latest-")) return false;
  if (/\.(dmg|zip|exe)$/i.test(name)) {
    return name.includes(`-${version}-`);
  }
  return false;
};

for (const name of fs.readdirSync(releaseDir)) {
  if (keepName(name)) continue;
  fs.rmSync(path.join(releaseDir, name), { recursive: true, force: true });
}
