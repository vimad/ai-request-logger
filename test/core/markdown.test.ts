import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { block } from "../../src/core/markdown.ts";

describe("content blocks are never truncated", () => {
  it("keeps the whole of a long block, head and tail", () => {
    const huge = "HEAD\n" + "x".repeat(200_000) + "\nTAIL";
    const out = block(huge);
    assert.ok(out.includes("HEAD"));
    assert.ok(out.includes("TAIL"));
    assert.ok(out.length > huge.length, "content must be present in full");
    assert.ok(!out.includes("truncated"));
  });

  it("puts long content in a fixed-height scroll box", () => {
    const out = block("line\n".repeat(500));
    assert.match(out, /max-height:/);
    assert.match(out, /overflow: auto/);
    assert.match(out, /scroll inside the box/);
  });

  it("leaves short content as an ordinary fenced block", () => {
    const out = block("just a line");
    assert.equal(out, "```text\njust a line\n```");
  });

  it("escapes markup inside a scroll box so it is not swallowed", () => {
    const out = block("<b>bold & bigger</b>\n".repeat(100));
    assert.match(out, /&lt;b&gt;bold &amp; bigger&lt;\/b&gt;/);
    assert.ok(!out.includes("<b>bold"), "raw markup would be rendered instead of shown");
  });

  it("sizes the fence past any backtick run in short content", () => {
    const out = block("```\ninner\n```");
    assert.match(out, /^````text\n/, "a 3-backtick fence would be broken by the content");
    assert.ok(out.includes("```\ninner\n```"));
  });
});
