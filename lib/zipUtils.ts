import JSZip from 'jszip';
import { File } from 'expo-file-system/next';

export interface ExtractedFile {
    path: string;
    content: string;
    isBinary: boolean;
}

export interface ProjectAnalysis {
    type: 'built' | 'source' | 'unknown';
    mainHtml: string | null;
    packageJson: Record<string, unknown> | null;
    files: ExtractedFile[];
    totalSize: number;
}

// Text file extensions that should be read as text
const TEXT_EXTENSIONS = new Set([
    '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx',
    '.json', '.md', '.txt', '.svg', '.xml', '.vue', '.svelte',
    '.yaml', '.yml', '.toml', '.env', '.gitignore', '.npmrc',
    '.mjs', '.cjs', '.mts', '.cts', '.d.ts'
]);

// Folders to skip (reduce noise and size)
const SKIP_FOLDERS = new Set([
    'node_modules', '.git', '.next', '.nuxt', '.output',
    '__pycache__', '.cache', '.turbo', '.parcel-cache'
]);

// Binary extensions that should be converted to base64
const BINARY_IMAGE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'
]);

function isTextFile(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
}

function isBinaryImage(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    return BINARY_IMAGE_EXTENSIONS.has(ext);
}

function shouldSkipPath(path: string): boolean {
    const parts = path.split('/');
    return parts.some(part => SKIP_FOLDERS.has(part));
}

/**
 * Extract ZIP file contents from a URI
 */
export async function extractZip(uri: string): Promise<ExtractedFile[]> {
    const file = new File(uri);
    const arrayBuffer = await file.bytes();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const files: ExtractedFile[] = [];
    const entries = Object.entries(zip.files);

    for (const [path, zipEntry] of entries) {
        // Skip directories
        if (zipEntry.dir) continue;

        // Skip excluded folders
        if (shouldSkipPath(path)) continue;

        try {
            if (isTextFile(path)) {
                const content = await zipEntry.async('string');
                files.push({ path, content, isBinary: false });
            } else if (isBinaryImage(path)) {
                // Convert images to base64 data URLs
                const base64 = await zipEntry.async('base64');
                const ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
                const mimeType = ext === 'svg' ? 'image/svg+xml' :
                    ext === 'ico' ? 'image/x-icon' :
                        `image/${ext === 'jpg' ? 'jpeg' : ext}`;
                const dataUrl = `data:${mimeType};base64,${base64}`;
                files.push({ path, content: dataUrl, isBinary: true });
            }
            // Skip other binary files
        } catch (e) {
            console.warn(`Failed to extract ${path}:`, e);
        }
    }

    return files;
}

/**
 * Analyze extracted files to determine project type
 */
export function analyzeProject(files: ExtractedFile[]): ProjectAnalysis {
    let type: 'built' | 'source' | 'unknown' = 'unknown';
    let mainHtml: string | null = null;
    let packageJson: Record<string, unknown> | null = null;
    let totalSize = 0;

    // Calculate total size
    for (const file of files) {
        totalSize += file.content.length;
    }

    // Look for package.json
    const pkgFile = files.find(f =>
        f.path === 'package.json' ||
        f.path.endsWith('/package.json')
    );
    if (pkgFile) {
        try {
            packageJson = JSON.parse(pkgFile.content);
        } catch { /* ignore */ }
    }

    // Check for built project (dist/, build/, out/)
    const buildFolders = ['dist/', 'build/', 'out/', '.next/static/'];
    const isBuilt = files.some(f =>
        buildFolders.some(folder => f.path.startsWith(folder) || f.path.includes(`/${folder}`))
    );

    if (isBuilt) {
        type = 'built';
        // Find main HTML in build folder
        mainHtml = files.find(f =>
            (f.path.includes('dist/') || f.path.includes('build/') || f.path.includes('out/')) &&
            f.path.endsWith('index.html')
        )?.content || null;
    } else if (packageJson) {
        type = 'source';
        // Source project - will need AI conversion
    } else {
        // Check if there's just an index.html at root
        const rootHtml = files.find(f => f.path === 'index.html' || f.path.endsWith('/index.html'));
        if (rootHtml) {
            type = 'built';
            mainHtml = rootHtml.content;
        }
    }

    return { type, mainHtml, packageJson, files, totalSize };
}

/**
 * Bundle built project files into single HTML
 * For projects that already have dist/build folder
 */
export function bundleBuiltProject(analysis: ProjectAnalysis): string {
    if (!analysis.mainHtml) {
        throw new Error('No index.html found in build folder');
    }

    let html = analysis.mainHtml;
    const basePath = analysis.files.find(f => f.path.endsWith('index.html'))?.path.replace('index.html', '') || '';

    // Find and inline CSS files
    const cssFiles = analysis.files.filter(f =>
        f.path.startsWith(basePath) && f.path.endsWith('.css') && !f.isBinary
    );
    for (const css of cssFiles) {
        const relativePath = css.path.replace(basePath, '');
        // Replace link tag with inline style
        const linkPattern = new RegExp(`<link[^>]*href=["']\.?\/?${escapeRegex(relativePath)}["'][^>]*>`, 'gi');
        if (linkPattern.test(html)) {
            html = html.replace(linkPattern, `<style>${css.content}</style>`);
        } else {
            // Append if not found in HTML
            html = html.replace('</head>', `<style>${css.content}</style></head>`);
        }
    }

    // Find and inline JS files
    const jsFiles = analysis.files.filter(f =>
        f.path.startsWith(basePath) && f.path.endsWith('.js') && !f.isBinary
    );
    for (const js of jsFiles) {
        const relativePath = js.path.replace(basePath, '');
        // Replace script tag with inline script
        const scriptPattern = new RegExp(`<script[^>]*src=["']\.?\/?${escapeRegex(relativePath)}["'][^>]*></script>`, 'gi');
        if (scriptPattern.test(html)) {
            html = html.replace(scriptPattern, `<script>${js.content}</script>`);
        }
    }

    // Replace image references with base64 data URLs
    const imageFiles = analysis.files.filter(f => f.isBinary && f.path.startsWith(basePath));
    for (const img of imageFiles) {
        const relativePath = img.path.replace(basePath, '');
        // Replace src/url references
        const imgPattern = new RegExp(`(src|href)=["']\.?\/?${escapeRegex(relativePath)}["']`, 'gi');
        html = html.replace(imgPattern, `$1="${img.content}"`);
        // Also in CSS url()
        const cssUrlPattern = new RegExp(`url\\(["']?\.?\/?${escapeRegex(relativePath)}["']?\\)`, 'gi');
        html = html.replace(cssUrlPattern, `url("${img.content}")`);
    }

    return html;
}

function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prepare source files for AI conversion
 * Returns a condensed representation suitable for the AI prompt
 */
export function prepareSourceForAI(analysis: ProjectAnalysis, maxSize: number = 100000): string {
    const relevantFiles = analysis.files
        .filter(f => !f.isBinary)
        .filter(f => {
            // Prioritize important files
            const name = f.path.split('/').pop() || '';
            return !name.startsWith('.') || name === '.env.example';
        })
        .sort((a, b) => {
            // Prioritize: package.json, index files, then by size
            if (a.path.includes('package.json')) return -1;
            if (b.path.includes('package.json')) return 1;
            if (a.path.includes('index.')) return -1;
            if (b.path.includes('index.')) return 1;
            return a.content.length - b.content.length;
        });

    let result = '';
    let currentSize = 0;

    for (const file of relevantFiles) {
        const entry = `\n=== ${file.path} ===\n${file.content}\n`;
        if (currentSize + entry.length > maxSize) {
            result += `\n... (${relevantFiles.length - relevantFiles.indexOf(file)} more files truncated due to size limit)\n`;
            break;
        }
        result += entry;
        currentSize += entry.length;
    }

    return result;
}
