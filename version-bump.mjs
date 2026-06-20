import { readFileSync, writeFileSync } from "fs";

// Bumps manifest.json + versions.json to match the version `npm version` set in
// package.json. Run automatically by the "version" npm script.
const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	throw new Error("npm_package_version is not set; run via `npm version`.");
}

// manifest.json: set version, keep the existing minAppVersion.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// versions.json: record which minAppVersion this plugin version needs.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
