import { fileURLToPath } from "node:url";
import { validateReleasePackageDirectory } from "../src/packages/package-directory.ts";

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invoked) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node --experimental-strip-types scripts/check-module-package.ts <package-dir>");
    process.exit(1);
  }

  const result = await validateReleasePackageDirectory(target);
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }

  console.log(result.package.moduleId + "@" + result.package.version + " is a valid CGP package.");
  console.log("Runtime: " + result.package.descriptor.runtime.kind);
  console.log("Package tree: " + result.package.packageTreeProfile + " " + result.package.packageTreeDigest);
  console.log("Artifact: " + result.package.artifactDigest);
  console.log("Files: " + result.package.files.join(", "));
}
