import { extractZip, analyzeProject, bundleBuiltProject, prepareSourceForAI, ProjectAnalysis } from './zipUtils';
import * as ai from './api/ai';
import { t } from './i18n';

export interface ConversionResult {
    success: boolean;
    html?: string;
    name?: string;
    error?: string;
}

/**
 * Convert a ZIP project to a standalone HTML webapp
 */
export async function convertProject(zipUri: string): Promise<ConversionResult> {
    try {
        // Step 1: Extract ZIP
        const files = await extractZip(zipUri);

        if (files.length === 0) {
            return { success: false, error: t('zipEmpty') };
        }

        // Step 2: Analyze project
        const analysis = analyzeProject(files);

        // Step 3: Determine project name
        const name = getProjectName(analysis);

        // Step 4: Convert based on type
        let html: string;

        if (analysis.type === 'built' && analysis.mainHtml) {
            // Already built - just bundle files together
            html = bundleBuiltProject(analysis);
        } else if (analysis.type === 'source') {
            // Source code - needs AI conversion
            html = await convertSourceProjectWithAI(analysis);
        } else if (analysis.mainHtml) {
            // Simple HTML project
            html = bundleBuiltProject(analysis);
        } else {
            return {
                success: false,
                error: t('projectTypeUnknown')
            };
        }

        return { success: true, html, name };

    } catch (error) {
        console.error('Project conversion error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('conversionErrorUnknown')
        };
    }
}

/**
 * Get project name from package.json or folder structure
 */
function getProjectName(analysis: ProjectAnalysis): string {
    if (analysis.packageJson && typeof analysis.packageJson.name === 'string') {
        return analysis.packageJson.name;
    }

    // Try to infer from folder structure
    const firstFile = analysis.files[0]?.path;
    if (firstFile) {
        const parts = firstFile.split('/');
        if (parts.length > 1) {
            return parts[0];
        }
    }

    return t('projectImported');
}

/**
 * Use AI to convert source project to standalone HTML
 */
async function convertSourceProjectWithAI(analysis: ProjectAnalysis): Promise<string> {
    // Check size limit (100KB of source code is reasonable for AI)
    if (analysis.totalSize > 200000) {
        throw new Error(t('projectTooLarge'));
    }

    // Prepare source code for AI
    const sourceCode = prepareSourceForAI(analysis);

    // Get framework hint from package.json
    const deps = analysis.packageJson?.dependencies as Record<string, string> | undefined;
    const devDeps = analysis.packageJson?.devDependencies as Record<string, string> | undefined;
    const allDeps = { ...deps, ...devDeps };

    let frameworkHint = 'vanilla JavaScript/TypeScript';
    if (allDeps?.react) frameworkHint = 'React';
    if (allDeps?.vue) frameworkHint = 'Vue';
    if (allDeps?.svelte) frameworkHint = 'Svelte';
    if (allDeps?.angular) frameworkHint = 'Angular';

    // Convert via AI
    const result = await gemini.convertNodeProject(sourceCode, frameworkHint);

    return result.text;
}
