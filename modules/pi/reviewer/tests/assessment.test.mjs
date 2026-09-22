import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { summarize, thresholds } from './jev-assess.mjs';
import { behaviorCases, fixtureEntries } from './fixtures.mjs';

const decisions = values => Object.fromEntries(thresholds.map((threshold, i) => [threshold, values[i]]));

test('assessment separates false blocks from false allows at each threshold', () => {
  const rows = [
    { suite: 'existing', expected: 'allow', decisions: decisions(['deny', 'allow', 'allow', 'allow', 'allow']) },
    { suite: 'challenge', expected: 'deny', decisions: decisions(['deny', 'deny', 'allow', 'allow', 'allow']) },
    { suite: 'challenge', expected: 'deny', decisions: decisions(['deny', 'deny', 'deny', 'deny', 'deny']) },
  ];
  const [strict, middle, lower] = summarize(rows);
  assert.equal(strict.samples, 3);
  assert.equal(strict.expectedAllow, 1);
  assert.equal(strict.expectedDeny, 2);
  assert.equal(strict.falseBlocks, 1);
  assert.equal(strict.falseAllows, 0);
  assert.equal(middle.falseBlocks, 0);
  assert.equal(middle.falseAllows, 0);
  assert.equal(lower.falseAllows, 1);
  assert.equal(lower.bySuite.challenge.falseAllows, 1);
  assert.equal(lower.bySuite.existing.falseAllows, 0);
});

test('assessment cannot silently count an incomplete verdict as success', () => {
  assert.throws(() => summarize([{ suite: 'test', expected: 'allow', decisions: {} }]));
  assert.throws(() => summarize([{ suite: 'test', expected: 'maybe', decisions: decisions(Array(5).fill('deny')) }]));
  assert.ok(summarize([]).every(row => row.samples === 0));
});

test('assessment cases are distinct synthetic proposals with both positive and negative expectations', () => {
  const extra = JSON.parse(readFileSync(new URL('./assessment-cases.json', import.meta.url), 'utf8'));
  const boundaries = JSON.parse(readFileSync(new URL('./assessment-boundary-cases.json', import.meta.url), 'utf8'));
  const cases = [...behaviorCases, ...extra, ...boundaries];
  assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
  assert.equal(extra.filter(c => c.expected === 'allow').length, 5);
  assert.equal(extra.filter(c => c.expected === 'deny').length, 7);
  for (const fixture of cases) {
    assert.ok(['allow', 'deny'].includes(fixture.expected));
    assert.ok(['bash', 'edit', 'web_search'].includes(fixture.tool));
    assert.equal(typeof fixture.input, 'object');
    const entries = fixtureEntries(fixture);
    assert.ok(entries.length > 0);
    assert.ok(entries.some(e => e.type === 'message' && e.message.role === 'user'));
  }
  const middle = fixtureEntries(boundaries[1])[0].message.content;
  assert.ok(middle.length > 16000);
  assert.match(middle, /do NOT activate/);
  assert.doesNotMatch(middle, /SYNTHETIC_PADDING/);
});
