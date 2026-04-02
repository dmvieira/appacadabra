/**
 * Unit tests for prompts.ts
 */

import { validateContentRequest, SYSTEM_PREAMBLE, UNIFIED_CREATE_PLANNER_PROMPT, UNIFIED_EDIT_PLANNER_PROMPT, CONVERT_PROJECT_PROMPT } from '../prompts';
import { buildSystemInstructions, ALL_CAPABILITIES } from '../capabilities/index';

/** Full system instructions for a current app version — includes all capability docs. */
const FULL_INSTRUCTIONS = buildSystemInstructions('1.0.0', ALL_CAPABILITIES);

describe('prompts', () => {
    describe('SYSTEM_PREAMBLE', () => {
        it('should contain Appacadabra API documentation', () => {
            expect(FULL_INSTRUCTIONS).toContain('Appacadabra');
        });

        it('should document the callback pattern', () => {
            expect(SYSTEM_PREAMBLE).toContain('CALLBACK PATTERN');
            expect(SYSTEM_PREAMBLE).toContain('global function');
        });

        it('should document localStorage for persistence', () => {
            expect(SYSTEM_PREAMBLE).toContain('localStorage');
        });

        it('should document AI API', () => {
            expect(FULL_INSTRUCTIONS).toContain('AppacadabraAI');
        });

        it('should document notification API', () => {
            expect(FULL_INSTRUCTIONS).toContain('AppacadabraNotify');
        });
    });

    describe('UNIFIED_CREATE_PLANNER_PROMPT', () => {
        it('should exist and contain planning instructions', () => {
            expect(UNIFIED_CREATE_PLANNER_PROMPT).toBeDefined();
            expect(UNIFIED_CREATE_PLANNER_PROMPT.length).toBeGreaterThan(100);
        });

        it('should mention JSON schema output', () => {
            expect(UNIFIED_CREATE_PLANNER_PROMPT).toContain('JSON');
        });

        it('should mention language matching', () => {
            expect(UNIFIED_CREATE_PLANNER_PROMPT).toContain('SAME LANGUAGE');
        });
    });

    describe('UNIFIED_EDIT_PLANNER_PROMPT', () => {
        it('should exist and contain edit planning instructions', () => {
            expect(UNIFIED_EDIT_PLANNER_PROMPT).toBeDefined();
            expect(UNIFIED_EDIT_PLANNER_PROMPT.length).toBeGreaterThan(100);
        });

        it('should mention patches schema', () => {
            expect(UNIFIED_EDIT_PLANNER_PROMPT).toContain('patches');
            expect(UNIFIED_EDIT_PLANNER_PROMPT).toContain('description');
            expect(UNIFIED_EDIT_PLANNER_PROMPT).toContain('targetSection');
        });
    });

    describe('CONVERT_PROJECT_PROMPT', () => {
        it('should exist and contain conversion instructions', () => {
            expect(CONVERT_PROJECT_PROMPT).toBeDefined();
            expect(CONVERT_PROJECT_PROMPT.length).toBeGreaterThan(50);
        });

        it('should mention standalone HTML', () => {
            expect(CONVERT_PROJECT_PROMPT).toContain('HTML');
        });
    });

    describe('validateContentRequest', () => {
        it('should allow normal requests', () => {
            const result = validateContentRequest('Create a todo app');
            expect(result.allowed).toBe(true);
        });

        it('should allow requests with technical terms', () => {
            const result = validateContentRequest('Create a weather app with API integration');
            expect(result.allowed).toBe(true);
        });

        it('should allow requests in Portuguese', () => {
            const result = validateContentRequest('Crie um app de lista de compras');
            expect(result.allowed).toBe(true);
        });

        it('should allow requests in Spanish', () => {
            const result = validateContentRequest('Crear una aplicación de notas');
            expect(result.allowed).toBe(true);
        });

        // Note: Content validation is currently disabled as per user request
        // These tests verify the function exists and returns expected structure
        it('should return object with allowed property', () => {
            const result = validateContentRequest('Any text');
            expect(result).toHaveProperty('allowed');
            expect(typeof result.allowed).toBe('boolean');
        });
    });
});
