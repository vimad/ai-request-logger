import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { describeRequest, type AnthropicRequestBody } from "../../src/claude/turns.ts";

const TOOLS = [{ name: "Bash" }, { name: "Read" }];
const shape = (body: AnthropicRequestBody) => describeRequest(body, {}, true);

describe("turn detection", () => {
  it("anchors the turn on the user's message", () => {
    const s = shape({ tools: TOOLS, messages: [{ role: "user", content: "hello" }] });
    assert.equal(s.kind, "main");
    assert.equal(s.turnLabel, "hello");
    assert.equal(s.userText, "hello");
  });

  it("keeps the same turn key across a tool loop", () => {
    const first = shape({ tools: TOOLS, messages: [{ role: "user", content: "do it" }] });
    const second = shape({
      tools: TOOLS,
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    assert.equal(first.turnKey, second.turnKey, "a tool hop must not open a new turn");
  });

  it("treats a tool_result carrying a system-reminder as a continuation", () => {
    // Claude Code staples reminders onto tool results; that must not read as
    // fresh user input.
    const s = shape({
      tools: TOOLS,
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "text", text: "<system-reminder>be careful</system-reminder>" },
          ],
        },
      ],
    });
    assert.equal(s.userText, "do it");
    assert.equal(s.turnKey, shape({ tools: TOOLS, messages: [{ role: "user", content: "do it" }] }).turnKey);
  });

  it("gives the same key whether content is a string or a block array", () => {
    // The regression that split one turn across two directories: Claude Code
    // sends the prompt as blocks first and as a bare string on follow-ups.
    const asBlocks = shape({
      tools: TOOLS,
      messages: [{ role: "user", content: [{ type: "text", text: "summarise the readme" }] }],
    });
    const asString = shape({
      tools: TOOLS,
      messages: [{ role: "user", content: "summarise the readme" }],
    });
    assert.equal(asBlocks.turnKey, asString.turnKey);
  });

  it("ignores injected system-reminders when identifying and labelling a turn", () => {
    const withReminder = shape({
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context A, changes often</system-reminder>" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    });
    const otherReminder = shape({
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context B, totally different</system-reminder>" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    });
    assert.equal(withReminder.turnLabel, "hello", "the label is what the user typed");
    assert.equal(withReminder.turnKey, otherReminder.turnKey, "reminder churn must not split a turn");
  });

  it("does not open a turn for a message that is only a reminder", () => {
    const s = shape({
      tools: TOOLS,
      messages: [
        { role: "user", content: "real question" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "<system-reminder>note</system-reminder>" }] },
      ],
    });
    assert.equal(s.userText, "real question");
  });

  it("separates two identical prompts asked at different points", () => {
    const first = shape({ tools: TOOLS, messages: [{ role: "user", content: "again" }] });
    const later = shape({
      tools: TOOLS,
      messages: [
        { role: "user", content: "again" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "again" },
      ],
    });
    assert.notEqual(first.turnKey, later.turnKey);
  });

  it("classifies a toolless background call as aux", () => {
    const s = shape({ messages: [{ role: "user", content: "Summarise in 5 words" }] });
    assert.equal(s.kind, "aux");
  });

  it("classifies Claude Code's own SUGGESTION MODE prompt as aux", () => {
    const s = shape({
      tools: TOOLS,
      messages: [
        { role: "user", content: "real question" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "[SUGGESTION MODE: Suggest what the user might type next.]" },
      ],
    });
    assert.equal(s.kind, "aux", "a prompt Claude Code writes to itself is not a user turn");
  });

  it("reads the session id from the header, falling back to metadata", () => {
    const viaHeader = describeRequest({ messages: [] }, { "x-claude-code-session-id": "abc-123" }, true);
    assert.equal(viaHeader.sessionId, "abc-123");

    const viaMetadata = describeRequest(
      { messages: [], metadata: { user_id: "user_x_account_y_session_dead-beef-0000" } },
      {},
      true,
    );
    assert.equal(viaMetadata.sessionId, "dead-beef-0000");
  });

  it("marks subagent requests with their agent id", () => {
    const s = describeRequest({ tools: TOOLS, messages: [{ role: "user", content: "go" }] }, {
      "x-claude-code-agent-id": "agent-explore-77",
      "x-claude-code-parent-agent-id": "root",
    }, true);
    assert.equal(s.agentId, "agent-explore-77");
    assert.equal(s.parentAgentId, "root");
  });

  it("marks non-Messages endpoints as other", () => {
    assert.equal(describeRequest({ messages: [] }, {}, false).kind, "other");
  });
});

describe("turn detection against a real captured session", () => {
  const captured: Array<{ loggedAs: string; body: AnthropicRequestBody }> = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/real-session.json"), "utf8"),
  );

  it("groups the captured requests into the turns the user actually took", () => {
    const keys = new Map<string, number>();
    const assigned = captured.map((c) => {
      const s = shape(c.body);
      if (s.kind !== "main") return { ...c, turn: "folded", label: s.turnLabel };
      if (!keys.has(s.turnKey)) keys.set(s.turnKey, keys.size + 1);
      return { ...c, turn: keys.get(s.turnKey)!, label: s.turnLabel };
    });

    // The session was: "hello", then "can you summarise readme…" answered with
    // one Bash call. Everything else is Claude Code talking to itself.
    assert.equal(keys.size, 2, "the session contains exactly two user turns");

    const summarise = assigned.filter((a) => a.label.startsWith("can you summarise"));
    const mainOnes = summarise.filter((a) => a.turn !== "folded");
    assert.equal(mainOnes.length, 2, "the summarise turn took two provider requests");
    assert.equal(
      new Set(mainOnes.map((a) => a.turn)).size,
      1,
      "both requests of the summarise turn land in ONE turn (was split into turn-002/turn-003)",
    );

    const hello = assigned.find((a) => a.label === "hello");
    assert.ok(hello, "the 'hello' turn is labelled by what the user typed, not the reminder");

    const suggestion = assigned.find((a) => a.label.startsWith("[SUGGESTION MODE"));
    assert.equal(suggestion?.turn, "folded", "SUGGESTION MODE must not own a turn");
  });
});
