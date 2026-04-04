/**
 * Unit tests for zipUtils.ts
 */

import { analyzeProject, prepareSourceForAI, bundleBuiltProject, ExtractedFile, ProjectAnalysis } from '../zipUtils';

// Mock the i18n module
jest.mock('../i18n', () => ({
    t: (key: string) => key
}));

// Mock expo-file-system/next
jest.mock('expo-file-system/next', () => ({
    File: jest.fn()
}));

describe('zipUtils', () => {
    describe('analyzeProject', () => {
        it('should identify a built project with index.html', () => {
            const files: ExtractedFile[] = [
                { path: 'index.html', content: '<html><head></head><body></body></html>', isBinary: false },
                { path: 'main.js', content: 'console.log("app");', isBinary: false },
                { path: 'style.css', content: 'body { margin: 0; }', isBinary: false }
            ];

            const analysis = analyzeProject(files);

            expect(analysis.type).toBe('built');
            expect(analysis.mainHtml).toBe('<html><head></head><body></body></html>');
            expect(analysis.packageJson).toBeNull();
        });

        it('should identify a source project with package.json', () => {
            const files: ExtractedFile[] = [
                { path: 'package.json', content: '{"name": "test-app", "version": "1.0.0", "dependencies": {"react": "^18.0.0"}}', isBinary: false },
                { path: 'src/index.tsx', content: 'import React from "react";', isBinary: false },
                { path: 'src/App.tsx', content: 'export default function App() {}', isBinary: false }
            ];

            const analysis = analyzeProject(files);

            expect(analysis.type).toBe('source');
            expect(analysis.packageJson).not.toBeNull();
            expect(analysis.packageJson?.name).toBe('test-app');
        });

        it('should calculate total size correctly', () => {
            const files: ExtractedFile[] = [
                { path: 'file1.txt', content: '12345', isBinary: false }, // 5 bytes
                { path: 'file2.txt', content: '1234567890', isBinary: false } // 10 bytes
            ];

            const analysis = analyzeProject(files);

            expect(analysis.totalSize).toBe(15);
        });

        it('should identify built project from dist folder', () => {
            const files: ExtractedFile[] = [
                { path: 'dist/index.html', content: '<html><body>Built</body></html>', isBinary: false },
                { path: 'dist/main.js', content: 'console.log("built");', isBinary: false }
            ];

            const analysis = analyzeProject(files);

            expect(analysis.type).toBe('built');
            expect(analysis.mainHtml).toContain('Built');
        });

        it('should return unknown type for unrecognized projects', () => {
            const files: ExtractedFile[] = [
                { path: 'readme.md', content: '# Project', isBinary: false },
                { path: 'data.json', content: '{"key": "value"}', isBinary: false }
            ];

            const analysis = analyzeProject(files);

            expect(analysis.type).toBe('unknown');
        });
    });

    describe('prepareSourceForAI', () => {
        it('should format files for AI prompt', () => {
            const analysis: ProjectAnalysis = {
                type: 'source',
                mainHtml: null,
                packageJson: { name: 'test-app' },
                files: [
                    { path: 'src/App.tsx', content: 'export default function App() { return <div>Hello</div>; }', isBinary: false }
                ],
                totalSize: 100
            };

            const result = prepareSourceForAI(analysis);

            expect(result).toContain('src/App.tsx');
            expect(result).toContain('export default function App');
        });

        it('should prioritize package.json', () => {
            const analysis: ProjectAnalysis = {
                type: 'source',
                mainHtml: null,
                packageJson: { name: 'test-app' },
                files: [
                    { path: 'src/App.tsx', content: 'export default function App() {}', isBinary: false },
                    { path: 'package.json', content: '{"name": "test"}', isBinary: false }
                ],
                totalSize: 100
            };

            const result = prepareSourceForAI(analysis);

            // package.json should appear first
            const pkgIndex = result.indexOf('package.json');
            const appIndex = result.indexOf('App.tsx');
            expect(pkgIndex).toBeLessThan(appIndex);
        });

        it('should respect max size limit', () => {
            const longContent = 'x'.repeat(50000);
            const analysis: ProjectAnalysis = {
                type: 'source',
                mainHtml: null,
                packageJson: null,
                files: [
                    { path: 'large.ts', content: longContent, isBinary: false }
                ],
                totalSize: 50000
            };

            const result = prepareSourceForAI(analysis, 1000);

            expect(result.length).toBeLessThan(10000); // Should be limited
        });

        it('should skip binary files', () => {
            const analysis: ProjectAnalysis = {
                type: 'source',
                mainHtml: null,
                packageJson: null,
                files: [
                    { path: 'src/App.tsx', content: 'export default function App() {}', isBinary: false },
                    { path: 'image.png', content: 'base64data', isBinary: true }
                ],
                totalSize: 100
            };

            const result = prepareSourceForAI(analysis);

            expect(result).not.toContain('image.png');
        });
    });

    describe('bundleBuiltProject', () => {
        it('should throw when mainHtml is null', () => {
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: null,
                packageJson: null,
                files: [],
                totalSize: 0,
            };
            expect(() => bundleBuiltProject(analysis)).toThrow();
        });

        it('should return mainHtml unchanged when no linked assets', () => {
            const html = '<html><head></head><body><p>hello</p></body></html>';
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: html,
                packageJson: null,
                files: [{ path: 'index.html', content: html, isBinary: false }],
                totalSize: html.length,
            };
            expect(bundleBuiltProject(analysis)).toBe(html);
        });

        it('should inline CSS referenced by <link> tag', () => {
            const cssContent = 'body { color: red; }';
            const html = '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>';
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: html,
                packageJson: null,
                files: [
                    { path: 'index.html', content: html, isBinary: false },
                    { path: 'style.css', content: cssContent, isBinary: false },
                ],
                totalSize: html.length + cssContent.length,
            };
            const result = bundleBuiltProject(analysis);
            expect(result).toContain(`<style>${cssContent}</style>`);
            expect(result).not.toContain('<link');
        });

        it('should append CSS to <head> when link tag is not found in HTML', () => {
            const cssContent = 'p { margin: 0; }';
            const html = '<html><head></head><body></body></html>';
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: html,
                packageJson: null,
                files: [
                    { path: 'index.html', content: html, isBinary: false },
                    { path: 'extra.css', content: cssContent, isBinary: false },
                ],
                totalSize: html.length + cssContent.length,
            };
            const result = bundleBuiltProject(analysis);
            expect(result).toContain(`<style>${cssContent}</style></head>`);
        });

        it('should inline JS referenced by <script src>', () => {
            const jsContent = 'console.log("hello");';
            const html = '<html><head></head><body><script src="app.js"></script></body></html>';
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: html,
                packageJson: null,
                files: [
                    { path: 'index.html', content: html, isBinary: false },
                    { path: 'app.js', content: jsContent, isBinary: false },
                ],
                totalSize: html.length + jsContent.length,
            };
            const result = bundleBuiltProject(analysis);
            expect(result).toContain(`<script>${jsContent}</script>`);
            expect(result).not.toContain('src="app.js"');
        });

        it('should replace image src with base64 data URL', () => {
            const imgData = 'data:image/png;base64,abc123';
            const html = '<html><body><img src="logo.png"></body></html>';
            const analysis: ProjectAnalysis = {
                type: 'built',
                mainHtml: html,
                packageJson: null,
                files: [
                    { path: 'index.html', content: html, isBinary: false },
                    { path: 'logo.png', content: imgData, isBinary: true },
                ],
                totalSize: html.length,
            };
            const result = bundleBuiltProject(analysis);
            expect(result).toContain(`src="${imgData}"`);
            expect(result).not.toContain('src="logo.png"');
        });
    });
});
