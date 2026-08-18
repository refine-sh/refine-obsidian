import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Mirrors the checks the Obsidian directory review runs against the plugin
// source. Tests and build scripts are excluded: they stand in for the host, so
// they use the raw DOM and timer globals the plugin itself must avoid.
export default tseslint.config(
  {
    ignores: ["main.js", "test/**", "esbuild.config.mjs", "vitest.config.ts"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // Naming an explicit brand list replaces the built-in one, so the
      // proper nouns this plugin's UI text uses are all spelled out here.
      "obsidianmd/ui/sentence-case": [
        "error",
        { brands: ["Refine", "Obsidian", "Markdown"] },
      ],
    },
  },
);
