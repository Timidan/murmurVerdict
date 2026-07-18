// ─── CodeWindow — framed, syntax-colored code presentation ────────────────
//
// A calm terminal-style code window for docs surfaces (install page,
// integrate page). Header strip = title (left) + language badge and
// [ copy ] (right); body = monospace pre with a tiny regex tokenizer for
// color. No external highlighter dependency — four token classes in the
// Nothing palette are enough at our scale, and shiki/prism would drag a
// grammar bundle into the public route chunks.
//
// Color mapping (theme-aware via the ck CSS vars):
//   comment      → --color-secondary   (dim)
//   string       → --color-display     (bright)
//   keyword      → --color-display, bold
//   placeholder  → --color-accent      (<like-this>, $ENV_VARS — the bits
//                                       the reader must replace; red is the
//                                       "look here" spark, used sparingly)

import { useCallback, useEffect, useRef, useState } from "react";

export type CodeLang = "bash" | "typescript" | "python" | "json";

const KEYWORDS: Record<CodeLang, string[]> = {
  bash: ["curl", "export", "echo", "jq"],
  typescript: [
    "const", "let", "await", "async", "function", "return",
    "import", "from", "export", "new", "typeof",
  ],
  python: ["import", "from", "with", "as", "def", "return", "print", "None", "True", "False"],
  json: ["true", "false", "null"],
};

const COMMENT_RE: Record<CodeLang, RegExp | null> = {
  bash: /#[^\n]*/y,
  python: /#[^\n]*/y,
  typescript: /\/\/[^\n]*/y,
  json: null,
};

const STRING_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y;
const PLACEHOLDER_RE = /<[a-zA-Z0-9 _.-]+>|\{\{[a-zA-Z0-9_]+\}\}|\$[A-Z][A-Z0-9_]+|\$\(uuidgen\)/y;
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

type Token = { kind: "cmt" | "str" | "kw" | "ph" | "plain"; text: string };

function tokenize(code: string, lang: CodeLang): Token[] {
  const out: Token[] = [];
  const kw = new Set(KEYWORDS[lang]);
  const commentRe = COMMENT_RE[lang];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  while (i < code.length) {
    if (commentRe) {
      commentRe.lastIndex = i;
      const m = commentRe.exec(code);
      if (m) {
        flush();
        out.push({ kind: "cmt", text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    STRING_RE.lastIndex = i;
    const s = STRING_RE.exec(code);
    if (s) {
      flush();
      // strings may embed <placeholders> the reader must replace — keep the
      // accent visible inside the quotes
      for (const part of splitPlaceholders(s[0])) out.push(part);
      i += s[0].length;
      continue;
    }
    PLACEHOLDER_RE.lastIndex = i;
    const p = PLACEHOLDER_RE.exec(code);
    if (p) {
      flush();
      out.push({ kind: "ph", text: p[0] });
      i += p[0].length;
      continue;
    }
    WORD_RE.lastIndex = i;
    const w = WORD_RE.exec(code);
    if (w) {
      if (kw.has(w[0])) {
        flush();
        out.push({ kind: "kw", text: w[0] });
      } else {
        plain += w[0];
      }
      i += w[0].length;
      continue;
    }
    plain += code[i];
    i += 1;
  }
  flush();
  return out;
}

function splitPlaceholders(str: string): Token[] {
  const out: Token[] = [];
  let rest = str;
  const re = /<[a-zA-Z0-9 _.-]+>|\$[A-Z][A-Z0-9_]+/;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m || m.index === undefined) {
      out.push({ kind: "str", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "str", text: rest.slice(0, m.index) });
    out.push({ kind: "ph", text: m[0] });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const TOKEN_STYLE: Record<Token["kind"], React.CSSProperties | undefined> = {
  cmt: { color: "var(--color-secondary)" },
  str: { color: "var(--color-display)" },
  kw: { color: "var(--color-display)", fontWeight: 700 },
  ph: { color: "var(--color-accent-ink)" },
  plain: undefined,
};

export function HighlightedCode({ code, lang }: { code: string; lang: CodeLang }) {
  return (
    <>
      {tokenize(code, lang).map((t, idx) =>
        t.kind === "plain" ? (
          t.text
        ) : (
          <span key={idx} style={TOKEN_STYLE[t.kind]}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}

const LANG_LABEL: Record<CodeLang, string> = {
  bash: "sh",
  typescript: "ts",
  python: "py",
  json: "json",
};

export function CodeWindow({
  code,
  lang,
  title,
  copyable = true,
}: {
  code: string;
  lang: CodeLang;
  title?: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="border border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--color-border)]">
        <span className="ck-label ck-dim">{title ?? " "}</span>
        <span className="ml-auto ck-mono ck-dim text-[10px]">{LANG_LABEL[lang]}</span>
        {copyable && (
          <button className="ck-btn ck-btn-bracket" onClick={copy}>
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
      <pre className="ck-mono whitespace-pre overflow-x-auto px-3 py-2 leading-tight text-[11px]">
        <HighlightedCode code={code} lang={lang} />
      </pre>
    </div>
  );
}
