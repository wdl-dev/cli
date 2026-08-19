import js from "@eslint/js";
import globals from "globals";

const nodeGlobals = {
  ...globals.node,
  ...globals.es2024,
};

const workerGlobals = {
  ...globals.browser,
  ...globals.worker,
  ...globals.serviceworker,
  ...globals.es2024,
  DurableObject: "readonly",
  DurableObjectState: "readonly",
  DurableObjectNamespace: "readonly",
  WorkflowEntrypoint: "readonly",
  WorkerEntrypoint: "readonly",
  WebSocketPair: "readonly",
};

const commonRules = {
  "eqeqeq": ["error", "smart"],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-implicit-coercion": "error",
  "no-throw-literal": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-var": "error",
  "prefer-const": "error",
};

export default [
  js.configs.recommended,
  {
    ignores: ["**/node_modules/**", "**/.deploy-dist/**", "**/.wrangler/**"],
  },
  {
    files: ["bin/**/*.js", "commands/**/*.js", "lib/**/*.js", "scripts/**/*.js", "tests/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: commonRules,
  },
  {
    files: ["examples/**/*.js", "templates/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: workerGlobals,
    },
    rules: commonRules,
  },
];
