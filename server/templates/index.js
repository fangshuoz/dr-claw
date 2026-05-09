import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Static template files to copy into new Research Lab projects.
 * Each entry maps a source template to its destination path relative to the project root.
 * Templates with `insertSnippets` have {{SNIPPET_NAME}} placeholders replaced at write time.
 */
const TEMPLATES = [
  { src: 'CLAUDE.md', dest: 'CLAUDE.md', insertSnippets: true },
  { src: 'cursor-project.md', dest: path.join('.cursor', 'rules', 'project.md'), insertSnippets: true },
  { src: 'AGENTS.md', dest: 'AGENTS.md', insertSnippets: true },
  { src: 'GEMINI.md', dest: 'GEMINI.md', insertSnippets: true },
];

const snippetCache = new Map();

async function loadSnippet(name) {
  if (snippetCache.has(name)) return snippetCache.get(name);
  const content = await fs.readFile(path.join(__dirname, `_${name}-snippet.md`), 'utf-8');
  snippetCache.set(name, content.trim());
  return content.trim();
}

async function resolveSnippets(templateContent) {
  const pattern = /\{\{([A-Z_]+(?:-[A-Z_]+)*)\}\}/g;
  const matches = [...templateContent.matchAll(pattern)];
  if (matches.length === 0) return templateContent;

  let result = templateContent;
  for (const match of matches) {
    const snippetName = match[1].toLowerCase();
    try {
      const snippet = await loadSnippet(snippetName);
      result = result.replace(match[0], snippet);
    } catch {
      console.warn(`[templates] Snippet {{${match[1]}}} not found, leaving placeholder`);
    }
  }
  return result;
}

/**
 * Write agent instruction template files into a project directory.
 * Copies static .md templates from this directory, resolving {{SNIPPET}} placeholders.
 * Skips any file that already exists so user customizations are preserved.
 * @param {string} projectPath - Absolute path to the project directory.
 */
export async function writeProjectTemplates(projectPath) {
  for (const { src, dest, insertSnippets } of TEMPLATES) {
    const destPath = path.join(projectPath, dest);
    try {
      const exists = await fs.access(destPath).then(() => true).catch(() => false);
      if (exists) continue;

      await fs.mkdir(path.dirname(destPath), { recursive: true });

      if (insertSnippets) {
        const raw = await fs.readFile(path.join(__dirname, src), 'utf-8');
        const resolved = await resolveSnippets(raw);
        await fs.writeFile(destPath, resolved, 'utf-8');
      } else {
        await fs.copyFile(path.join(__dirname, src), destPath);
      }
    } catch (err) {
      console.error(`[templates] Failed to write ${dest}:`, err.message);
    }
  }
}
