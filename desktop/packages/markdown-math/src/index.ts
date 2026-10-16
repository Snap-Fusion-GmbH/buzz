import type { Root } from "mdast";
import type {} from "mdast-util-math";
import type {} from "micromark-extension-math";
import type { Effects, Token, Tokenizer } from "micromark-util-types";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type {} from "remark-parse";
import type { Plugin } from "unified";
import { EXIT, visit } from "unist-util-visit";

/** Bounds apply to formulas, never to dollar signs inside ordinary code or URLs. */
export const MATH_LIMITS = {
  maxFormulasPerMessage: 100,
  maxFormulaLength: 2_000,
} as const;

function tightInlineMath(tokenize: Tokenizer): Tokenizer {
  return function (effects, ok, nok) {
    let token: Token | undefined;
    const trackedEffects: Effects = {
      ...effects,
      enter(type, fields) {
        const entered = effects.enter(type, fields);
        if (type === "mathText") token = entered;
        return entered;
      },
    };
    return tokenize.call(
      this,
      trackedEffects,
      (code) => {
        if (!token) return nok(code);
        const source = this.sliceSerialize(token);
        if (source.startsWith("$") && !source.startsWith("$$")) {
          const body = source.slice(1, -1);
          if (
            /^[ \t\r\n]|[ \t\r\n]$/.test(body) ||
            (code !== null && code >= 48 && code <= 57)
          ) {
            return nok(code);
          }
        }
        return ok(code);
      },
      nok,
    );
  };
}

/**
 * Parse math with remark-math, applying currency rules at its tokenizer boundary
 * and resource limits to its real syntax tree. Markdown source is never rewritten.
 */
export const remarkBoundedMath: Plugin<[], Root> = function () {
  remarkMath.call(this);
  const extensions = this.data().micromarkExtensions;
  const extension = extensions?.[extensions.length - 1];
  const construct = extension?.text?.[36];
  if (!construct || Array.isArray(construct)) {
    throw new Error("remark-math did not provide its inline math tokenizer");
  }
  construct.tokenize = tightInlineMath(construct.tokenize);

  return (tree, file) => {
    const mathTypes = ["inlineMath", "math", "code"] as const;
    let count = 0;
    visit(tree, mathTypes, (node) => {
      if (node.type === "code" && node.lang !== "math") return;
      count += 1;
      if (count > MATH_LIMITS.maxFormulasPerMessage) return EXIT;
    });
    const disableMath = count > MATH_LIMITS.maxFormulasPerMessage;
    const source = file.toString();
    visit(tree, mathTypes, (node, index, parent) => {
      if (
        index === undefined ||
        !parent ||
        (node.type === "code" && node.lang !== "math") ||
        (!disableMath &&
          node.value.trim().length > 0 &&
          node.value.length <= MATH_LIMITS.maxFormulaLength)
      ) {
        return;
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const literal =
        start !== undefined && end !== undefined
          ? source.slice(start, end)
          : node.type === "inlineMath"
            ? `$${node.value}$`
            : `$$\n${node.value}\n$$`;
      parent.children[index] =
        node.type === "inlineMath"
          ? { type: "text", value: literal, position: node.position }
          : { type: "code", value: literal, position: node.position };
    });
  };
};

/** Render accessible math with trusted HTML/URLs disabled and bounded expansion. */
export function rehypeBoundedKatex() {
  return rehypeKatex({
    trust: false,
    errorColor: "currentColor",
    maxExpand: 1_000,
    maxSize: 20,
    output: "htmlAndMathml",
  });
}
