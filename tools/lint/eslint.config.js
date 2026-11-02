// ESLint flat config. Run from the repository root: `npm run lint` (see package.json).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Files allowed past the size limits below, each with the reason. Keep this list short. */
const LARGE_FILES = {};

export default tseslint.config(
  { ignores: ["**/node_modules/**", "dist/**", ".devconfig*/**", "tools/lint/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Prettier formats to 140 columns; this catches what it can't wrap (long comments, chained expressions).
      "max-len": ["error", { code: 140, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreUrls: true, ignoreRegExpLiterals: true }],
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.mjs", "test/**/*.ts", "tools/**/*.{js,cjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.commonjs } },
  },
  {
    files: ["server/**/*.ts", "shared/**/*.ts"],
    rules: { "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  ...Object.entries(LARGE_FILES).map(([file, max]) => ({
    files: [file],
    rules: { "max-lines": ["error", { max, skipBlankLines: true, skipComments: true }] },
  })),
);
