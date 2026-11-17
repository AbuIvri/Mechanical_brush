// electron-builder afterPack hook: give the Mac app an ad-hoc signature.
//
// Without an Apple Developer ID the build is not signed at all, and an unsigned arm64 app
// does not start on Apple Silicon — macOS calls it "damaged", and the only way past that is
// the Terminal. Ad-hoc signed, it gets the ordinary "unidentified developer" warning
// instead, which a user can wave through in System Settings → Privacy & Security.
// Only the final universal app is signed: signing the per-arch halves before they are
// merged would make the merge see two different files.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (/-temp$/.test(context.appOutDir)) return; // a per-arch half of a universal build
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Finder metadata on any file in the bundle makes codesign refuse ("detritus not allowed").
  execFileSync("xattr", ["-cr", app], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed  ${path.basename(app)}`);
};
