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
  const configuredBase = String(
    (typeof window !== 'undefined' && window && window.BACKEND_BASE)
      ? window.BACKEND_BASE
      : ''
  ).trim();
  const remoteBase = 'https://studentconcerndazo.onrender.com/api';
  const bases = [];

  try {
    const host = String(window.location.hostname || '').toLowerCase();
    const port = String(window.location.port || '').trim();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    const currentOriginApi = port ? `${window.location.protocol}//${window.location.host}/api` : '';
    const backendPorts = ['10000', '5000'];
    const isBackendOrigin = backendPorts.includes(port);

    if (configuredBase) {
      bases.push(configuredBase);
    }

    if (isLocal) {
      if (isBackendOrigin && currentOriginApi) {
        bases.push(currentOriginApi);
      }
      bases.push('http://localhost:10000/api');
      bases.push('http://127.0.0.1:10000/api');
      bases.push('http://localhost:5000/api');
      bases.push('http://127.0.0.1:5000/api');
      if (!isBackendOrigin && currentOriginApi) {
        bases.push(currentOriginApi);
      }
      bases.push('http://localhost:3000/api');
      bases.push('http://127.0.0.1:3000/api');
      bases.push(remoteBase);
    } else if (!configuredBase) {
      bases.push(remoteBase);
    }
  } catch (e) {}

  // Same-origin is useful when Express serves the frontend itself.
  bases.push('/api');
  return Array.from(new Set(
    bases
      .map((base) => String(base || '').replace(/\/+$/, ''))
      .filter(Boolean)
  ));
}

function isLocalFrontendApiBase(base) {
  try {
    const normalizedBase = String(base || '').replace(/\/+$/, '');
    const currentHost = String(window.location.hostname || '').toLowerCase();
    const currentPort = String(window.location.port || '').trim();
    const isLocalPage = currentHost === 'localhost' || currentHost === '127.0.0.1' || currentHost === '';

    if (!isLocalPage) {
      return false;
    }

    if (normalizedBase === '/api') {
      return Boolean(currentPort) && !['5000', '10000'].includes(currentPort);
    }

    const parsed = new URL(normalizedBase, window.location.origin);
    const host = String(parsed.hostname || '').toLowerCase();
    const port = String(parsed.port || '').trim();
    return (host === 'localhost' || host === '127.0.0.1') && Boolean(port) && !['5000', '10000'].includes(port);
  } catch (e) {
    return false;
  }
}

function shouldTryNextBaseOn404(base, data) {
  if (typeof data === 'string') {
    if (/<!doctype html>|<html[\s>]|<pre>Cannot\s+(GET|POST|PUT|PATCH|DELETE)\s+/i.test(data)) {
      return true;
    }

    if (/^\s*not found\s*$/i.test(data) || /^\s*404\b/i.test(data)) {
      return true;
    }
  }

  return isLocalFrontendApiBase(base);
}

function apiErrorMessageFromBody(data, fallback) {
  if (!data) {
    return fallback;
  }

  if (typeof data === 'string') {
    if (/<!doctype html>|<html[\s>]|<pre>/i.test(data)) {
      return fallback;
    }
    return data;
  }

  if (typeof data === 'object') {
    const candidate = data.message || data.error || data.detail || data.details;
    if (typeof candidate === 'string') {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.message === 'string') {
        return candidate.message;
      }
      if (typeof candidate.error === 'string') {
        return candidate.error;
      }
      try {
        return JSON.stringify(candidate);
      } catch (e) {
        return fallback;
      }
    }
    try {
      return JSON.stringify(data);
    } catch (e) {
      return fallback;
    }
  }

  return fallback;
}

async function apiCall(endpoint, options = {}) {
  const headers = {
    'Accept': 'application/json',
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
  let lastApiError = null;

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
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
        const msg = apiErrorMessageFromBody(data, `API Error: ${response.status}`);

        if (response.status === 401 && /jwt malformed|invalid token|unauthorized/i.test(String(msg))) {
          localStorage.removeItem('authToken');
        }

        const err = new Error(msg);
        err.status = response.status;
        err.url = url;
        err.body = data;

        const canTryNextBase = i < bases.length - 1;
        const shouldTryNextBase =
          response.status === 404 &&
          canTryNextBase &&
          shouldTryNextBaseOn404(base, data);

        if (shouldTryNextBase) {
          lastApiError = err;
          continue;
        }

        if (response.status === 404 && isLocalFrontendApiBase(base)) {
          err.message = 'This page is using a frontend-only local server. Start the backend on port 10000, then hard refresh the page.';
        } else if (response.status === 404 && shouldTryNextBaseOn404(base, data)) {
          err.message = 'This backend route is not available on the server currently handling your request. Start the local backend and hard refresh the page.';
        }

        if (response.status === 404 && /^\/auth\/password-reset\//.test(String(endpoint || ''))) {
          err.message = 'Password reset is not available on the backend currently serving this page. Start the backend from the `backend` folder, then hard refresh the page.';
        }

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

  if (lastApiError) {
    const friendly = new Error(
      /^\/auth\/password-reset\//.test(String(endpoint || ''))
        ? 'Password reset is not available on the backend currently serving this page. Start the backend from the `backend` folder, then hard refresh the page.'
        : 'This backend route is not available on the server currently handling your request. Start the local backend and hard refresh the page.'
    );
    friendly.status = lastApiError.status;
    friendly.url = lastApiError.url;
    throw friendly;
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

async function apiSendPasswordResetOtp(username) {
  const response = await apiCall('/auth/password-reset/send', {
    method: 'POST',
    body: { username }
  });
  return response;
}

async function apiVerifyPasswordResetOtp(username, token, password) {
  const response = await apiCall('/auth/password-reset/verify', {
    method: 'POST',
    body: { username, token, password }
  });
  return response;
}

async function apiLogin(username, password) {
  const response = await apiCall('/auth/login', {
    method: 'POST',
    body: { username, password }
  });

  if (!response || response.ok === false || !response.token || !response.user) {
    const err = new Error((response && (response.message || response.error)) || 'Invalid credentials');
    err.status = 401;
    err.body = response;
    throw err;
  }
  
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

async function apiUpdateTicketStatus(ticketId, status, staffNote = '') {
  const response = await apiCall(`/tickets/${ticketId}/status`, {
    method: 'PATCH',
    body: { status, staffNote }
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
    const deletedRaw = localStorage.getItem('deletedUsers');
    const archivedRaw = localStorage.getItem('archivedUsers');
    const deleted = deletedRaw ? JSON.parse(deletedRaw) : [];
    const archived = archivedRaw ? JSON.parse(archivedRaw) : [];
    const list = []
      .concat(Array.isArray(deleted) ? deleted : [])
      .concat(Array.isArray(archived) ? archived : []);
    if (!Array.isArray(list) || !list.length) return false;

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

    if (isMarkedDeletedBackendUser(row)) {
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
      try { if (typeof buildSidebar === 'function') buildSidebar(); } catch (e) {}
    }
  } catch (e) {}

  // Navigate to notifications
  try { showPage('s-notifs'); } catch (e) { showPage('s-notifs'); }
}

// Mark a staff notification as read (accepts IDs like "ann:<uuid>") — optimistic UI then background sync
// Uses a small pending set to avoid double-click/spam.
if (typeof window !== 'undefined') {
  window.__PENDING_ANN_READS__ = window.__PENDING_ANN_READS__ || new Set();
}
const PENDING_ANN_READS = (typeof window !== 'undefined') ? window.__PENDING_ANN_READS__ : new Set();

function markStaffNotificationRead(notificationId) {
  if (!notificationId) return;
  const raw = String(notificationId).replace(/^ann:/, '');

  // If already pending or already read, ignore to prevent spam
  if (PENDING_ANN_READS.has(raw)) return;

  // Optimistically update local cache/UI
  try {
    const idx = (ANNOUNCEMENTS || []).findIndex((a) => a && String(a.id) === String(raw));
    if (idx >= 0) {
      if (ANNOUNCEMENTS[idx].is_read || ANNOUNCEMENTS[idx].read) return;
      ANNOUNCEMENTS[idx].is_read = true;
      ANNOUNCEMENTS[idx].read = true;
      try { saveAnnouncements(); } catch (e) {}
      try { if (typeof buildSidebar === 'function') buildSidebar(); } catch (e) {}
      try { if (typeof showPage === 'function' && currentPageId) showPage(currentPageId); } catch (e) {}
    } else {
      // Fallback: if notification not in ANNOUNCEMENTS (e.g. ticket updates),
      // persist the exact notification id to the student's read list so
      // `getStudentNotifications()` matches it. Then refresh UI.
      try {
        const uid = currentUser && currentUser.id ? currentUser.id : '';
        if (uid) {
          const mark = String(notificationId || '');
          const ids = getReadStudentNotificationIds(uid);
          if (!ids.includes(mark)) {
            ids.push(mark);
            saveReadStudentNotificationIds(uid, ids);
          }
          try { if (typeof buildSidebar === 'function') buildSidebar(); } catch (e) {}
          try { if (typeof showPage === 'function' && currentPageId) showPage(currentPageId); } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}

  // Send backend request in background; keep UI optimistic even if it fails
  PENDING_ANN_READS.add(raw);
  (async () => {
    try {
      if (typeof apiMarkAnnouncementRead === 'function') {
        await apiMarkAnnouncementRead(raw);
      }
    } catch (e) {
      console.warn('Failed to mark staff announcement read:', e && e.message ? e.message : e);
    } finally {
      PENDING_ANN_READS.delete(raw);
    }
  })();
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
