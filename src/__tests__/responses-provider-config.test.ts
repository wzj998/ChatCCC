import { describe, expect, it } from 'vitest';
import { normalizeCccProviderOverride } from '../config-utils.ts';
import { PAGE_HTML, unflattenConfig } from '../web-ui.ts';

describe('Responses protocol in ChatCCC', () => {
  it('retains an explicit Responses override from the configuration form', () => {
    expect(normalizeCccProviderOverride('OPENAI-RESPONSES')).toBe('openai-responses');
    expect(unflattenConfig({ CHATCCC_CCC_PROVIDER: 'openai-responses' })).toMatchObject({ccc:{provider:'openai-responses'}});
    expect(PAGE_HTML).toContain('<option value="openai-responses">');
  });
});
