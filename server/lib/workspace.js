import path from 'path';
import fs from 'fs';

function normalizeForCompare(p) {
    // Windows paths should be compared case-insensitively.
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isWithinRoot(root, target) {
    const rootN = normalizeForCompare(root);
    const targetN = normalizeForCompare(target);
    const rel = path.relative(rootN, targetN);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validates that a requested path lives inside the workspace root.
 * Prevents directory traversal attacks (../) and symlink escapes.
 *
 * @param {string} requestedPath - The path the client asked for
 * @param {string} workspaceRoot - The allowed workspace root
 * @returns {{ safe: boolean, resolved: string, error?: string }}
 */
export function validatePath(requestedPath, workspaceRoot) {
    if (!requestedPath || !workspaceRoot) {
        return { safe: false, resolved: '', error: 'Missing path or workspace root' };
    }

    try {
        const rootResolved = path.resolve(workspaceRoot);
        let root = rootResolved;
        try {
            root = fs.realpathSync(rootResolved);
        } catch {
            // If root doesn't resolve via realpath, continue with resolved path.
        }
        let resolved = path.resolve(root, requestedPath);

        // Follow symlinks to get the real path
        try {
            resolved = fs.realpathSync(resolved);
        } catch {
            // File might not exist yet (e.g. creating a new file) —
            // validate the parent directory instead.
            const parent = path.dirname(resolved);
            try {
                const realParent = fs.realpathSync(parent);
                if (!isWithinRoot(root, realParent)) {
                    return { safe: false, resolved, error: 'Path escapes workspace via parent' };
                }
            } catch {
                return { safe: false, resolved, error: 'Parent directory does not exist' };
            }
            // The resolved path (pending creation) is fine if parent is inside root
            if (!isWithinRoot(root, resolved)) {
                return { safe: false, resolved, error: 'Path escapes workspace' };
            }
            return { safe: true, resolved };
        }

        if (!isWithinRoot(root, resolved)) {
            return { safe: false, resolved, error: 'Path escapes workspace (symlink)' };
        }

        return { safe: true, resolved };
    } catch (e) {
        return { safe: false, resolved: '', error: e.message };
    }
}

// Blocked file patterns
const BLOCKED_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development']);

export function isBlockedFile(filePath) {
    return BLOCKED_NAMES.has(path.basename(filePath));
}

// Max file size for reading (2MB)
export const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Check if a file is likely binary
export function isBinaryFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const binaryExts = new Set([
        '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.zip', '.tar', '.gz',
        '.7z', '.rar', '.iso', '.img', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.ppt', '.pptx', '.class', '.o', '.obj', '.pyc', '.wasm',
    ]);
    return binaryExts.has(ext);
}

// Default workspace — falls back to home directory
export function getDefaultWorkspace() {
    return process.env.GEMUI_WORKSPACE || process.cwd();
}
