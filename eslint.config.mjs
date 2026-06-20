import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// "Git" is a proper noun and "Git History Reviewer" is the plugin's
			// own name; the sentence-case heuristic flags both incorrectly, and
			// Obsidian's automated review does not enforce this rule.
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		ignores: ["main.js", "node_modules/**", "esbuild.config.mjs"],
	},
]);
