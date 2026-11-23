// macOS: give the app a free "ad-hoc" signature after it is packed (and its fuses are set).
// Apple Silicon Macs refuse to run apps with no signature at all; ad-hoc is enough for testing.
// (A paid Apple Developer ID would replace this and remove the "unidentified developer" warning.)
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
