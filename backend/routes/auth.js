// Authentication routes
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { supabase, supabaseAdmin, supabaseServiceKey, supabaseUrl } = require('../config/supabase');
const { generateToken } = require('../middleware/auth');

// In-memory OTP attempt logs (ephemeral; useful for quick diagnostics)
const otpLogs = [];

// Helper: send OTP using Supabase Auth REST endpoint (/auth/v1/otp)
async function sendOtpViaRest(email) {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase URL or service key not configured');
  }

  const url = supabaseUrl.replace(/\/$/, '') + '/auth/v1/otp';
  // Prefer global fetch (Node 18+). If not available, attempt to require 'node-fetch' dynamically.
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    try {
      // eslint-disable-next-line global-require
      const nodeFetch = require('node-fetch');
      fetchFn = nodeFetch;
    } catch (e) {
      fetchFn = null;
    }
  }

  if (!fetchFn) {
    throw new Error('No fetch available to call Supabase Auth REST endpoint');
  }

  // Debug: log request payload (do NOT log service keys)
  try { console.log('[OTP REST SEND] POST', url, { email }); } catch (e) {}

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`
    },
    body: JSON.stringify({ email })
  });

  // Read response as text then try to parse to preserve raw body for logging
  let data = null;
  let rawText = null;
  try {
    rawText = await res.text();
    try { data = rawText ? JSON.parse(rawText) : null; } catch (e) { data = rawText; }
  } catch (e) {
    console.warn('[OTP REST SEND] Failed to read response body:', e.message);
  }

  try { console.log('[OTP REST SEND] RESPONSE', res.status, res.statusText, data); } catch (e) {}

  if (!res.ok) {
    const msg = (data && (data.error_description || data.error || data.message)) || `OTP send failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

// Helper: verify OTP using Supabase Auth REST token endpoint (/auth/v1/token)
async function verifyOtpViaRest(email, otp) {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase URL or service key not configured');
  }

  const url = supabaseUrl.replace(/\/$/, '') + '/auth/v1/token';
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    try {
      // eslint-disable-next-line global-require
      const nodeFetch = require('node-fetch');
      fetchFn = nodeFetch;
    } catch (e) {
      fetchFn = null;
    }
  }
  if (!fetchFn) {
    throw new Error('No fetch available to call Supabase Auth REST endpoint');
  }

  const body = {
    grant_type: 'otp',
    email,
    otp
  };

  // Supabase token endpoint expects form-encoded body for grant exchanges.
  const formBody = `grant_type=otp&email=${encodeURIComponent(email)}&otp=${encodeURIComponent(otp)}`;

  // Mask OTP for logs (avoid printing full code in logs)
  const maskedOtp = otp ? (otp.length > 2 ? '***' + otp.slice(-2) : '***') : '';
  try { console.log('[OTP REST VERIFY] POST', url, { grant_type: 'otp', email, otp: maskedOtp }); } catch (e) {}

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`
    },
    body: formBody
  });

  let data = null;
  let rawText = null;
  try {
    rawText = await res.text();
    try { data = rawText ? JSON.parse(rawText) : null; } catch (e) { data = rawText; }
  } catch (e) {
    console.warn('[OTP REST VERIFY] Failed to read response body:', e.message);
  }

  try { console.log('[OTP REST VERIFY] RESPONSE', res.status, res.statusText, data); } catch (e) {}

  if (!res.ok) {
    let msg = null;
    if (data && typeof data === 'object') {
      msg = data.error_description || data.error || data.message || null;
    } else if (data && typeof data === 'string') {
      msg = data;
    }
    if (!msg) msg = `OTP verify failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required', message: 'Username and password are required' });
    }

    // Query Supabase for user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user.id, user.role);

    // Mark user active at login time (best effort).
    try {
      const now = new Date().toISOString();
      await supabase.from('user_presence').upsert(
        {
          user_id: user.id,
          is_online: true,
          active_since: now,
          last_seen_at: null,
          updated_at: now
        },
        { onConflict: 'user_id' }
      );
    } catch (presenceError) {
      // Presence table may not exist yet; login should still succeed.
      console.warn('Login presence upsert skipped:', presenceError.message);
    }

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        name: user.full_name,
        role: user.role,
        email: user.email,
        student_id: user.student_id,
        course: user.course,
        year_level: user.year_level
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', message: error.message });
  }
});

// Register endpoint
router.post('/register', async (req, res) => {
  try {
    const { username, password, full_name, email, course, year_level, student_id, role = 'student' } = req.body;

    if (!username || !password || !full_name || !email || !student_id) {
      return res.status(400).json({ error: 'Missing required fields', message: 'Missing required fields' });
    }

    // Enforce @uv.edu.ph email domain for students
    const lowerEmail = String(email).toLowerCase();
    if (!lowerEmail.endsWith('@uv.edu.ph')) {
      return res.status(400).json({ error: 'Student registration requires @uv.edu.ph email address', message: 'Student registration requires @uv.edu.ph email address' });
    }

    // For safety require OTP-verified flow for students
    if (String(role).toLowerCase() === 'student') {
      return res.status(400).json({ error: 'Student registration must be completed via the OTP verification endpoint (/auth/otp/verify)', message: 'Student registration must be completed via the OTP verification endpoint (/auth/otp/verify)' });
    }

    const lowerUsername = username.toLowerCase();

    // Check for duplicate username
    const { data: existingByUsername, error: usernameLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('username', lowerUsername)
      .single();

    if (!usernameLookupError && existingByUsername) {
      return res.status(400).json({
        error: 'Username already registered',
        field: 'username'
      });
    }

    // Check for duplicate student_id
    const { data: existingByStudentId, error: studentIdLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('student_id', student_id)
      .single();

    if (!studentIdLookupError && existingByStudentId) {
      return res.status(400).json({
        error: 'Student ID already registered',
        field: 'student_id'
      });
    }

    // Check for duplicate email
    const { data: existingByEmail, error: emailLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('email', lowerEmail)
      .single();

    if (!emailLookupError && existingByEmail) {
      return res.status(400).json({
        error: 'Email already registered',
        field: 'email'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        username: lowerUsername,
        password_hash: hashedPassword,
        full_name,
        email: lowerEmail,
        role,
        student_id,
        course,
        year_level,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError || !newUser) {
      console.error('User insert error:', insertError);
      return res.status(400).json({ error: 'Registration failed', message: insertError?.message || 'Could not create user' });
    }

    // Initialize presence record (best effort)
    try {
      const now = new Date().toISOString();
      await supabase.from('user_presence').insert([{
        user_id: newUser.id,
        is_online: false,
        active_since: null,
        last_seen_at: now,
        updated_at: now
      }]);
    } catch (presenceError) {
      console.warn('Presence initialization failed, continuing:', presenceError.message);
      // Don't fail registration if presence fails
    }

    // Generate token
    const token = generateToken(newUser.id, newUser.role);

    res.status(201).json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        full_name: newUser.full_name,
        name: newUser.full_name,
        role: newUser.role,
        email: newUser.email,
        student_id: newUser.student_id,
        course: newUser.course,
        year_level: newUser.year_level
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed', message: error.message });
  }
});

// Send OTP to university email (server-side) using Supabase admin key
router.post('/otp/send', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required', message: 'Email is required' });

    const lowerEmail = String(email).toLowerCase();
    if (!lowerEmail.endsWith('@uv.edu.ph')) {
      return res.status(400).json({ error: 'OTP can only be sent to @uv.edu.ph addresses', message: 'OTP can only be sent to @uv.edu.ph addresses' });
    }

    // Check email not already registered
    const { data: existingByEmail, error: emailLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('email', lowerEmail)
      .single();

    if (!emailLookupError && existingByEmail) {
      return res.status(400).json({ error: 'Email already registered', message: 'Email already registered', field: 'email' });
    }

    if (!supabaseServiceKey) {
      return res.status(500).json({ error: 'OTP service not configured on server' });
    }

    // Record attempt
    const sendAttempt = {
      time: new Date().toISOString(),
      action: 'send',
      email: lowerEmail,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
      status: 'started'
    };
    otpLogs.push(sendAttempt);
    while (otpLogs.length > 200) otpLogs.shift();

    // Use Supabase Auth REST endpoint to request a numeric email OTP.
    try {
      const restResp = await sendOtpViaRest(lowerEmail);
      sendAttempt.status = 'sent_rest';
      sendAttempt.result = { rest: restResp };
      console.log('OTP send (REST) succeeded for', lowerEmail);
      return res.json({ ok: true, data: restResp });
    } catch (restErr) {
      sendAttempt.status = 'failed_rest';
      sendAttempt.result = { restError: restErr.message, restBody: restErr.body || null };
      console.error('OTP send (REST) failed:', restErr.message);
      return res.status(500).json({ error: 'Failed to send OTP', message: restErr.message, details: sendAttempt.result });
    }
  } catch (error) {
    console.error('OTP send error:', error);
    res.status(500).json({ error: 'Failed to send OTP', message: error.message });
  }
});

// Verify OTP (server-side) and finalize registration
router.post('/otp/verify', async (req, res) => {
  try {
    const { email, token } = req.body || {};
    const pending = req.body?.pending || req.body; // allow sending registration fields at top-level

    if (!email || !token) return res.status(400).json({ error: 'Email and token are required', message: 'Email and token are required' });

    // Trim inputs to avoid whitespace/case issues
    const lowerEmail = String(email || '').trim().toLowerCase();
    const trimmedToken = String(token || '').trim();
    if (!lowerEmail.endsWith('@uv.edu.ph')) {
      return res.status(400).json({ error: 'OTP verification must use @uv.edu.ph email', message: 'OTP verification must use @uv.edu.ph email' });
    }

    // Record verify attempt
    const verifyAttempt = {
      time: new Date().toISOString(),
      action: 'verify',
      email: lowerEmail,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
      status: 'started'
    };
    otpLogs.push(verifyAttempt);
    while (otpLogs.length > 200) otpLogs.shift();

    if (!supabaseServiceKey) {
      verifyAttempt.status = 'no_service_key';
      return res.status(500).json({ error: 'OTP service not configured on server' });
    }

    // Prefer verifying via Supabase REST token endpoint (grant_type=otp)
    try {
      const restVerify = await verifyOtpViaRest(lowerEmail, trimmedToken);
      verifyAttempt.status = 'verified_rest';
      verifyAttempt.result = restVerify;
      console.log('OTP verify (REST) succeeded for', lowerEmail);
    } catch (restErr) {
      // If REST verify fails, attempt admin SDK fallback
      verifyAttempt.result = { restError: restErr.message, restBody: restErr.body || null };
      console.warn('Supabase REST OTP verify failed, attempting admin SDK fallback:', restErr.message, restErr.body || '');
      if (supabaseAdmin && typeof supabaseAdmin.auth?.verifyOtp === 'function') {
        try {
          const { data: verifyData, error: verifyError } = await supabaseAdmin.auth.verifyOtp({ email: lowerEmail, token: trimmedToken, type: 'email' });
          if (verifyError) {
            verifyAttempt.status = 'verify_failed_admin';
            verifyAttempt.result = { restError: restErr.message, adminError: verifyError.message };
            console.error('Supabase verify OTP error (admin):', verifyError);
            return res.status(400).json({ error: 'Invalid or expired OTP', message: verifyError.message, details: verifyAttempt.result });
          }
          verifyAttempt.status = 'verified_admin_fallback';
          verifyAttempt.result = { restError: restErr.message, adminResult: verifyData };
          console.log('OTP verify (admin-fallback) succeeded for', lowerEmail);
        } catch (adminErr) {
          verifyAttempt.status = 'verify_exception';
          verifyAttempt.result = { restError: restErr.message, adminException: adminErr.message };
          console.error('Supabase verify OTP exception (admin):', adminErr);
          return res.status(400).json({ error: 'Invalid or expired OTP', message: adminErr.message, details: verifyAttempt.result });
        }
      } else {
        verifyAttempt.status = 'no_fallback';
        console.error('No available method to verify OTP:', restErr.message);
        return res.status(400).json({ error: 'Invalid or expired OTP', message: restErr.message, details: verifyAttempt.result });
      }
    }

    // Extract registration fields from body (support pending object or top-level fields)
    const full_name = pending.full_name || (pending.first_name ? pending.first_name + ' ' + (pending.last_name || '') : undefined);
    const password = pending.password;
    const student_id = pending.student_id || pending.username;
    const course = pending.course;
    const year_level = pending.year_level;

    if (!full_name || !password || !student_id) {
      return res.status(400).json({ error: 'Missing registration fields', message: 'Missing registration fields' });
    }

    const lowerUsername = String(student_id).toLowerCase();

    // Duplicate checks
    const { data: existingByUsername, error: usernameLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('username', lowerUsername)
      .single();

    if (!usernameLookupError && existingByUsername) {
      return res.status(400).json({ error: 'Username already registered', message: 'Username already registered', field: 'username' });
    }

    const { data: existingByStudentId, error: studentIdLookupError } = await supabase
      .from('users')
      .select('id')
      .eq('student_id', student_id)
      .single();

    if (!studentIdLookupError && existingByStudentId) {
      return res.status(400).json({ error: 'Student ID already registered', message: 'Student ID already registered', field: 'student_id' });
    }

    const { data: existingByEmail2, error: emailLookupError2 } = await supabase
      .from('users')
      .select('id')
      .eq('email', lowerEmail)
      .single();

    if (!emailLookupError2 && existingByEmail2) {
      return res.status(400).json({ error: 'Email already registered', message: 'Email already registered', field: 'email' });
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);

    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        username: lowerUsername,
        password_hash: hashedPassword,
        full_name,
        email: lowerEmail,
        role: 'student',
        student_id,
        course,
        year_level,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError || !newUser) {
      console.error('User insert error (OTP verify flow):', insertError);
      return res.status(400).json({ error: 'Registration failed', message: insertError?.message || 'Could not create user' });
    }

    // Initialize presence record (best effort)
    try {
      const now = new Date().toISOString();
      await supabase.from('user_presence').insert([{
        user_id: newUser.id,
        is_online: false,
        active_since: null,
        last_seen_at: now,
        updated_at: now
      }]);
    } catch (presenceError) {
      console.warn('Presence initialization failed, continuing:', presenceError.message);
    }

    // Generate token
    const tokenResp = generateToken(newUser.id, newUser.role);

    res.status(201).json({
      token: tokenResp,
      user: {
        id: newUser.id,
        username: newUser.username,
        full_name: newUser.full_name,
        name: newUser.full_name,
        role: newUser.role,
        email: newUser.email,
        student_id: newUser.student_id,
        course: newUser.course,
        year_level: newUser.year_level
      }
    });
  } catch (error) {
    console.error('OTP verify error:', error);
    res.status(500).json({ error: 'OTP verification failed', message: error.message });
  }
});

// Debug endpoint: inspect recent OTP attempts and configuration state
router.get('/otp/debug', (req, res) => {
  try {
    res.json({
      ok: true,
      supabaseAdminAvailable: !!supabaseAdmin,
      supabaseServiceKeyConfigured: !!supabaseServiceKey,
      supabaseUrl: supabaseUrl || null,
      recentAttempts: otpLogs.slice(-50)
    });
  } catch (err) {
    console.error('OTP debug endpoint error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
