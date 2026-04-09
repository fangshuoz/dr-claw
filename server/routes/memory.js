import express from 'express';
import { memoryDb } from '../database/db.js';
import { syncMemoryFiles } from '../utils/memoryPrompt.js';

const router = express.Router();
const MAX_CONTENT_LENGTH = 500;
const VALID_CATEGORIES = new Set(['general', 'preference', 'context', 'workflow']);

/** Parse and validate :id param as a positive integer. */
function parseId(raw) {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) || id <= 0 ? null : id;
}

// ===============================
// Memory CRUD
// ===============================

// Get all memories for the authenticated user
router.get('/', async (req, res) => {
  try {
    const memories = memoryDb.getAll(req.user.id);
    res.json({ memories });
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

// Create a new memory
router.post('/', async (req, res) => {
  try {
    const { content, category } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Memory content is required' });
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: `Memory content must be ${MAX_CONTENT_LENGTH} characters or less` });
    }
    const cat = VALID_CATEGORIES.has(category) ? category : 'general';
    const memory = memoryDb.create(req.user.id, content.trim(), cat);
    syncMemoryFiles(req.user.id).catch(err => console.warn('[memory] sync error:', err.message));
    res.status(201).json({ memory });
  } catch (error) {
    if (error.message?.includes('Maximum of')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error creating memory:', error);
    res.status(500).json({ error: 'Failed to create memory' });
  }
});

// Update a memory
router.put('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid memory ID' });

    const { content, category } = req.body;
    if (content !== undefined && content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: `Memory content must be ${MAX_CONTENT_LENGTH} characters or less` });
    }
    const updates = {};
    if (content !== undefined) updates.content = content.trim();
    if (category !== undefined) updates.category = VALID_CATEGORIES.has(category) ? category : 'general';

    const memory = memoryDb.update(req.user.id, id, updates);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    syncMemoryFiles(req.user.id).catch(err => console.warn('[memory] sync error:', err.message));
    res.json({ memory });
  } catch (error) {
    console.error('Error updating memory:', error);
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

// Toggle memory enabled/disabled
router.patch('/:id/toggle', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid memory ID' });

    const memory = memoryDb.toggle(req.user.id, id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    syncMemoryFiles(req.user.id).catch(err => console.warn('[memory] sync error:', err.message));
    res.json({ memory });
  } catch (error) {
    console.error('Error toggling memory:', error);
    res.status(500).json({ error: 'Failed to toggle memory' });
  }
});

// Delete a memory
router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid memory ID' });

    const deleted = memoryDb.delete(req.user.id, id);
    if (!deleted) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    syncMemoryFiles(req.user.id).catch(err => console.warn('[memory] sync error:', err.message));
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting memory:', error);
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// ===============================
// Per-User Memory Settings
// ===============================

// Get memory enabled state for the authenticated user
router.get('/settings', async (req, res) => {
  try {
    const enabled = memoryDb.getMemoryEnabled(req.user.id);
    res.json({ enabled });
  } catch (error) {
    console.error('Error fetching memory settings:', error);
    res.status(500).json({ error: 'Failed to fetch memory settings' });
  }
});

// Set memory enabled state for the authenticated user
router.patch('/settings', async (req, res) => {
  try {
    const { enabled } = req.body;
    memoryDb.setMemoryEnabled(req.user.id, !!enabled);
    syncMemoryFiles(req.user.id).catch(err => console.warn('[memory] sync error:', err.message));
    res.json({ enabled: !!enabled });
  } catch (error) {
    console.error('Error updating memory settings:', error);
    res.status(500).json({ error: 'Failed to update memory settings' });
  }
});

export default router;
