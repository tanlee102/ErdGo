/** Verifies Gemini client configuration and model-selection boundaries. */
import { describe, expect, it } from 'vitest';
import { buildGeminiGenerationConfig, diffSystemInstruction } from '@/features/editor/components/ChatInput/material';

describe('Gemini generation configuration', () => {
    it.each(['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'])('uses minimal thinking and omits temperature for %s', (model) => {
        expect(buildGeminiGenerationConfig(model)).toEqual({
            systemInstruction: diffSystemInstruction,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
        });
    });

    it('uses low thinking for Gemini 3.8 Flash because minimal is unsupported', () => {
        expect(buildGeminiGenerationConfig('gemini-3.8-flash')).toEqual({
            systemInstruction: diffSystemInstruction,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingLevel: 'LOW' },
        });
    });

    it('uses the lowest supported thinking level for Gemini 3 Pro models', () => {
        expect(buildGeminiGenerationConfig('gemini-3.1-pro-preview').thinkingConfig).toEqual({
            thinkingLevel: 'LOW',
        });
    });

    it.each(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])('keeps thinking disabled for %s', (model) => {
        expect(buildGeminiGenerationConfig(model)).toEqual({
            systemInstruction: diffSystemInstruction,
            temperature: 0.2,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 },
        });
    });

    it('keeps Gemini 2.5 Pro within its supported thinking budget instead of disabling it', () => {
        expect(buildGeminiGenerationConfig('gemini-2.5-pro').thinkingConfig).toEqual({
            thinkingBudget: 128,
        });
    });
});
