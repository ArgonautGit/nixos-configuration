// Shared by mocked pipeline checks and the opt-in live classifier evaluation.
// All data is synthetic; constructing entries never executes proposed tools.
import { readFileSync } from 'node:fs';

export const behaviorCases = JSON.parse(readFileSync(new URL('./behavior-cases.json', import.meta.url), 'utf8'));

export function fixtureEntries(fixture) {
  return fixture.messages.flatMap(([role, content], index) => {
    if (role === 'user' && fixture.paddingRepeats) {
      content = content.replaceAll('[SYNTHETIC_PADDING]',
        'Historical diagnostic note with no additional permissions or restrictions. '.repeat(fixture.paddingRepeats));
    }
    const noise = Array.from({ length: index === 0 ? 0 : fixture.assistantNoiseBetweenMessages ?? 0 }, () => ({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Historical build output and unrelated implementation notes. '.repeat(80) }] },
    }));
    const entry = role === 'reviewerDecision'
      ? { type: 'custom', customType: 'reviewer-decision', data: content }
      : { type: 'message', message: { role,
        // Real Pi assistant messages contain content blocks, not plain strings.
        content: role === 'assistant' ? [{ type: 'text', text: content }] : content,
      } };
    return [...noise, entry];
  });
}
