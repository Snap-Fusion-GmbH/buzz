# Markdown Math

Private workspace plugins used by the desktop message renderer and web Markdown.
Based on the KaTeX integration in upstream Buzz PR #5405 by whyihaveyou.

`remarkBoundedMath` delegates parsing to remark-math. Single-dollar inline math
requires non-whitespace immediately inside both delimiters and no digit after
the closing delimiter. Double-dollar math retains remark-math's normal syntax.
Explicit fenced `math` blocks also render as formulas. Ordinary code blocks,
inline code, escaped dollars, and destinations keep their Markdown meaning
because raw source is never rewritten.

More than 100 parsed formulas disables math for the document. A formula longer
than 2,000 characters becomes literal on its own; other formulas still render.
Disabled display formulas become code blocks to preserve their source.
KaTeX disallows trusted HTML and URLs, caps macro expansion and explicit sizes,
and retains MathML alongside its aria-hidden visual output.

Import `@buzz/markdown-math/styles.css` once per app. Wide inline and display
equations scroll locally. No remote stylesheet or font service is required.

Regression tests bind the desktop production renderer in
`desktop/src/shared/ui/markdown/{mathBounds,nodeCache}.test.mjs`; browser tests
exercise desktop timelines, threads, cached channel switches, and web Markdown.
