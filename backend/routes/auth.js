// Authentication routes
const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const router = express.Router();
const { supabase, supabaseAdmin, supabaseAnonKey, supabaseServiceKey, supabaseUrl } = require('../config/supabase');
const { generateToken } = require('../middleware/auth');

// In-memory OTP attempt logs (ephemeral; useful for quick diagnostics)
const otpLogs = [];

const LEGACY_STAFF_PASSWORDS = {
  accounting: ['AcctDev2024'],
  registrar: ['RegisDev2024']
};

function isLegacyStaffPassword(role, password) {
  const normalizedRole = String(role || '').toLowerCase();
  return (LEGACY_STAFF_PASSWORDS[normalizedRole] || []).includes(String(password || ''));
}

function getSmtpConfig() {
  const user = process.env.SMTP_USER || process.env.BREVO_SMTP_LOGIN || process.env.BREVO_SMTP_USER || '';
  const pass = process.env.SMTP_PASS || process.env.BREVO_SMTP_KEY || process.env.BREVO_SMTP_PASS || '';
  const from = process.env.SMTP_FROM || process.env.BREVO_SMTP_FROM || '';
  const host = process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST || (user && pass ? 'smtp-relay.brevo.com' : '');
  const port = Number(process.env.SMTP_PORT || process.env.BREVO_SMTP_PORT) || 587;
  const secureRaw = process.env.SMTP_SECURE || process.env.BREVO_SMTP_SECURE || '';

  return {
    configured: Boolean(host && user && pass && from),
    host,
    port,
    secure: String(secureRaw).toLowerCase() === 'true' || port === 465,
    user,
    pass,
    from
  };
}

// Sanitize response bodies before logging to avoid leaking OTPs, tokens, or secrets
function sanitizeResponseBody(body) {
  try {
    if (!body) return body;
    const clone = JSON.parse(JSON.stringify(body));
    const sensitiveKeyRe = /(otp|token|access_token|refresh_token|password|secret|code)/i;
    const walk = (node) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        Object.keys(node).forEach((k) => {
          try {
            if (sensitiveKeyRe.test(k)) {
              node[k] = '***REDACTED***';
            } else if (typeof node[k] === 'string' && /^\d{4,12}$/.test(node[k])) {
              node[k] = '***REDACTED***';
            } else if (typeof node[k] === 'object' && node[k] !== null) {
              walk(node[k]);
            }
          } catch (e) {}
        });
      }
    };
    walk(clone);
    return clone;
  } catch (e) {
    return '[UNPARSEABLE_RESPONSE]';
  }
}

// Helper: send OTP using Supabase Auth REST endpoint (/auth/v1/otp)
async function sendOtpViaRest(email, options = {}) {
  const authApiKey = supabaseAnonKey || supabaseServiceKey || '';
  if (!supabaseUrl || !authApiKey) {
    throw new Error('Supabase URL or auth API key not configured');
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

  const payload = {
    email,
    ...((options && typeof options === 'object') ? options : {})
  };

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: authApiKey,
      Authorization: `Bearer ${authApiKey}`
    },
    body: JSON.stringify(payload)
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
  const authApiKey = supabaseAnonKey || supabaseServiceKey || '';
  if (!supabaseUrl || !authApiKey) {
    throw new Error('Supabase URL or auth API key not configured');
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
      apikey: authApiKey,
      Authorization: `Bearer ${authApiKey}`
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
      return res.json({ ok: false, error: 'Invalid credentials' });
    }

    if (isLegacyStaffPassword(user.role, password)) {
      return res.json({ ok: false, error: 'Invalid credentials' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.json({ ok: false, error: 'Invalid credentials' });
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
      ok: true,
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

    // Determine available OTP delivery mechanism. Prefer SMTP (Nodemailer) if configured,
    // otherwise fall back to Supabase Auth REST (existing behavior).
    const smtpConfig = getSmtpConfig();
    if (!smtpConfig.configured && !supabaseServiceKey) {
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

    const db = supabaseAdmin || supabase;
    // Rate-limit: max 5 sends per hour, and cooldown 30s between sends
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recentSends, error: recentErr } = await db
        .from('otp_verifications')
        .select('created_at')
        .eq('email', lowerEmail)
        .gte('created_at', oneHourAgo);
      if (!recentErr && Array.isArray(recentSends) && recentSends.length >= 5) {
        sendAttempt.status = 'rate_limited_hour';
        return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
      }
      const { data: lastRow, error: lastErr } = await db
        .from('otp_verifications')
        .select('created_at')
        .eq('email', lowerEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!lastErr && lastRow && lastRow.created_at) {
        const lastMs = new Date(lastRow.created_at).getTime();
        if (Date.now() - lastMs < 30 * 1000) {
          sendAttempt.status = 'cooldown';
          return res.status(429).json({ error: 'OTP recently sent. Please wait before resending.' });
        }
      }
    } catch (rlErr) {
      console.warn('OTP rate-limit check failed:', rlErr && rlErr.message ? rlErr.message : rlErr);
    }

    // If SMTP available, generate OTP, store hashed, and send via SMTP
    if (smtpConfig.configured) {
      try {
        const otp = String(crypto.randomInt(10000000, 100000000));
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

        const { data: inserted, error: insertErr } = await db
          .from('otp_verifications')
          .insert([{
            email: lowerEmail,
            otp_hash: otpHash,
            purpose: 'registration',
            expires_at: expiresAt,
            created_at: new Date().toISOString()
          }])
          .select()
          .single();
        if (insertErr || !inserted) {
          sendAttempt.status = 'db_insert_failed';
          console.error('OTP insert failed:', insertErr ? insertErr.message || insertErr : 'no data');
          return res.status(500).json({ error: 'Failed to generate OTP' });
        }

        const transporter = nodemailer.createTransport({
          host: smtpConfig.host,
          port: smtpConfig.port,
          secure: smtpConfig.secure,
          auth: {
            user: smtpConfig.user,
            pass: smtpConfig.pass
          }
        });

        const mailOptions = {
          from: smtpConfig.from,
          to: lowerEmail,
          subject: 'Your ConcernTrack verification code',
          text: `Your ConcernTrack verification code is ${otp}. It expires in 5 minutes.`,
          html: `<p>Your ConcernTrack verification code is <strong>${otp}</strong>. It expires in 5 minutes.</p>`
        };

        const info = await transporter.sendMail(mailOptions);
        sendAttempt.status = 'sent_smtp';
        sendAttempt.result = { smtpMessageId: info && info.messageId ? info.messageId : null };
        console.log('[OTP SEND] Email sent via SMTP for', lowerEmail, 'messageId=', info && info.messageId ? info.messageId : 'N/A');
        return res.json({ ok: true, data: { smtp: true, messageId: info && info.messageId ? info.messageId : null } });
      } catch (smtpErr) {
        sendAttempt.status = 'smtp_failed';
        console.error('[OTP SEND] SMTP send failed:', smtpErr && smtpErr.message ? smtpErr.message : smtpErr);
        return res.status(500).json({ error: 'Failed to send OTP via SMTP', message: smtpErr && smtpErr.message ? smtpErr.message : String(smtpErr) });
      }
    }

    // Fallback: use Supabase Auth REST endpoint to request a numeric email OTP.
    try {
      const restResp = await sendOtpViaRest(lowerEmail);
      sendAttempt.status = 'sent_rest';
      sendAttempt.result = { rest: restResp };
      try {
        const safeBody = sanitizeResponseBody(restResp);
        console.log('[OTP SEND] Supabase response (sanitized):', JSON.stringify(safeBody));
      } catch (e) {}
      console.log('OTP send (REST) succeeded for', lowerEmail);
      return res.json({ ok: true, data: restResp });
    } catch (restErr) {
      sendAttempt.status = 'failed_rest';
      sendAttempt.result = { restError: restErr.message, restBody: restErr.body || null };
      try {
        const safeBody = sanitizeResponseBody(restErr.body || null);
        console.error('[OTP SEND] Supabase error status=%s message=%s body=%s', restErr.status || 'N/A', restErr.message || '', JSON.stringify(safeBody));
      } catch (e) {
        console.error('OTP send (REST) failed:', restErr.message);
      }
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

    const smtpConfig = getSmtpConfig();
    if (!supabaseServiceKey && !smtpConfig.configured) {
      verifyAttempt.status = 'no_service_key';
      return res.status(500).json({ error: 'OTP service not configured on server' });
    }

    // Verify OTP against our local DB-stored hashed OTPs (preferred).
    // If SMTP is not configured, sends fall back to Supabase Auth REST, so verification
    // must use the matching Supabase REST token exchange when no local OTP row exists.
    try {
      const db = supabaseAdmin || supabase;
      const nowIso = new Date().toISOString();
      const { data: otpRow, error: otpErr } = await db
        .from('otp_verifications')
        .select('*')
        .eq('email', lowerEmail)
        .eq('purpose', 'registration')
        .is('used_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (otpErr) {
        console.error('OTP lookup error:', otpErr.message || otpErr);
        return res.status(500).json({ error: 'OTP verification failed', message: 'Unable to verify OTP' });
      }

      if (!otpRow) {
        if (smtpConfig.configured) {
          verifyAttempt.status = 'no_otp_found';
          return res.status(400).json({ error: 'Invalid or expired OTP', message: 'No OTP found for this email' });
        }

        try {
          const restResp = await verifyOtpViaRest(lowerEmail, trimmedToken);
          verifyAttempt.status = 'verified_supabase_rest';
          verifyAttempt.result = { rest: sanitizeResponseBody(restResp) };
        } catch (restErr) {
          verifyAttempt.status = 'invalid_supabase_rest_otp';
          verifyAttempt.result = { restError: restErr.message, restBody: sanitizeResponseBody(restErr.body || null) };
          return res.status(400).json({ error: 'Invalid or expired OTP', message: restErr.message || 'OTP verification failed' });
        }
      } else {
        if (!otpRow.expires_at || new Date(otpRow.expires_at).getTime() < Date.now()) {
          verifyAttempt.status = 'otp_expired';
          return res.status(400).json({ error: 'Invalid or expired OTP', message: 'OTP has expired' });
        }

        const match = await bcrypt.compare(trimmedToken, otpRow.otp_hash || '');
        if (!match) {
          verifyAttempt.status = 'invalid_otp';
          return res.status(400).json({ error: 'Invalid or expired OTP', message: 'OTP does not match' });
        }

        // Mark OTP as used (best-effort)
        try {
          await db.from('otp_verifications').update({ used_at: new Date().toISOString() }).eq('id', otpRow.id);
        } catch (markErr) {
          console.warn('Failed to mark OTP used:', markErr && markErr.message ? markErr.message : markErr);
        }

        verifyAttempt.status = 'verified_local_db';
        verifyAttempt.result = { otpId: otpRow.id };
      }
    } catch (e) {
      console.error('OTP verify error:', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'OTP verification failed', message: e && e.message ? e.message : String(e) });
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

async function findStudentByUsernameOrId(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  const db = supabaseAdmin || supabase;

  let result = await db
    .from('users')
    .select('id, username, full_name, email, role, student_id')
    .eq('username', lower)
    .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  if (!result.data && raw !== lower) {
    result = await db
      .from('users')
      .select('id, username, full_name, email, role, student_id')
      .eq('username', raw)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
  }

  if (!result.data) {
    result = await db
      .from('users')
      .select('id, username, full_name, email, role, student_id')
      .eq('student_id', raw)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
  }

  if (!result.data && raw.includes('@')) {
    result = await db
      .from('users')
      .select('id, username, full_name, email, role, student_id')
      .eq('email', lower)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
  }

  const user = result.data || null;
  if (!user || String(user.role || '').toLowerCase() !== 'student') {
    return null;
  }

  return user;
}

async function createStoredOtp(email, purpose) {
  const db = supabaseAdmin || supabase;
  const otp = String(crypto.randomInt(10000000, 100000000));
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { data: inserted, error: insertErr } = await db
    .from('otp_verifications')
    .insert([{
      email,
      otp_hash: otpHash,
      purpose,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (insertErr || !inserted) {
    throw new Error(insertErr?.message || 'Failed to generate OTP');
  }

  return { id: inserted.id, otp, expiresAt };
}

async function sendLocalOtpEmail({ email, purpose, subject, text, html }) {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.configured) {
    throw new Error('SMTP is not configured');
  }

  const { id, otp, expiresAt } = await createStoredOtp(email, purpose);

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass
    }
  });

  const info = await transporter.sendMail({
    from: smtpConfig.from,
    to: email,
    subject,
    text: text.replace('{{otp}}', otp),
    html: html.replace('{{otp}}', otp)
  });

  return { id, otp, expiresAt, messageId: info && info.messageId ? info.messageId : null };
}

async function verifyLocalOrRestOtp(email, token, purpose) {
  const lowerEmail = String(email || '').trim().toLowerCase();
  const trimmedToken = String(token || '').trim();
  const db = supabaseAdmin || supabase;
  const smtpConfig = getSmtpConfig();

  const { data: otpRow, error: otpErr } = await db
    .from('otp_verifications')
    .select('*')
    .eq('email', lowerEmail)
    .eq('purpose', purpose)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (otpErr) {
    throw new Error('Unable to verify OTP');
  }

  if (!otpRow) {
    if (smtpConfig.configured) {
      const err = new Error('Invalid or expired OTP');
      err.status = 400;
      throw err;
    }

    await verifyOtpViaRest(lowerEmail, trimmedToken);
    return;
  }

  if (!otpRow.expires_at || new Date(otpRow.expires_at).getTime() < Date.now()) {
    const err = new Error('OTP has expired');
    err.status = 400;
    throw err;
  }

  const match = await bcrypt.compare(trimmedToken, otpRow.otp_hash || '');
  if (!match) {
    const err = new Error('OTP does not match');
    err.status = 400;
    throw err;
  }

  try {
    await db.from('otp_verifications').update({ used_at: new Date().toISOString() }).eq('id', otpRow.id);
  } catch (markErr) {
    console.warn('Failed to mark OTP used:', markErr && markErr.message ? markErr.message : markErr);
  }
}

router.get('/password-reset/status', (req, res) => {
  res.json({
    ok: true,
    route: 'password-reset',
    smtpConfigured: getSmtpConfig().configured,
    supabaseServiceKeyConfigured: !!supabaseServiceKey
  });
});

router.post('/password-reset/send', async (req, res) => {
  try {
    const username = String(req.body?.username || req.body?.student_id || '').trim();
    if (!username) {
      return res.status(400).json({ error: 'Student ID is required', message: 'Student ID is required' });
    }

    const user = await findStudentByUsernameOrId(username);
    if (!user || !user.email) {
      return res.status(404).json({ error: 'Student account not found', message: 'Student account not found' });
    }

    const lowerEmail = String(user.email || '').trim().toLowerCase();
    if (!lowerEmail.endsWith('@uv.edu.ph')) {
      return res.status(400).json({ error: 'Registered email is not a university email', message: 'Registered email is not a university email' });
    }

    const sendAttempt = {
      time: new Date().toISOString(),
      action: 'password_reset_send',
      email: lowerEmail,
      username: user.username,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
      status: 'started'
    };
    otpLogs.push(sendAttempt);
    while (otpLogs.length > 200) otpLogs.shift();

    const db = supabaseAdmin || supabase;
    if (process.env.NODE_ENV === 'production') {
      try {
        const nowIso = new Date().toISOString();
        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const { data: recentActiveSends, error: recentErr } = await db
          .from('otp_verifications')
          .select('created_at, expires_at, used_at')
          .eq('email', lowerEmail)
          .eq('purpose', 'password_reset')
          .is('used_at', null)
          .gte('created_at', fifteenMinutesAgo)
          .gte('expires_at', nowIso);
        if (!recentErr && Array.isArray(recentActiveSends) && recentActiveSends.length >= 3) {
          sendAttempt.status = 'rate_limited_active';
          return res.status(429).json({ error: 'Too many active OTP requests. Please wait a few minutes and try again.' });
        }

        const { data: lastRow, error: lastErr } = await db
          .from('otp_verifications')
          .select('created_at')
          .eq('email', lowerEmail)
          .eq('purpose', 'password_reset')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!lastErr && lastRow && lastRow.created_at) {
          const lastMs = new Date(lastRow.created_at).getTime();
          if (Date.now() - lastMs < 30 * 1000) {
            sendAttempt.status = 'cooldown';
            return res.status(429).json({ error: 'OTP recently sent. Please wait before resending.' });
          }
        }
      } catch (rlErr) {
        console.warn('Password reset rate-limit check failed:', rlErr && rlErr.message ? rlErr.message : rlErr);
      }
    }

    const smtpConfig = getSmtpConfig();
    if (smtpConfig.configured) {
      const result = await sendLocalOtpEmail({
        email: lowerEmail,
        purpose: 'password_reset',
        subject: 'Your ConcernTrack password reset code',
        text: 'Your ConcernTrack password reset code is {{otp}}. It expires in 5 minutes.',
        html: '<p>Your ConcernTrack password reset code is <strong>{{otp}}</strong>. It expires in 5 minutes.</p>'
      });
      sendAttempt.status = 'sent_smtp';
      sendAttempt.result = { otpId: result.id, smtpMessageId: result.messageId };
      return res.json({ ok: true, email: lowerEmail.replace(/^(.{2}).*(@.*)$/, '$1***$2') });
    }

    if (!supabaseServiceKey) {
      sendAttempt.status = 'no_otp_service';
      return res.status(500).json({ error: 'OTP service not configured on server' });
    }

    try {
      const restResp = await sendOtpViaRest(lowerEmail);
      sendAttempt.status = 'sent_rest';
      sendAttempt.result = { rest: sanitizeResponseBody(restResp) };
      return res.json({ ok: true, email: lowerEmail.replace(/^(.{2}).*(@.*)$/, '$1***$2') });
    } catch (restErr) {
      sendAttempt.status = 'failed_rest';
      sendAttempt.result = { restError: restErr.message, restBody: sanitizeResponseBody(restErr.body || null) };

      throw restErr;
    }
  } catch (error) {
    console.error('Password reset OTP send error:', error);
    const payload = { error: 'Failed to send password reset OTP', message: error.message };
    if (process.env.NODE_ENV !== 'production' && error && error.body) {
      payload.details = sanitizeResponseBody(error.body);
    }
    res.status(error.status || 500).json(payload);
  }
});

router.post('/password-reset/verify', async (req, res) => {
  try {
    const username = String(req.body?.username || req.body?.student_id || '').trim();
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !token || !password) {
      return res.status(400).json({ error: 'Student ID, OTP, and new password are required' });
    }

    if (!/^[0-9]{8}$/.test(token)) {
      return res.status(400).json({ error: 'Please enter the 8-digit OTP code' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await findStudentByUsernameOrId(username);
    if (!user || !user.email) {
      return res.status(404).json({ error: 'Student account not found', message: 'Student account not found' });
    }

    const lowerEmail = String(user.email || '').trim().toLowerCase();
    await verifyLocalOrRestOtp(lowerEmail, token, 'password_reset');

    const passwordHash = await bcrypt.hash(password, 10);
    const db = supabaseAdmin || supabase;
    const { data: updatedUser, error: updateError } = await db
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id)
      .select('id, username, full_name, email, role, student_id, course, year_level')
      .single();

    if (updateError || !updatedUser) {
      throw new Error(updateError?.message || 'Failed to update password');
    }

    res.json({
      ok: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        full_name: updatedUser.full_name,
        name: updatedUser.full_name,
        role: updatedUser.role,
        email: updatedUser.email,
        student_id: updatedUser.student_id,
        course: updatedUser.course,
        year_level: updatedUser.year_level
      }
    });
  } catch (error) {
    console.error('Password reset verify error:', error);
    res.status(error.status || 500).json({ error: 'Password reset failed', message: error.message });
  }
});

// Debug endpoint: inspect recent OTP attempts and configuration state
router.get('/otp/debug', (req, res) => {
  try {
    const debugKey = process.env.OTP_DEBUG_KEY || '';
    if (debugKey && req.headers['x-debug-key'] !== debugKey) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (!debugKey && process.env.NODE_ENV === 'production') {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }

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
