import type { BundledLanguage } from "shiki";
import type { HighlighterCore, LanguageRegistration } from "shiki/core";

export type PreviewColorMode = "light" | "dark";

export interface HighlightToken {
  content: string;
  color?: string;
  backgroundColor?: string;
  fontStyle?: number;
}

export interface HighlightedSource {
  background?: string;
  foreground?: string;
  language: BundledLanguage;
  lines: HighlightToken[][];
  theme: "github-light" | "github-dark";
}

type LanguageLoader = () => Promise<LanguageRegistration[]>;

// An explicit set keeps Vite from pulling Shiki's full language registry into
// the renderer. Every grammar remains a lazy chunk and is cached after first use.
const LANGUAGE_LOADERS = {
  astro: () => import("shiki/langs/astro.mjs").then((module) => module.default),
  bash: () => import("shiki/langs/bash.mjs").then((module) => module.default),
  c: () => import("shiki/langs/c.mjs").then((module) => module.default),
  clojure: () =>
    import("shiki/langs/clojure.mjs").then((module) => module.default),
  cmake: () => import("shiki/langs/cmake.mjs").then((module) => module.default),
  cpp: () => import("shiki/langs/cpp.mjs").then((module) => module.default),
  csharp: () =>
    import("shiki/langs/csharp.mjs").then((module) => module.default),
  css: () => import("shiki/langs/css.mjs").then((module) => module.default),
  csv: () => import("shiki/langs/csv.mjs").then((module) => module.default),
  dart: () => import("shiki/langs/dart.mjs").then((module) => module.default),
  diff: () => import("shiki/langs/diff.mjs").then((module) => module.default),
  dockerfile: () =>
    import("shiki/langs/dockerfile.mjs").then((module) => module.default),
  dotenv: () =>
    import("shiki/langs/dotenv.mjs").then((module) => module.default),
  elisp: () => import("shiki/langs/elisp.mjs").then((module) => module.default),
  elixir: () =>
    import("shiki/langs/elixir.mjs").then((module) => module.default),
  fish: () => import("shiki/langs/fish.mjs").then((module) => module.default),
  fsharp: () =>
    import("shiki/langs/fsharp.mjs").then((module) => module.default),
  gdscript: () =>
    import("shiki/langs/gdscript.mjs").then((module) => module.default),
  gleam: () => import("shiki/langs/gleam.mjs").then((module) => module.default),
  go: () => import("shiki/langs/go.mjs").then((module) => module.default),
  graphql: () =>
    import("shiki/langs/graphql.mjs").then((module) => module.default),
  groovy: () =>
    import("shiki/langs/groovy.mjs").then((module) => module.default),
  handlebars: () =>
    import("shiki/langs/handlebars.mjs").then((module) => module.default),
  haskell: () =>
    import("shiki/langs/haskell.mjs").then((module) => module.default),
  html: () => import("shiki/langs/html.mjs").then((module) => module.default),
  ini: () => import("shiki/langs/ini.mjs").then((module) => module.default),
  java: () => import("shiki/langs/java.mjs").then((module) => module.default),
  javascript: () =>
    import("shiki/langs/javascript.mjs").then((module) => module.default),
  json: () => import("shiki/langs/json.mjs").then((module) => module.default),
  json5: () => import("shiki/langs/json5.mjs").then((module) => module.default),
  jsonc: () => import("shiki/langs/jsonc.mjs").then((module) => module.default),
  jsx: () => import("shiki/langs/jsx.mjs").then((module) => module.default),
  just: () => import("shiki/langs/just.mjs").then((module) => module.default),
  kotlin: () =>
    import("shiki/langs/kotlin.mjs").then((module) => module.default),
  less: () => import("shiki/langs/less.mjs").then((module) => module.default),
  lua: () => import("shiki/langs/lua.mjs").then((module) => module.default),
  makefile: () =>
    import("shiki/langs/makefile.mjs").then((module) => module.default),
  markdown: () =>
    import("shiki/langs/markdown.mjs").then((module) => module.default),
  mdx: () => import("shiki/langs/mdx.mjs").then((module) => module.default),
  nix: () => import("shiki/langs/nix.mjs").then((module) => module.default),
  php: () => import("shiki/langs/php.mjs").then((module) => module.default),
  powershell: () =>
    import("shiki/langs/powershell.mjs").then((module) => module.default),
  prisma: () =>
    import("shiki/langs/prisma.mjs").then((module) => module.default),
  properties: () =>
    import("shiki/langs/properties.mjs").then((module) => module.default),
  protobuf: () =>
    import("shiki/langs/protobuf.mjs").then((module) => module.default),
  python: () =>
    import("shiki/langs/python.mjs").then((module) => module.default),
  r: () => import("shiki/langs/r.mjs").then((module) => module.default),
  ruby: () => import("shiki/langs/ruby.mjs").then((module) => module.default),
  rust: () => import("shiki/langs/rust.mjs").then((module) => module.default),
  sass: () => import("shiki/langs/sass.mjs").then((module) => module.default),
  scala: () => import("shiki/langs/scala.mjs").then((module) => module.default),
  scss: () => import("shiki/langs/scss.mjs").then((module) => module.default),
  shell: () => import("shiki/langs/shell.mjs").then((module) => module.default),
  solidity: () =>
    import("shiki/langs/solidity.mjs").then((module) => module.default),
  sql: () => import("shiki/langs/sql.mjs").then((module) => module.default),
  svelte: () =>
    import("shiki/langs/svelte.mjs").then((module) => module.default),
  swift: () => import("shiki/langs/swift.mjs").then((module) => module.default),
  terraform: () =>
    import("shiki/langs/terraform.mjs").then((module) => module.default),
  toml: () => import("shiki/langs/toml.mjs").then((module) => module.default),
  tsx: () => import("shiki/langs/tsx.mjs").then((module) => module.default),
  typescript: () =>
    import("shiki/langs/typescript.mjs").then((module) => module.default),
  vue: () => import("shiki/langs/vue.mjs").then((module) => module.default),
  wasm: () => import("shiki/langs/wasm.mjs").then((module) => module.default),
  wgsl: () => import("shiki/langs/wgsl.mjs").then((module) => module.default),
  xml: () => import("shiki/langs/xml.mjs").then((module) => module.default),
  yaml: () => import("shiki/langs/yaml.mjs").then((module) => module.default),
  zig: () => import("shiki/langs/zig.mjs").then((module) => module.default),
  zsh: () => import("shiki/langs/zsh.mjs").then((module) => module.default),
} satisfies Partial<Record<BundledLanguage, LanguageLoader>>;

const FILE_NAME_LANGUAGES: Readonly<Record<string, BundledLanguage>> = {
  "cmakelists.txt": "cmake",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  justfile: "just",
  makefile: "makefile",
  podfile: "ruby",
};

const EXTENSION_LANGUAGES: Readonly<Record<string, BundledLanguage>> = {
  astro: "astro",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "csv",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  dotenv: "dotenv",
  eex: "elixir",
  el: "elisp",
  ex: "elixir",
  exs: "elixir",
  fish: "fish",
  fs: "fsharp",
  fsx: "fsharp",
  gd: "gdscript",
  gleam: "gleam",
  go: "go",
  gql: "graphql",
  gradle: "groovy",
  graphql: "graphql",
  h: "c",
  handlebars: "handlebars",
  hbs: "handlebars",
  hpp: "cpp",
  hs: "haskell",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  nix: "nix",
  patch: "diff",
  php: "php",
  prisma: "prisma",
  properties: "properties",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  sol: "solidity",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  tf: "terraform",
  tfvars: "terraform",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  wasm: "wasm",
  wgsl: "wgsl",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "zsh",
};

const LANGUAGE_HINTS: Readonly<Record<string, BundledLanguage>> = {
  ...EXTENSION_LANGUAGES,
  javascript: "javascript",
  jsx: "jsx",
  kotlin: "kotlin",
  markdown: "markdown",
  python: "python",
  rust: "rust",
  shell: "shell",
  tsx: "tsx",
  typescript: "typescript",
};

/**
 * Resolve only to a known bundled grammar. The file path wins over the main
 * process hint so renamed or compound project files still get the right grammar.
 */
export function languageForPreview(
  relativePath: string,
  hint?: string,
): BundledLanguage | null {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const fileName = normalizedPath
    .slice(normalizedPath.lastIndexOf("/") + 1)
    .toLowerCase();
  const namedLanguage = FILE_NAME_LANGUAGES[fileName];
  if (namedLanguage) return namedLanguage;

  const extension = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1)
    : "";
  const extensionLanguage = EXTENSION_LANGUAGES[extension];
  if (extensionLanguage) return extensionLanguage;

  return hint ? (LANGUAGE_HINTS[hint.toLowerCase()] ?? null) : null;
}

let highlighterPromise: Promise<HighlighterCore> | undefined;
const languageLoadPromises = new Map<BundledLanguage, Promise<void>>();

function loadHighlighter(): Promise<HighlighterCore> {
  // Keep the engine and themes out of Electron main and the initial renderer
  // bundle. The JavaScript engine also avoids shipping a WASM runtime.
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
  ]).then(
    ([
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      dark,
      light,
    ]) =>
      createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        langs: [],
        themes: [dark.default, light.default],
      }),
  );
  return highlighterPromise;
}

async function loadLanguage(
  language: BundledLanguage,
): Promise<HighlighterCore> {
  const highlighter = await loadHighlighter();
  if (highlighter.getLoadedLanguages().includes(language)) return highlighter;

  const loader = LANGUAGE_LOADERS[language as keyof typeof LANGUAGE_LOADERS];
  if (!loader)
    throw new Error(`No preview grammar is registered for ${language}`);
  let loading = languageLoadPromises.get(language);
  if (!loading) {
    loading = loader().then((registration) =>
      highlighter.loadLanguage(registration),
    );
    languageLoadPromises.set(language, loading);
  }
  try {
    await loading;
  } catch (cause) {
    languageLoadPromises.delete(language);
    throw cause;
  }
  return highlighter;
}

export async function highlightSource(
  code: string,
  language: BundledLanguage,
  colorMode: PreviewColorMode,
): Promise<HighlightedSource> {
  const theme = colorMode === "dark" ? "github-dark" : "github-light";
  const highlighter = await loadLanguage(language);
  const result = highlighter.codeToTokens(code, { lang: language, theme });

  // Return token data instead of Shiki HTML. React escapes every token's content,
  // so workspace source can never become executable renderer markup.
  return {
    background: result.bg,
    foreground: result.fg,
    language,
    lines: result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color,
        backgroundColor: token.bgColor,
        fontStyle: token.fontStyle,
      })),
    ),
    theme,
  };
}
