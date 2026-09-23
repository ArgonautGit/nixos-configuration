// Display-only behavior: decision lines, grouping, previews and the approval view.
// Registered by reviewer.test.mjs (needs its pi-tui resolver hook). No tools run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview, callTarget, sanitize } from '../lib/preview.ts';
import { ApprovalView, hardWrap } from '../lib/approval.ts';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { describeDecision, decisionLines, registerRenderer } from '../lib/entry.ts';

const theme = { fg: (_color, text) => text, bold: text => text, bg: (_color, text) => text };
const plainView = (preview, rows, raw = '{"raw":true}') => {
  const chosen = [];
  const view = new ApprovalView({ title: 'edit notes.md', details: ['Jev allow 0.79'], preview, raw, theme,
    rows: () => rows, requestRender() {}, done: c => chosen.push(c) });
  return { view, chosen };
};
const jevDecision = (overrides = {}) => ({ toolName: 'bash', toolCallId: 'c1', inputSummary: '{"command":"ls"}', target: 'ls',
  decision: 'allow', confidence: 'high', reason: 'Jev classification: allow', source: 'reviewer', mode: 'deny', timestamp: 0,
  classifier: { choice: 'allow', confidence: 0.99, probabilities: { allow: 0.99, deny: 0.005, uncertain: 0.005 } }, ...overrides });

export function registerDisplayTests({ harness, mockDecisions, classification, jevConfig, user }) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-reviewer-display-'));
  test.after(() => rmSync(temp, { recursive: true, force: true }));

  test('call targets are one sanitized line per tool', () => {
    assert.equal(callTarget('bash', { command: 'rg -n  foo\necho done' }), 'rg -n foo …');
    assert.equal(callTarget('edit', { path: 'a.ts', edits: [{}, {}] }), 'a.ts (2 edits)');
    assert.equal(callTarget('write', { path: 'b.md', content: 'x\ny' }), 'b.md (2 lines)');
    assert.equal(callTarget('web_search', { query: 'NixOS manual' }), 'NixOS manual');
    assert.equal(callTarget('bash', { command: 'printf \u001b[31m' }), 'printf \\u001b[31m');
    assert.ok(callTarget('bash', { command: 'x'.repeat(500) }).length <= 200);
    assert.equal(sanitize('a\tb'), 'a    b');
  });

  test('edit previews show every old/new line with file line numbers and match warnings', () => {
    const file = join(temp, 'notes.md');
    writeFileSync(file, 'one\ntwo\nthree\nfour\ntwo\n');
    const preview = buildPreview('edit', { path: 'notes.md', edits: [
      { oldText: 'three\nfour', newText: 'three\nFOUR\nfive' },
      { oldText: 'missing', newText: 'x' },
      { oldText: 'two', newText: '2' },
    ] }, temp);
    const lines = preview.lines;
    assert.ok(lines.some(l => l.kind === 'heading' && /Edit 1 of 3 · line 3/.test(l.text)));
    assert.deepEqual(lines.filter(l => l.kind === 'context' && l.text === 'three').map(l => l.gutter), ['3']);
    assert.ok(lines.some(l => l.kind === 'remove' && l.text === 'four' && l.gutter === '4'));
    assert.deepEqual(lines.filter(l => l.kind === 'add').map(l => l.text), ['FOUR', 'five', 'x', '2']);
    assert.ok(lines.some(l => l.kind === 'warn' && /not found/.test(l.text)));
    assert.ok(lines.some(l => l.kind === 'warn' && /occurs 2 times/.test(l.text)));
    const missing = buildPreview('edit', { path: 'nope.md', oldText: 'a', newText: 'b' }, temp).lines;
    assert.ok(missing.some(l => l.kind === 'warn' && /Cannot read/.test(l.text)));
    assert.ok(missing.some(l => l.kind === 'remove' && l.text === 'a') && missing.some(l => l.kind === 'add' && l.text === 'b'));
  });

  test('write previews diff against the existing file and collapse only unchanged lines', () => {
    const file = join(temp, 'long.txt');
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(file, old.join('\n'));
    const next = [...old]; next[14] = 'CHANGED';
    const lines = buildPreview('write', { path: 'long.txt', content: next.join('\n') }, temp).lines;
    assert.ok(lines.some(l => l.kind === 'remove' && l.text === 'line 15' && l.gutter === '15'));
    assert.ok(lines.some(l => l.kind === 'add' && l.text === 'CHANGED'));
    assert.deepEqual(lines.filter(l => l.kind === 'gap').map(l => l.text), ['… 11 unchanged lines …', '… 12 unchanged lines …']);
    const created = buildPreview('write', { path: 'new.txt', content: 'a\nb' }, temp).lines;
    assert.match(created[0].text, /new file · 2 lines/);
    assert.deepEqual(created.slice(1).map(l => [l.kind, l.text]), [['add', 'a'], ['add', 'b']]);
    assert.ok(buildPreview('write', { path: 'long.txt', content: old.join('\n') }, temp).lines.some(l => /identical/.test(l.text)));
  });

  test('approval view requires the end of the call on screen before allow; d denies, Esc cancels, r shows raw', () => {
    const preview = { lines: Array.from({ length: 60 }, (_, i) => ({ kind: 'add', text: `line ${i}` })) };
    let { view, chosen } = plainView(preview, 16, '{"raw":true}\n' + 'raw line\n'.repeat(60));
    assert.doesNotMatch(view.render(80).join('\n'), /line 59/);
    view.handleInput('a');
    assert.deepEqual(chosen, []);
    assert.match(view.render(80).join('\n'), /Scroll to the end/);
    view.handleInput('r');
    assert.match(view.render(80).join('\n'), /"raw":true/);
    view.handleInput('r');
    view.handleInput('\x1b[F'); // End
    assert.match(view.render(80).join('\n'), /line 59/);
    view.handleInput('a');
    assert.deepEqual(chosen, ['allow']);
    view.handleInput('d');
    assert.deepEqual(chosen, ['allow'], 'a view settles once');
    ({ view, chosen } = plainView({ lines: [{ kind: 'plain', text: 'short' }] }, 40));
    view.render(80);
    view.handleInput('d');
    assert.deepEqual(chosen, ['deny']);
    ({ view, chosen } = plainView({ lines: [{ kind: 'plain', text: 'short' }] }, 40));
    view.render(80);
    view.handleInput('\x1b');
    assert.deepEqual(chosen, ['cancel']);
    assert.deepEqual(hardWrap('    indented code', 8), ['    inde', 'nted cod', 'e']);
  });

  test('decision lines are compact, name the call, and explain blocks', () => {
    assert.equal(describeDecision(jevDecision()).outcome, 'Jev 0.99');
    const low = jevDecision({ decision: 'deny', confirmation: 'low-confidence-allow', threshold: 0.9,
      classifier: { choice: 'allow', confidence: 0.79, probabilities: { allow: 0.87, deny: 0.1, uncertain: 0.03 } } });
    assert.equal(describeDecision(low).outcome, 'blocked: Jev allow 0.79 < 0.90');
    assert.match(describeDecision({ ...low, threshold: undefined, reason: 'Below the configured confidence threshold 0.9; blocked.' }).outcome, /< 0\.90/);
    assert.match(describeDecision(jevDecision({ decision: 'deny', source: 'incomplete-context', classifier: undefined,
      reason: 'Permission context incomplete: … exceed contextBudget …' })).outcome, /context too large · \/reviewer-restate/);
    assert.equal(describeDecision({ ...low, source: 'user', userDecision: 'deny', outcome: 'cancel' }).outcome, 'approval dismissed · Jev allow 0.79');
    assert.equal(describeDecision({ ...low, stage: 'recommendation' }).outcome, 'awaiting your approval · Jev allow 0.79');
    const [line] = decisionLines(jevDecision({ target: 'rg -n -i "image|paste|clipboard" ' + 'x'.repeat(200) }), 'e1', 80, false, theme);
    assert.ok(visibleWidth(line) <= 80);
    assert.match(stripTerminalSequences(line), /^ ✔ bash {2}rg -n -i "image\|paste\|clipboard" x+…\s+Jev 0\.99$/);
    assert.doesNotMatch(line, /mode: deny|classifier result/);
    const expanded = decisionLines(low, 'e2', 80, true, theme).join('\n');
    assert.match(expanded, /reason: Jev classification/);
    assert.match(expanded, /entry e2/);
    const legacy = decisionLines({ ...jevDecision(), target: undefined, inputSummary: '{"command":"git status"}' }, 'e3', 80, false, theme);
    assert.match(legacy[0], /git status/);
  });

  test('consecutive decisions render as one entry; a recommendation is replaced by its final outcome', () => {
    let render;
    registerRenderer({ registerEntryRenderer: (_type, fn) => { render = fn; } });
    const entry = (id, parentId, data) => ({ type: 'custom', customType: 'reviewer-decision', id, parentId, data });
    const head = render(entry('e1', 'assistant-msg', jevDecision({ toolCallId: 'a', target: 'first' })), { expanded: false }, theme);
    assert.ok(head);
    const pending = jevDecision({ toolCallId: 'b', target: 'second', stage: 'recommendation' });
    assert.equal(render(entry('e2', 'e1', pending), { expanded: false }, theme), undefined);
    assert.match(head.render(100).join('\n'), /second.*awaiting your approval/);
    assert.equal(render(entry('e3', 'e2', { ...pending, stage: undefined, source: 'user', userDecision: 'allow' }), { expanded: false }, theme), undefined);
    const lines = head.render(100);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /first/);
    assert.match(lines[1], /second.*you approved/);
    assert.ok(render(entry('e4', 'tool-result', jevDecision({ toolCallId: 'c' })), { expanded: false }, theme), 'a new run starts a new entry');
  });

  test('ask mode uses the edit diff dialog when custom UI exists; outcomes are specific', async t => {
    mockDecisions(t, classification('allow', 0.7));
    writeFileSync(join(temp, 'config.txt'), 'alpha\nbeta\n');
    for (const [key, expected] of [['a', undefined], ['d', /The user denied this tool call/], ['\x1b', /dismissed the approval dialog/]]) {
      const h = await harness({ config: { ...jevConfig, defaultMode: 'ask' } });
      h.ctx.cwd = temp;
      let rendered = '';
      h.ctx.ui.custom = async factory => {
        let result;
        const view = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, r => { result = r; });
        rendered = view.render(100).join('\n');
        view.handleInput(key);
        return result;
      };
      const result = await h.call({ path: 'config.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] }, 'edit');
      assert.match(rendered, /Approve tool call\? edit config\.txt \(1 edit\)/);
      assert.match(rendered, /Edit 1 of 1 · line 2/);
      assert.match(rendered, /- beta/);
      assert.match(rendered, /\+ gamma/);
      assert.equal(h.editors.length + h.selections.length, 0, 'no JSON editor or select in the TUI path');
      if (expected) assert.match(result.reason, expected);
      else assert.equal(result, undefined);
      const logged = h.sm.getBranch().at(-1).data;
      assert.equal(logged.source, 'user');
      assert.equal(logged.outcome, key === 'a' ? 'allow' : key === 'd' ? 'deny' : 'cancel');
      assert.equal(logged.target, 'config.txt (1 edit)');
    }
  });

  test('allowed calls raise no toast; blocks still do', async t => {
    mockDecisions(t, classification('allow', 0.99));
    const h = await harness({ config: jevConfig });
    h.sm.appendMessage(user('Run a harmless command.'));
    assert.equal(await h.call({ command: 'true' }, 'bash'), undefined);
    assert.equal(h.notices.filter(n => /reviewer/.test(n[0])).length, 0);
    assert.equal(h.sm.getBranch().at(-1).data.target, 'true');
  });
}
