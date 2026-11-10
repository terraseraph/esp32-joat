import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "web/dist/**", ".data/**", "coverage/**", "proto/**", "release/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { files: ["server/**/*.ts", "electron/**/*.ts", "scripts/**/*.mjs", "*.js"], languageOptions: { globals: globals.node } },
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  // server/src is bundled to CJS: import.meta is not available there.
  {
    files: ["server/src/**/*.ts", "electron/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", { selector: "MetaProperty[meta.name='import']", message: "No import.meta in server/src (it is bundled to CJS); pass paths in through start() options." }] },
  },
);
