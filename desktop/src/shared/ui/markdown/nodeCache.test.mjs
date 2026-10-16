import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { clearMarkdownNodeCache, renderCachedMarkdown } from "./nodeCache.ts";

// The whole point of the cache is element-identity reuse across the message
// timeline's per-channel-switch remount: same parse inputs must return the
// SAME element (no re-parse), and anything that changes the parse output
// must miss.

const BASE = {
  components: {},
  content: "**bold** and `code`",
  variant: "i",
};

test("same parse inputs return the identical cached element", () => {
  clearMarkdownNodeCache();
  const first = renderCachedMarkdown({ ...BASE });
  const second = renderCachedMarkdown({ ...BASE });
  assert.equal(first, second);
  assert.match(renderToStaticMarkup(first), /<strong>bold<\/strong>/);
});

test("content changes miss the cache", () => {
  clearMarkdownNodeCache();
  const first = renderCachedMarkdown({ ...BASE });
  const second = renderCachedMarkdown({ ...BASE, content: "**bald**" });
  assert.notEqual(first, second);
});

test("customEmoji is keyed by value, not identity", () => {
  clearMarkdownNodeCache();
  const emoji = [{ shortcode: "buzz", url: "https://relay/buzz.png" }];
  const first = renderCachedMarkdown({
    ...BASE,
    content: "hi :buzz:",
    customEmoji: emoji,
  });
  // Fresh array, same values — the exact remount scenario (useMessageEmoji
  // rebuilds the array): must HIT.
  const second = renderCachedMarkdown({
    ...BASE,
    content: "hi :buzz:",
    customEmoji: [{ shortcode: "buzz", url: "https://relay/buzz.png" }],
  });
  assert.equal(first, second);
  // Same content, different emoji set (e.g. emoji added while editing —
  // custom-emoji.spec.ts Bug 2): must MISS so the new emoji renders.
  const third = renderCachedMarkdown({
    ...BASE,
    content: "hi :buzz:",
    customEmoji: [{ shortcode: "buzz", url: "https://relay/other.png" }],
  });
  assert.notEqual(first, third);
});

test("mention and channel names are part of the key", () => {
  clearMarkdownNodeCache();
  const first = renderCachedMarkdown({
    ...BASE,
    content: "ping @alice in #general",
    mentionNames: ["alice"],
    channelNames: ["general"],
  });
  const second = renderCachedMarkdown({
    ...BASE,
    content: "ping @alice in #general",
    mentionNames: ["alice", "bob"],
    channelNames: ["general"],
  });
  assert.notEqual(first, second);
});

test("render variants do not collide", () => {
  clearMarkdownNodeCache();
  const interactive = renderCachedMarkdown({ ...BASE });
  const nonInteractive = renderCachedMarkdown({ ...BASE, variant: "" });
  assert.notEqual(interactive, nonInteractive);
});

test("leading inline content is inserted into the first prose-capable block", () => {
  const components = {
    span: ({ children, node: _node, ...props }) =>
      "data-leading-inline-content" in props
        ? React.createElement(
            "button",
            { "data-chip": "", type: "button" },
            "00:01",
          )
        : React.createElement("span", props, children),
  };

  for (const [content, pattern] of [
    ["plain note", /<p><button[^>]*>00:01<\/button>plain note<\/p>/],
    ["> quoted note", /<blockquote>\s*<p><button[^>]*>00:01<\/button>quoted/],
    ["- list note", /<li><button[^>]*>00:01<\/button>list note<\/li>/],
    ["# heading", /<h1><button[^>]*>00:01<\/button>heading<\/h1>/],
  ]) {
    const node = renderCachedMarkdown({
      ...BASE,
      components,
      content,
      leadingInlineContent: true,
      variant: "leading",
    });
    assert.match(renderToStaticMarkup(node), pattern);
  }
});

test("leading inline content falls back before code and media blocks", () => {
  const components = {
    span: ({ children, node: _node, ...props }) =>
      "data-leading-inline-content" in props
        ? React.createElement(
            "button",
            { "data-chip": "", type: "button" },
            "00:01",
          )
        : React.createElement("span", props, children),
  };

  for (const [content, blockPattern] of [
    ["```js\nconst answer = 42;\n```", "<pre"],
    ["![](https://example.com/review.png)", "<img"],
    ["```js\nconst answer = 42;\n```\n\nlater note", "<pre"],
    ["![](https://example.com/review.png)\n\nlater note", "<img"],
    ["> ```js\nconst answer = 42;\n```\n\n> later note", "<pre"],
    ["> ![](https://example.com/review.png)\n\n> later note", "<img"],
  ]) {
    const node = renderCachedMarkdown({
      ...BASE,
      components,
      content,
      leadingInlineContent: true,
      variant: "leading-fallback",
    });
    const html = renderToStaticMarkup(node);
    assert.match(html, /<p><button[^>]*>00:01<\/button><\/p>/);
    assert.ok(html.indexOf("<button") < html.indexOf(blockPattern));
  }
});

test("leading inline content stays on the outer tight-list item", () => {
  const components = {
    span: ({ children, node: _node, ...props }) =>
      "data-leading-inline-content" in props
        ? React.createElement(
            "button",
            { "data-chip": "", type: "button" },
            "00:01",
          )
        : React.createElement("span", props, children),
  };
  const node = renderCachedMarkdown({
    ...BASE,
    components,
    content: "- parent\n  - child",
    leadingInlineContent: true,
    variant: "leading-tight-nested-list",
  });

  assert.match(
    renderToStaticMarkup(node),
    /<li><button[^>]*>00:01<\/button>parent\s*<ul>\s*<li>child<\/li>/,
  );
});

test("leading inline content participates in the cache key", () => {
  clearMarkdownNodeCache();
  const withoutLeading = renderCachedMarkdown({ ...BASE });
  const withLeading = renderCachedMarkdown({
    ...BASE,
    leadingInlineContent: true,
  });
  assert.notEqual(withoutLeading, withLeading);
});

test("crafted values cannot forge key-segment boundaries", () => {
  clearMarkdownNodeCache();
  // Length-prefixed segments: a single name containing arbitrary bytes must
  // never be key-identical to two separate names, and values must not bleed
  // across the mention/channel field boundary.
  const joined = renderCachedMarkdown({
    ...BASE,
    mentionNames: ["ab"],
  });
  const split = renderCachedMarkdown({
    ...BASE,
    mentionNames: ["a", "b"],
  });
  assert.notEqual(joined, split);

  const inMentions = renderCachedMarkdown({ ...BASE, mentionNames: ["x"] });
  const inChannels = renderCachedMarkdown({ ...BASE, channelNames: ["x"] });
  assert.notEqual(inMentions, inChannels);
});

test("oversized content bypasses the cache", () => {
  clearMarkdownNodeCache();
  const huge = { ...BASE, content: "a".repeat(40_000) };
  const first = renderCachedMarkdown(huge);
  const second = renderCachedMarkdown(huge);
  assert.notEqual(first, second);
});

test("hardLineBreaks changes the parse and the cache key", () => {
  clearMarkdownNodeCache();
  const content = "hello\nworld";
  const withBreaks = renderCachedMarkdown({ ...BASE, content });
  const withoutBreaks = renderCachedMarkdown({
    ...BASE,
    content,
    hardLineBreaks: false,
  });
  assert.notEqual(withBreaks, withoutBreaks);
  assert.match(renderToStaticMarkup(withBreaks), /<br/i);
  assert.doesNotMatch(renderToStaticMarkup(withoutBreaks), /<br/i);
  const withoutBreaksAgain = renderCachedMarkdown({
    ...BASE,
    content,
    hardLineBreaks: false,
  });
  assert.equal(withoutBreaks, withoutBreaksAgain);
});

test("single-character scoped search stays on lexeme boundaries", () => {
  const html = renderToStaticMarkup(
    renderCachedMarkdown({ ...BASE, content: "A plan", searchQuery: "a" }),
  );

  assert.equal((html.match(/data-search-match="true"/g) ?? []).length, 1);
});

test("active search queries bypass the cache and highlight every match", () => {
  clearMarkdownNodeCache();
  const input = {
    ...BASE,
    content: "Bold and bold, but not code `bold`.",
    searchQuery: "bold",
  };
  const first = renderCachedMarkdown(input);
  const second = renderCachedMarkdown(input);
  const html = renderToStaticMarkup(first);

  assert.notEqual(first, second);
  assert.equal((html.match(/data-search-match="true"/g) ?? []).length, 2);
  assert.match(html, /bg-yellow-300/);
  assert.match(html, /<code>bold<\/code>/);
});

// --- KaTeX math rendering (M1) ---

test("inline math renders through KaTeX", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({ ...BASE, content: "Energy $E=mc^2$!" });
  const html = renderToStaticMarkup(el);
  assert.match(html, /katex/);
});

test("display math renders through KaTeX as a block", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({
    ...BASE,
    content: "$$\n\\int_0^1 x^2\\, dx\n$$",
  });
  const html = renderToStaticMarkup(el);
  assert.match(html, /katex-display/);
});

test("same math parse inputs return the identical cached element", () => {
  clearMarkdownNodeCache();
  const first = renderCachedMarkdown({ ...BASE, content: "$E=mc^2$" });
  const second = renderCachedMarkdown({ ...BASE, content: "$E=mc^2$" });
  assert.equal(first, second);
  // Cache hit means the KaTeX output tree is reused, never re-parsed.
});

test("non-math messages still render and produce no katex (regression)", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({ ...BASE });
  const html = renderToStaticMarkup(el);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.ok(!/katex/.test(html), "pure text produces no katex output");
});

test("KaTeX parse failure degrades to source without throwing", () => {
  clearMarkdownNodeCache();
  // throwOnError:false must swallow invalid LaTeX rather than raise.
  const el = renderCachedMarkdown({
    ...BASE,
    content: "bad $\\notarealcommand{}$",
  });
  assert.doesNotThrow(() => renderToStaticMarkup(el));
});

test("formula-bomb message is math-disabled and renders literally", () => {
  clearMarkdownNodeCache();
  // > 100 formulas trips the per-message cap => math off, literal `$...$`.
  const many = Array.from({ length: 101 }, (_, i) => `$x_{${i}}$`).join(" ");
  const el = renderCachedMarkdown({ ...BASE, content: many });
  const html = renderToStaticMarkup(el);
  assert.ok(!/katex/.test(html), "math disabled => no katex output");
  assert.match(html, /\$x_\{0\}\$/);
});

test("a single oversized formula is neutralised; sibling math still renders", () => {
  clearMarkdownNodeCache();
  // Only the >2KB formula trips the per-formula cap => that one is escaped to
  // literal while the healthy `$y=1$` sibling still renders via KaTeX. This is
  // the end-to-end check that the backslash-escape is honoured by remark-math.
  const huge = "a".repeat(2_001);
  const el = renderCachedMarkdown({
    ...BASE,
    content: `$y=1$ plus $${huge}$`,
  });
  const html = renderToStaticMarkup(el);
  assert.match(html, /katex/, "healthy sibling formula still renders as math");
});

// Review-driven (审查员 clean-clone regression): the oversized **display**
// `$$...$$` path was verified manually but not cemented by a unit test.

test("oversized display math degrades to literal with no stray partial math", () => {
  clearMarkdownNodeCache();
  const huge = "b".repeat(2_001);
  const el = renderCachedMarkdown({
    ...BASE,
    content: `only $$\n${huge}\n$$ here`,
  });
  const html = renderToStaticMarkup(el);
  // Escaping the opening `$$` must not leave a stray `$` that remark-math
  // re-reads as a (partial) inline formula: expect zero katex output.
  assert.equal(
    (html.match(/katex/g) ?? []).length,
    0,
    "fully literal degradation, no katex",
  );
  assert.ok(
    html.includes("b".repeat(64)),
    "oversized source preserved literally",
  );
});

test("oversized display formula is neutralised; sibling math still renders", () => {
  clearMarkdownNodeCache();
  const huge = "c".repeat(2_001);
  const el = renderCachedMarkdown({
    ...BASE,
    content: `lead $y=1$ then $$\n${huge}\n$$ and $keep$`,
  });
  const html = renderToStaticMarkup(el);
  assert.match(html, /katex/, "healthy sibling formulas still render as math");
  assert.ok(
    html.includes("c".repeat(64)),
    "oversized display preserved literally",
  );
});

// Field-tested (邱仲普 manual run): remark-math@6 accepts `$5 and $10` as math
// (content may contain spaces), so currency was mangled into a formula until
// mathBounds learned pandoc-style tightness rules.

test("currency dollar amounts render literally, no katex", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({
    ...BASE,
    content: "The price is $5 and $10 today.",
  });
  const html = renderToStaticMarkup(el);
  assert.ok(!/katex/.test(html), "currency must not become math");
  assert.match(html, /\$5 and \$10/);
});

test("CJK currency sentence renders literally, no katex", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({
    ...BASE,
    content: "价格在 $5 到 $10 之间",
  });
  const html = renderToStaticMarkup(el);
  assert.ok(!/katex/.test(html), "currency must not become math");
});

test("currency stays literal while a real formula in the same message renders", () => {
  clearMarkdownNodeCache();
  const el = renderCachedMarkdown({
    ...BASE,
    content: "pay $5 and $10, see $E=mc^2$",
  });
  const html = renderToStaticMarkup(el);
  // Exactly one formula (`$E=mc^2$`) renders; the currency pair does not.
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("literal dollar amounts inside inline code are unchanged", () => {
  const html = renderToStaticMarkup(
    renderCachedMarkdown({
      ...BASE,
      content: "Use `price $5 and $10` then $E=mc^2$.",
    }),
  );
  assert.match(html, /<code>price \$5 and \$10<\/code>/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("literal dollar amounts inside fenced code are unchanged", () => {
  const html = renderToStaticMarkup(
    renderCachedMarkdown({
      ...BASE,
      content: "```text\nprice $5 and $10\n```\n\nThen $x=1$.",
    }),
  );
  assert.match(html, /<code[^>]*>price \$5 and \$10\n<\/code>/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("escaped currency remains literal without creating math", () => {
  const html = renderToStaticMarkup(
    renderCachedMarkdown({
      ...BASE,
      content: "The price is \\$5 and $10 today.",
    }),
  );
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$5 and \$10/);
});

test("formula examples in code do not disable real math outside code", () => {
  const examples = Array.from({ length: 101 }, () => "$x=1$").join(" ");
  const html = renderToStaticMarkup(
    renderCachedMarkdown({
      ...BASE,
      content: `\`\`\`text\n${examples}\n\`\`\`\n\nEnergy $E=mc^2$.`,
    }),
  );
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("single-character search highlights prose without altering math", () => {
  const html = renderToStaticMarkup(
    renderCachedMarkdown({
      ...BASE,
      content: "x coordinate and $x^2$",
      searchQuery: "x",
    }),
  );
  assert.equal((html.match(/data-search-match="true"/g) ?? []).length, 1);
  assert.match(html, /<mi>x<\/mi>/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});
