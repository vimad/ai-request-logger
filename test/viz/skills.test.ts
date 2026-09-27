import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeViz, reminderChunks } from "../../src/viz/claude.ts";
import { codexViz } from "../../src/viz/codex.ts";
import { BlobStore, bulletSkills } from "../../src/viz/model.ts";

const reminder = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`;
const SKILLS = reminder([
  "The following skills are available for use with the Skill tool:",
  "",
  "- find-skills",
  "- dataviz: Use this skill for any chart.",
  "TRIGGER when a plot is asked for.",
  "- anthropic-skills:pdf: Read and write PDFs.",
].join("\n"));

describe("viz: skills lists and the reminders they hide in", () => {
  it("parses a bullet list, wrapped descriptions, plugin names and file locations", () => {
    const skills = bulletSkills("- a\n- b: two words\nand more\n- p:q: plugin one (file: /x/q/SKILL.md)\n");
    assert.deepEqual(skills.map((s) => [s.name, s.description, s.path]), [
      ["a", "", undefined],
      ["b", "two words\nand more", undefined],
      ["p:q", "plugin one", "/x/q/SKILL.md"],
    ]);
  });

  it("cuts a block of packed reminders into one piece each, losing nothing", () => {
    const text = `${reminder("# Environment\ncwd: /repo")}\n\n${SKILLS}\n\n${reminder("## Auto Mode Active")}`;
    const chunks = reminderChunks(text);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(""), text);
    // Your words after a reminder are their own piece.
    assert.deepEqual(reminderChunks(`${reminder("x")}\nfix it`), [reminder("x"), "\nfix it"]);
    assert.deepEqual(reminderChunks("just a prompt"), ["just a prompt"]);
  });

  it("gives Claude Code's skills list its own labelled block", () => {
    const store = new BlobStore();
    const text = `${reminder("# Environment\ncwd: /repo")}\n\n${SKILLS}`;
    const req = { shape: { kind: "main" }, body: { messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }] } };
    const parts = claudeViz.request(store, req, { body: {} }, "/nowhere");
    const refs = parts.messages[1]!.refs;
    const blobs = refs.map((r) => store.blobs[r.b]!);
    assert.deepEqual(blobs.map((b) => b.label), ["Environment", "Skills · 3 available to the Skill tool"]);
    assert.deepEqual(blobs[1]!.skills!.map((s) => s.name), ["find-skills", "dataviz", "anthropic-skills:pdf"]);
    assert.deepEqual(refs.map((r) => r.cache), [undefined, true], "the breakpoint stays on the last piece");
  });

  it("reads Codex's <skills_instructions>, with each SKILL.md path", () => {
    const store = new BlobStore();
    const text = "<skills_instructions>\n## Skills\nHow to use them.\n### Available skills\n- imagegen: Make images. (file: /h/.codex/skills/imagegen/SKILL.md)\n### How to use skills\n- Discovery: not a skill\n</skills_instructions>";
    const req = { shape: { kind: "main" }, body: { input: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }] } };
    const parts = codexViz.request(store, req, { body: {} }, "/nowhere");
    const blob = store.blobs[parts.system[0]!.b]!;
    assert.deepEqual(blob.skills, [{ name: "imagegen", description: "Make images.", path: "/h/.codex/skills/imagegen/SKILL.md", chars: 67 }]);
  });
});
