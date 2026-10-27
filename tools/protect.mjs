// 配信用に、HTML の中のプログラムを読みにくくする（コメント削除・圧縮・名前の置き換え・文字列の隠し）
// 使い方: node protect.mjs 入力.html 出力.html [--strong]
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");   // 実行したフォルダの node_modules を使う
const { minify } = require("terser");
const strong = process.argv.includes("--strong");
const [inp, out] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const NOTICE = "© 2026 株式会社Refore All rights reserved. 本プログラムの無断複製・改変・転載・解析（リバースエンジニアリング）を禁じます。";
let html = fs.readFileSync(inp, "utf8");

// 1) script の外：HTML コメントと CSS コメントを消す
const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i);
for (let i = 0; i < parts.length; i += 2) {
  parts[i] = parts[i]
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n+/g, "\n") + b);
}

// 2) 外部読み込みでない script を圧縮・難読化
for (let i = 1; i < parts.length; i += 2) {
  const m = parts[i].match(/^(<script\b[^>]*>)([\s\S]*?)(<\/script>)$/i);
  if (!m || /\bsrc=/.test(m[1]) || !m[2].trim() || /type="(application\/(ld\+)?json|text\/template)"/.test(m[1])) continue;
  let code = (await minify(m[2], {
    ecma: 2020, toplevel: true,
    compress: { passes: 2, keep_fargs: false },
    mangle: { toplevel: true },
    format: { comments: false, ascii_only: false },
  })).code;
  if (strong) {
    const JO = require("javascript-obfuscator");
    code = JO.obfuscate(code, {
      compact: true, target: "browser",
      stringArray: true, stringArrayThreshold: 0.6, stringArrayEncoding: ["base64"], rotateStringArray: true, shuffleStringArray: true,
      splitStrings: false, controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false,
      identifierNamesGenerator: "mangled", renameGlobals: false, transformObjectKeys: false, unicodeEscapeSequence: false,
    }).getObfuscatedCode();
  }
  parts[i] = m[1] + `/*! ${NOTICE} */` + code + m[3];
}
html = parts.join("");
html = /^<!doctype html>/i.test(html) ? html.replace(/^<!doctype html>/i, m => `${m}\n<!-- ${NOTICE} -->`) : `<!-- ${NOTICE} -->\n` + html;
fs.writeFileSync(out, html);
console.log("protected", out, Math.round(fs.statSync(inp).size / 1024) + "KB →", Math.round(fs.statSync(out).size / 1024) + "KB", strong ? "(strong)" : "");
