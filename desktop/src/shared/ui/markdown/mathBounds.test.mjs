import { MATH_LIMITS } from "@buzz/markdown-math";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderCachedMarkdown } from "./nodeCache.ts";

function render(content) {
  return renderToStaticMarkup(
    renderCachedMarkdown({ content, components: {}, variant: "math-bounds" }),
  );
}

test("plain prose remains unchanged", () => {
  assert.equal(
    render("Normal **bold** text."),
    "<p>Normal <strong>bold</strong> text.</p>",
  );
});

for (const content of [
  "The price is $5 and $10 today.",
  "Price \\$5 and $10.",
  "loose $ x$ here",
  "loose $x $ here",
  "price $5 and $10 and $15 today",
]) {
  test(`currency and loose delimiters stay literal: ${content}`, () => {
    assert.doesNotMatch(render(content), /class="katex"/);
  });
}

test("digit-led genuine math still renders after currency", () => {
  assert.equal(
    (render("pay $5 and $2^x$ end").match(/class="katex"/g) ?? []).length,
    1,
  );
});

test("the formula limit is inclusive and excludes code", () => {
  const formulas = Array.from(
    { length: MATH_LIMITS.maxFormulasPerMessage },
    () => "$x=1$",
  ).join(" ");
  assert.equal(
    (render(formulas).match(/class="katex"/g) ?? []).length,
    MATH_LIMITS.maxFormulasPerMessage,
  );
  assert.doesNotMatch(render(`${formulas} $y=2$`), /class="katex"/);
  assert.equal(
    (render(`\`${formulas}\`\n\n$x=1$`).match(/class="katex"/g) ?? []).length,
    1,
  );
});

test("the source-length limit is inclusive", () => {
  const atLimit = "x".repeat(MATH_LIMITS.maxFormulaLength);
  assert.match(render(`$${atLimit}$`), /class="katex"/);
  assert.doesNotMatch(render(`$${atLimit}x$`), /class="katex"/);
});

test("oversized display math preserves exact literal source and healthy siblings", () => {
  const source = `$$\n${"b".repeat(MATH_LIMITS.maxFormulaLength + 1)}\n$$`;
  const html = render(`${source}\n\n$x=1$`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.ok(html.includes(source));
  assert.match(html, /<pre><code>/);
});

test("math cannot introduce executable links or trusted HTML", () => {
  for (const command of [
    "\\href{javascript:alert(1)}{unsafe}",
    "\\htmlClass{injected}{unsafe}",
    "\\includegraphics{https://example.com/tracker.png}",
  ]) {
    const html = render(`$${command}$`);
    assert.doesNotMatch(html, /href="javascript:|class="injected"|<img/);
  }
});

test("math provides one accessible MathML representation", () => {
  const html = render("$E=mc^2$");
  assert.match(html, /<math xmlns=/);
  assert.match(html, /class="katex-html" aria-hidden="true"/);
});

test("formula definitions cannot leak into later messages", () => {
  render("$\\gdef\\buzzFormula{123}\\buzzFormula$");
  const next = render("$\\buzzFormula$");
  assert.match(next, /katex-html[\s\S]*\\buzzFormula/);
});

test("explicit dimensions are capped before reaching the browser", () => {
  const html = render("$\\rule{99999em}{99999em}$");
  assert.match(html, /width:20em/);
  assert.doesNotMatch(html, /style="[^"]*99999/);
});

test("explicit math fences render without dollar delimiters", () => {
  assert.match(render("```math\nE=mc^2\n```"), /class="katex"/);
});

test("math fences cannot bypass source-length or formula-count limits", () => {
  const huge = "x".repeat(MATH_LIMITS.maxFormulaLength + 1);
  assert.doesNotMatch(render(`\`\`\`math\n${huge}\n\`\`\``), /class="katex"/);
  const many = Array.from(
    { length: MATH_LIMITS.maxFormulasPerMessage + 1 },
    () => "```math\nx=1\n```",
  ).join("\n\n");
  assert.doesNotMatch(render(many), /class="katex"/);
});
