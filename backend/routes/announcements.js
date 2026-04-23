// Announcements routes
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { verifyToken } = require('../middleware/auth');

// Get all announcements
router.get('/', async (req, res) => {
  try {
    const { data: announcements, error } = await supabase
      .from('announcements')
      .select('*')
      .eq('is_draft', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(announcements);
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements', message: error.message });
  }
});

// Create announcement (admin only)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create announcements' });
    }

    const { title, message, audience, isDraft } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    // Insert announcement. Do not assume a `created_by` column exists in the table;
    // keep the insert to the safe, commonly present columns only.
    const insertPayload = {
      title,
      message,
      audience: audience || 'All Users',
      is_draft: isDraft || false,
      created_at: new Date().toISOString()
    };

    const { data: announcement, error } = await supabase
      .from('announcements')
      .insert([insertPayload])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(announcement);
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ error: 'Failed to create announcement', message: error.message });
  }
});

// Delete announcement (admin only)
router.delete('/:announcementId', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete announcements' });
    }

    const { announcementId } = req.params;

    // Ensure the id looks like a UUID before sending to a UUID-typed column.
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(String(announcementId || ''))) {
      return res.status(400).json({ error: 'Invalid announcement id' });
    }

    const { error } = await supabase
      .from('announcements')
      .delete()
      .eq('id', announcementId);

    if (error) throw error;

    res.json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Delete announcement error:', error);
    res.status(500).json({ error: 'Failed to delete announcement', message: error.message });
  }
});

module.exports = router;
