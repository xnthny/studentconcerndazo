// Announcements routes
const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const { verifyToken } = require('../middleware/auth');

// Get all announcements (include per-user read flag when authenticated)
const jwt = require('jsonwebtoken');
router.get('/', async (req, res) => {
  try {
    // Fetch announcements
    const { data: announcements, error } = await supabase
      .from('announcements')
      .select('*')
      .eq('is_draft', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // If an Authorization token is present, try to decode it and attach per-user read flags
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded && (decoded.userId || decoded.user_id || decoded.sub);
        if (userId) {
          // Use the service-role (admin) client for announcement_reads so RLS doesn't block
          if (!supabaseAdmin) {
            // If admin client is not configured, skip per-user annotation silently (don't crash the public GET)
            console.warn('supabaseAdmin not configured; skipping announcement_reads annotation');
          } else {
            const { data: reads, error: readErr } = await supabaseAdmin
              .from('announcement_reads')
              .select('announcement_id')
              .eq('user_id', userId);
            if (readErr) throw readErr;
            const readSet = new Set((reads || []).map((r) => String(r.announcement_id)));
            const annotated = (announcements || []).map((a) => ({ ...a, is_read: readSet.has(String(a.id)) }));
            return res.json(annotated);
          }
          if (readErr) throw readErr;
          const readSet = new Set((reads || []).map((r) => String(r.announcement_id)));
          const annotated = (announcements || []).map((a) => ({ ...a, is_read: readSet.has(String(a.id)) }));
          return res.json(annotated);
        }
      } catch (e) {
        // ignore token errors and return public announcements
      }
    }

    res.json(announcements);
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements', message: error.message });
  }
});

// Mark an announcement as read for the authenticated user
router.post('/:announcementId/read', verifyToken, async (req, res) => {
  try {
    const { announcementId } = req.params;
    const userId = req.user && (req.user.userId || req.user.user_id || req.user.sub);

    if (!userId) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    // Validate announcement id looks like a UUID
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(String(announcementId || ''))) {
      return res.status(400).json({ error: 'Invalid announcement id' });
    }

    const payload = {
      announcement_id: announcementId,
      user_id: userId,
      read_at: new Date().toISOString()
    };

    // Require the service-role (admin) client to perform the upsert because RLS will block anon clients
    if (!supabaseAdmin) {
      console.error('SUPABASE_SERVICE_ROLE_KEY not configured; cannot upsert announcement_reads');
      return res.status(500).json({ error: 'Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY not set' });
    }

    const { data, error } = await supabaseAdmin
      .from('announcement_reads')
      .upsert([payload], { onConflict: ['announcement_id', 'user_id'] })
      .select();

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error('Mark announcement read error:', error);
    res.status(500).json({ error: 'Failed to mark announcement read', message: error.message });
  }
});

// Create announcement (admin only)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create announcements' });
    }

    // Accept either `body` (preferred) or legacy `message` from callers.
    const { title, body, audience, isDraft } = req.body;
    const resolvedBody = (typeof body === 'string' && body.trim()) ? body.trim() : (typeof req.body.message === 'string' ? String(req.body.message).trim() : '');

    if (!title || !resolvedBody) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    // Use the authenticated user's id as author_id when available
    const authorId = (req.user && req.user.userId) ? req.user.userId : null;

    const insertPayload = {
      title: String(title).trim(),
      body: resolvedBody,
      audience: audience || 'All Users',
      is_draft: Boolean(isDraft),
      author_id: authorId,
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
