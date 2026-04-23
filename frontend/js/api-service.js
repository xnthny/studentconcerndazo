// Backend API Service - Connects frontend to backend

window.PRESENCE_SYNC_META = window.PRESENCE_SYNC_META || {
  source: 'none',
  lastSyncAt: null,
  ok: false,
  reason: ''
};

function isLikelyJwt(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function decodeJwtPayload(token) {
  try {
    if (!isLikelyJwt(token)) {
      return null;
    }
    const payloadPart = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadPart + '='.repeat((4 - (payloadPart.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function getAuthTokenContext() {
  const token = localStorage.getItem('authToken');
  if (!token || !isLikelyJwt(token)) {
    return { token: null, valid: false, role: null };
  }

  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== 'object') {
    localStorage.removeItem('authToken');
    return { token: null, valid: false, role: null };
  }

  if (typeof payload.exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec) {
      localStorage.removeItem('authToken');
      return { token: null, valid: false, role: null };
    }
  }

  const role = String(payload?.role || payload?.userRole || '').toLowerCase() || null;
  return { token, valid: true, role };
}

function getApiBases() {
  // Always prefer the live Render backend for browser requests.
  return ['https://studentconcerndazo.onrender.com/api'];
}

async function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add auth token if available. Prefer validated token, but fall back to raw localStorage token
  const auth = getAuthTokenContext();
  if (auth && auth.valid && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else {
    try {
      const rawTok = localStorage.getItem('authToken');
      if (rawTok) headers['Authorization'] = `Bearer ${rawTok}`;
    } catch (e) {
      // ignore localStorage access errors
    }
  }

  const bases = getApiBases();
  let lastNetworkError = null;

  for (const base of bases) {
    const url = `${base}${endpoint}`;
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const rawText = await response.text();
      let data = null;
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          data = rawText;
        }
      }

      if (!response.ok) {
        // Prefer structured message fields from backend; include raw body for visibility
        const backendMsg = (data && (data.message || data.error)) || (typeof data === 'string' ? data : null);
        const msg = backendMsg || `API Error: ${response.status}`;

        if (response.status === 401 && /jwt malformed|invalid token|unauthorized/i.test(String(msg))) {
          localStorage.removeItem('authToken');
        }

        const err = new Error(msg);
        err.status = response.status;
        err.url = url;
        err.body = data;
        throw err;
      }

      return data;
    } catch (error) {
      // Retry only for network errors; keep API errors as-is.
      if (error instanceof TypeError) {
        lastNetworkError = error;
        continue;
      }
      // Expected auth failures are handled by caller fallbacks; avoid noisy console spam.
      if (!(error && error.status === 401)) {
        console.error('API Error:', error);
      }
      throw error;
    }
  }

  console.error('API Network Error:', lastNetworkError);
  throw lastNetworkError || new Error('Could not reach backend API');
}

// Authentication API calls
async function apiRegister(fullName, firstName, lastName, studentId, email, course, year, password) {
  const response = await apiCall('/auth/register', {
    method: 'POST',
    body: {
      full_name: fullName,
      username: studentId.toLowerCase(),
      email,
      password,
      student_id: studentId,
      course,
      year_level: year,
      role: 'student'
    }
  });
  return response;
}

// OTP server endpoints
async function apiSendOtp(email) {
  const response = await apiCall('/auth/otp/send', {
    method: 'POST',
    body: { email }
  });
  return response;
}

async function apiVerifyOtpAndRegister(email, token, pending) {
  const response = await apiCall('/auth/otp/verify', {
    method: 'POST',
    body: { email, token, pending }
  });
  return response;
}

async function apiLogin(username, password) {
  const response = await apiCall('/auth/login', {
    method: 'POST',
    body: { username, password }
  });
  
  if (response.token) {
    localStorage.setItem('authToken', response.token);
    localStorage.setItem('currentUser', JSON.stringify(response.user));
  }
  
  return response;
}

async function apiLogout() {
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
}

async function getStoredUser() {
  const user = localStorage.getItem('currentUser');
  return user ? JSON.parse(user) : null;
}

// Ticket API calls
async function apiSubmitTicket(dept, subject, details, category) {
  const response = await apiCall('/tickets', {
    method: 'POST',
    body: {
      student_id: currentUser.id,
      department: dept,
      subject,
      details,
      category: category || dept,
      status: 'Pending'
    }
  });
  return response;
}

async function apiGetTickets() {
  const response = await apiCall('/tickets');
  return response;
}

async function apiGetUserTickets(userId) {
  const response = await apiCall(`/tickets/user/${userId}`);
  return response;
}

async function apiUpdateTicketStatus(ticketId, status) {
  const response = await apiCall(`/tickets/${ticketId}/status`, {
    method: 'PATCH',
    body: { status }
  });
  return response;
}

async function apiAddTicketReply(ticketId, reply, author, role) {
  const response = await apiCall(`/tickets/${ticketId}/replies`, {
    method: 'POST',
    body: {
      reply_text: reply,
      author_name: author,
      author_role: role
    }
  });
  return response;
}

// User API calls
async function apiGetUsers() {
  const response = await apiCall('/users');
  return response;
}

async function apiGetUsersBootstrap() {
  const response = await apiCall('/users/bootstrap');
  return response;
}

async function apiSetPresence(active) {
  const auth = getAuthTokenContext();
  if (!auth.valid) {
    return { ok: false, skipped: true, reason: 'no-valid-token' };
  }

  const response = await apiCall('/users/presence', {
    method: 'POST',
    body: { active: !!active }
  });
  return response;
}

function mapBackendRole(role) {
  const roleMap = {
    student: 'Student',
    accounting: 'Accounting',
    registrar: 'Registrar',
    faculty: 'Registrar',
    admin: 'Admin'
  };
  return roleMap[String(role || '').toLowerCase()] || 'Student';
}

function isBuiltInBackendUser(row) {
  const uname = String(row?.username || '').toLowerCase();
  const sid = String(row?.student_id || '').trim();
  const uid = String(row?.id || '').trim();

  const demoUsernames = ['21210747'];
  const demoIds = [
    '21210747',
    '2025-00123',
    '2025-00124',
    '2025-00125',
    '2025-00126',
    '2025-00127',
    '2025-00128'
  ];

  return demoUsernames.includes(uname) || demoIds.includes(sid) || demoIds.includes(uid);
}

function isMarkedDeletedBackendUser(row) {
  try {
    const raw = localStorage.getItem('deletedUsers');
    if (!raw) return false;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return false;

    const markers = list.map((x) => String(x || '').toLowerCase());
    const id = String(row?.id || '').toLowerCase();
    const sid = String(row?.student_id || '').toLowerCase();
    const uname = String(row?.username || '').toLowerCase();
    return markers.includes(id) || markers.includes(sid) || markers.includes(uname);
  } catch (e) {
    return false;
  }
}

function mergeUsersFromBackendRows(rows) {
  if (!Array.isArray(rows)) {
    rows = [];
  }

  // Build new user list with ONLY backend rows (backend is source of truth)
  // This replaces stale localStorage data instead of merging it forever
  const backendUsers = [];

  rows.forEach((row) => {
    if (isBuiltInBackendUser(row)) {
      return;
    }

    // Only filter deleted users if they're NOT students from backend
    // Backend students should always be shown (they're the source of truth)
    const isBackendStudent = row.role === 'student' || row.role === 'Student';
    if (!isBackendStudent && isMarkedDeletedBackendUser(row)) {
      return;
    }

    const preferredId = row.student_id || row.id;
    if (!preferredId) {
      return;
    }

    const fullName = row.full_name || row.username || 'User';
    const nameParts = fullName.trim().split(/\s+/);
    const ini = (nameParts[0]?.[0] || 'U') + (nameParts[1]?.[0] || '');
    const roleLabel = mapBackendRole(row.role);
    const isStudent = roleLabel === 'Student';

    const hasPresenceFields =
      row.status === 'Active' ||
      row.status === 'Inactive' ||
      !!row.active_since ||
      !!row.activeSince ||
      !!row.last_seen_at ||
      !!row.lastSeenAt;

    const backendStatus = hasPresenceFields
      ? (row.status === 'Active' ? 'Active' : 'Inactive')
      : 'Inactive';

    const resolvedActiveSince = hasPresenceFields
      ? (row.active_since || row.activeSince || '')
      : '';

    const resolvedLastSeenAt = hasPresenceFields
      ? (row.last_seen_at || row.lastSeenAt || '')
      : '';

    const normalized = {
      name: fullName,
      id: preferredId,
      backendId: row.id || '',
      role: roleLabel,
      ini: ini.toUpperCase(),
      bg: isStudent ? 'rgba(26,162,96,0.15)' : 'rgba(37,99,235,0.15)',
      col: isStudent ? '#15803d' : '#1d4ed8',
      status: backendStatus,
      activeSince: resolvedActiveSince,
      lastSeenAt: resolvedLastSeenAt,
      isNew: false,
      email: row.email || '',
      course: row.course || '',
      year: row.year_level || '',
      uname: row.username || '',
      joinDate: row.created_at
        ? new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : ''
    };

    backendUsers.push(normalized);
  });

  // Compare old vs new to detect changes
  const oldUsers = USERS || [];
  const before = JSON.stringify(oldUsers.map(u => u.id).sort());
  const after = JSON.stringify(backendUsers.map(u => u.id).sort());
  const changed = before !== after;

  // Replace USERS with only backend data (removes stale localStorage entries)
  USERS = backendUsers;

  if (changed && typeof saveUsers === 'function') {
    saveUsers();
  }

  return changed;
}

function restoreUsersFromSupabaseOnStartup() {
  if (typeof apiGetUsersBootstrap === 'undefined') {
    return Promise.resolve(false);
  }

  return apiGetUsersBootstrap()
    .then((rows) => {
      window.PRESENCE_SYNC_META = {
        source: 'bootstrap',
        lastSyncAt: new Date().toISOString(),
        ok: true,
        reason: ''
      };
      return mergeUsersFromBackendRows(rows);
    })
    .catch((err) => {
      console.log('Startup Supabase restore skipped:', err.message);
      window.PRESENCE_SYNC_META = {
        source: 'none',
        lastSyncAt: new Date().toISOString(),
        ok: false,
        reason: err.message || 'startup restore failed'
      };
      return false;
    });
}

function syncUsersFromBackend() {
  if (!currentUser || currentUser.role !== 'admin') {
    return Promise.resolve(false);
  }

  const auth = getAuthTokenContext();
  const canUseProtectedUsersEndpoint = !!(auth.valid && auth.role === 'admin');

  let usedSource = 'users';
  const fetchUsers = (canUseProtectedUsersEndpoint && typeof apiGetUsers === 'function'
    ? apiGetUsers()
    : Promise.reject(new Error('No valid auth token for /users')))
    .catch((err) => {
      // Fallback for local-admin sessions without valid backend auth token.
      if (typeof apiGetUsersBootstrap === 'function') {
        usedSource = 'bootstrap';
        return apiGetUsersBootstrap();
      }
      throw err;
    });

  return fetchUsers
    .then((rows) => {
      window.PRESENCE_SYNC_META = {
        source: usedSource,
        lastSyncAt: new Date().toISOString(),
        ok: true,
        reason: ''
      };
      return mergeUsersFromBackendRows(rows);
    })
    .catch((err) => {
      console.log('Backend user sync skipped:', err.message);
      window.PRESENCE_SYNC_META = {
        source: 'none',
        lastSyncAt: new Date().toISOString(),
        ok: false,
        reason: err.message || 'sync failed'
      };
      return false;
    });
}

async function apiGetUser(userId) {
  const response = await apiCall(`/users/${userId}`);
  return response;
}

async function apiUpdateUser(userId, userData) {
  const response = await apiCall(`/users/${userId}`, {
    method: 'PATCH',
    body: userData
  });
  return response;
}

async function apiDeleteUser(identifier, username = '', studentId = '') {
  const auth = getAuthTokenContext();
  if (!auth.valid || auth.role !== 'admin') {
    return { ok: false, skipped: true, reason: 'no-admin-token' };
  }

  const response = await apiCall(`/users/${encodeURIComponent(identifier)}`, {
    method: 'DELETE',
    body: {
      username,
      student_id: studentId
    }
  });
  return response;
}

// Announcements API calls
async function apiGetAnnouncements() {
  const response = await apiCall('/announcements');
  return response;
}

async function apiCreateAnnouncement(title, body, audience = 'All Users', isDraft = false) {
  const response = await apiCall('/announcements', {
    method: 'POST',
    body: { title, body, audience, isDraft }
  });
  return response;
}

async function apiDeleteAnnouncement(id) {
  const response = await apiCall(`/announcements/${id}`, {
    method: 'DELETE'
  });
  return response;
}

// Mark announcement read (backend when id is UUID, else local fallback)
async function apiMarkAnnouncementRead(announcementId) {
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRe.test(String(announcementId || ''))) {
    // Local announcement id (ANN-xxx) - mark via localStorage helpers
    try {
      const uid = currentUser && currentUser.id ? currentUser.id : '';
      const mark = `ann:${announcementId}`;
      const ids = getReadStudentNotificationIds(uid);
      if (!ids.includes(mark)) {
        ids.push(mark);
        saveReadStudentNotificationIds(uid, ids);
      }
      return { ok: true, local: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  const response = await apiCall(`/announcements/${announcementId}/read`, {
    method: 'POST'
  });
  return response;
}

// Helper: mark read then open Notifications page
async function markAnnouncementReadAndOpen(announcementId) {
  try {
    if (typeof apiMarkAnnouncementRead === 'function') {
      await apiMarkAnnouncementRead(announcementId);
    }
  } catch (e) {
    console.warn('Failed to mark announcement read:', e && e.message ? e.message : e);
  }

  // Update local ANNOUNCEMENTS cache so UI updates immediately
  try {
    const idx = (ANNOUNCEMENTS || []).findIndex((a) => a && String(a.id) === String(announcementId));
    if (idx >= 0) {
      ANNOUNCEMENTS[idx].is_read = true;
      ANNOUNCEMENTS[idx].read = true;
      try { saveAnnouncements(); } catch (e) {}
    }
  } catch (e) {}

  // Navigate to notifications
  try { showPage('s-notifs'); } catch (e) { showPage('s-notifs'); }
}

// Profile API calls
async function apiGetProfile(userId) {
  const response = await apiCall(`/profiles/${userId}`);
  return response;
}

async function apiUpdateProfile(userId, profileData) {
  const response = await apiCall(`/profiles/${userId}`, {
    method: 'PATCH',
    body: profileData
  });
  return response;
}

async function apiUploadProfilePhoto(userId, photoData) {
  const response = await apiCall(`/profiles/${userId}/photo`, {
    method: 'POST',
    body: { photoData: photoData }
  });
  return response;
}
