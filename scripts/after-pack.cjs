const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist");
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--entitlements", entitlements, appPath],
    { stdio: "inherit" }
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
