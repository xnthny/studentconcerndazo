// Users management routes
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { verifyToken } = require('../middleware/auth');
const PRESENCE_STALE_MS = 45000;

// In-memory presence store shared across active server process.
// Key: users.id (UUID), Value: { status, activeSince, lastSeenAt }
const presenceByUserId = new Map();
let presenceTableAvailable = null;

async function fetchPresenceFromSupabase(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return new Map();
  }

  if (presenceTableAvailable === false) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('user_presence')
    .select('user_id, is_online, active_since, last_seen_at, updated_at')
    .in('user_id', userIds);

  if (error) {
    // Table may not exist yet; keep app working with memory fallback.
    presenceTableAvailable = false;
    console.warn('user_presence table unavailable, using memory presence only:', error.message);
    return new Map();
  }

  presenceTableAvailable = true;
  const map = new Map();
  (data || []).forEach((row) => {
    const updatedAtMs = row.updated_at ? Date.parse(row.updated_at) : 0;
    const stale = row.is_online && (!updatedAtMs || (Date.now() - updatedAtMs > PRESENCE_STALE_MS));
    const effectiveOnline = stale ? false : !!row.is_online;

    map.set(row.user_id, {
      status: effectiveOnline ? 'Active' : 'Inactive',
      activeSince: effectiveOnline ? row.active_since : null,
      lastSeenAt: effectiveOnline ? row.last_seen_at : (row.last_seen_at || row.updated_at || null)
    });
  });
  return map;
}

async function upsertPresenceToSupabase(userId, active) {
  if (presenceTableAvailable === false) {
    return;
  }

  const now = new Date().toISOString();
  const payload = {
    user_id: userId,
    is_online: !!active,
    active_since: active ? now : null,
    last_seen_at: active ? null : now,
    updated_at: now
  };

  const { error } = await supabase
    .from('user_presence')
    .upsert(payload, { onConflict: 'user_id' });

  if (error) {
    presenceTableAvailable = false;
    console.warn('Failed to persist presence in Supabase, using memory fallback:', error.message);
    return;
  }

  presenceTableAvailable = true;
}

async function withPresence(users) {
  const list = users || [];
  const ids = list.map((u) => u.id).filter(Boolean);
  const persistedPresence = await fetchPresenceFromSupabase(ids);

  return list.map((user) => {
    const presence = presenceByUserId.get(user.id) || persistedPresence.get(user.id);
    return {
      ...user,
      status: presence?.status || 'Inactive',
      active_since: presence?.activeSince || null,
      last_seen_at: presence?.lastSeenAt || null
    };
  });
}

// Bootstrap users for frontend startup restore.
// Returns non-sensitive user fields only.
router.get('/bootstrap', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, student_id, course, year_level, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(await withPresence(users));
  } catch (error) {
    console.error('Bootstrap users error:', error);
    res.status(500).json({ error: 'Failed to restore users', message: error.message });
  }
});

// Update current user's online presence (requires auth).
router.post('/presence', verifyToken, async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active(boolean) is required' });
    }

    const now = new Date().toISOString();
    if (active) {
      presenceByUserId.set(req.user.userId, {
        status: 'Active',
        activeSince: now,
        lastSeenAt: null
      });
    } else {
      presenceByUserId.set(req.user.userId, {
        status: 'Inactive',
        activeSince: null,
        lastSeenAt: now
      });
    }

    await upsertPresenceToSupabase(req.user.userId, active);

    const presence = presenceByUserId.get(req.user.userId);
    res.json({ ok: true, presence });
  } catch (error) {
    console.error('Presence update error:', error);
    res.status(500).json({ error: 'Failed to update presence', message: error.message });
  }
});

// Get all users (admin only)
router.get('/', verifyToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, student_id, course, year_level, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(await withPresence(users));
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users', message: error.message });
  }
});

// Get single user
router.get('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, student_id, course, year_level')
      .eq('id', userId)
      .single();

    if (error) throw error;

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user', message: error.message });
  }
});

// Update user
router.patch('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { full_name, email, course, year_level } = req.body;

    // Users can only update their own profile unless they're admin
    if (req.user.userId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({
        full_name,
        email,
        course,
        year_level,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json(updatedUser);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user', message: error.message });
  }
});

// Delete user permanently (admin only)
router.delete('/:userId', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { userId } = req.params;
    const { username, student_id } = req.body || {};

    // Resolve exact target by id/username/student_id.
    const { data: candidates, error: findError } = await supabase
      .from('users')
      .select('id, username, student_id');
    if (findError) throw findError;

    const target = (candidates || []).find((row) => (
      String(row.id || '') === String(userId || '') ||
      String(row.username || '').toLowerCase() === String(userId || '').toLowerCase() ||
      String(row.student_id || '') === String(userId || '') ||
      (username && String(row.username || '').toLowerCase() === String(username).toLowerCase()) ||
      (student_id && String(row.student_id || '') === String(student_id))
    ));
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetId = target.id;

    // Clean presence row first (best effort)
    await supabase.from('user_presence').delete().eq('user_id', targetId);

    const { error: deleteError } = await supabase
      .from('users')
      .delete()
      .eq('id', targetId);

    if (deleteError) throw deleteError;

    presenceByUserId.delete(targetId);

    res.json({ ok: true, deletedUserId: targetId });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user', message: error.message });
  }
});

// Migrate specific staff emails from @school.edu.ph -> @uv.edu.ph
// Only updates users with role IN ('Admin','Registrar','Accounting')
// Protected: admin only
router.post('/migrate-staff-emails', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const mappings = [
    { old: 'admin@school.edu.ph', new: 'admin@uv.edu.ph', role: 'Admin' },
    { old: 'registrar.office@school.edu.ph', new: 'registrar.office@uv.edu.ph', role: 'Registrar' },
    { old: 'accounting.office@school.edu.ph', new: 'accounting.office@uv.edu.ph', role: 'Accounting' }
  ];

  const allowedRoles = ['Admin', 'Registrar', 'Accounting'];
  const oldEmails = mappings.map((m) => m.old);
  const newEmails = mappings.map((m) => m.new);

  let backups = [];

  try {
    // Fetch existing users that match the old emails
    const { data: existing, error: fetchError } = await supabase
      .from('users')
      .select('id, email, role')
      .in('email', oldEmails);

    if (fetchError) throw fetchError;

    const targets = (existing || []).filter((u) => allowedRoles.includes(u.role) && oldEmails.includes(u.email));

    // Ensure all expected mappings are present and correct role
    const missing = mappings.filter((m) => !targets.find((t) => t.email === m.old && t.role === m.role));
    if (missing.length > 0) {
      console.error('Missing target users for migration:', missing);
      return res.status(404).json({ error: 'Missing target users for migration', missing });
    }

    // Check for duplicate/conflicting emails already present in the system
    const { data: conflicts, error: conflictsError } = await supabase
      .from('users')
      .select('id, email, role')
      .in('email', newEmails);

    if (conflictsError) throw conflictsError;

    const targetIds = targets.map((t) => t.id);
    const realConflicts = (conflicts || []).filter((c) => !targetIds.includes(c.id));
    if (realConflicts.length > 0) {
      console.error('Duplicate email conflict detected:', realConflicts);
      return res.status(409).json({ error: 'Duplicate email(s) found in system', conflicts: realConflicts });
    }

    // Perform updates sequentially with application-level rollback support
    for (const m of mappings) {
      const user = targets.find((t) => t.email === m.old && t.role === m.role);
      // Backup previous email for rollback
      backups.push({ id: user.id, oldEmail: user.email });

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({ email: m.new, updated_at: new Date().toISOString() })
        .eq('id', user.id)
        .select()
        .single();

      if (updateError) {
        throw updateError;
      }

      console.log(`Staff email updated for user ${user.id}: ${m.old} -> ${m.new}`);
    }

    return res.json({ ok: true, updated: mappings.map((m) => ({ from: m.old, to: m.new })) });
  } catch (error) {
    console.error('Staff email migration error:', error);

    // Attempt best-effort rollback for any partial updates
    if (backups.length > 0) {
      console.warn('Attempting rollback of partially applied changes...');
      for (const b of backups) {
        try {
          await supabase
            .from('users')
            .update({ email: b.oldEmail, updated_at: new Date().toISOString() })
            .eq('id', b.id);
          console.log(`Rolled back user ${b.id} to ${b.oldEmail}`);
        } catch (rbErr) {
          console.error('Rollback failed for user', b.id, rbErr);
        }
      }
    }

    return res.status(500).json({ error: 'Migration failed', message: error.message });
  }
});

module.exports = router;
