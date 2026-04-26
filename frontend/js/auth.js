// Authentication module

function goRegister() {
  document.getElementById('login-screen').style.display = 'none';
  const forgot = document.getElementById('forgot-screen');
  if (forgot) forgot.style.display = 'none';
  document.getElementById('register-screen').style.display = 'flex';
  document.getElementById('reg-err').style.display = 'none';
  document.getElementById('reg-ok').style.display = 'none';
}

function goLogin() {
  document.getElementById('register-screen').style.display = 'none';
  const forgot = document.getElementById('forgot-screen');
  if (forgot) forgot.style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-error').style.display = 'none';
}

function goForgotPassword() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('register-screen').style.display = 'none';
  const forgot = document.getElementById('forgot-screen');
  if (forgot) forgot.style.display = 'flex';

  ['fp-err', 'fp-ok'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.style.display = 'none';
    }
  });

  const loginId = document.getElementById('login-id')?.value?.trim() || '';
  const studentId = document.getElementById('fp-student-id');
  if (studentId && loginId && !getCanonicalStaffKey(loginId)) {
    studentId.value = loginId;
  }

  const fields = document.getElementById('fp-reset-fields');
  if (fields) fields.style.display = 'block';
}

function setForgotPasswordMessage(type, message) {
  const errEl = document.getElementById('fp-err');
  const okEl = document.getElementById('fp-ok');
  if (errEl) errEl.style.display = 'none';
  if (okEl) okEl.style.display = 'none';

  const el = type === 'error' ? errEl : okEl;
  if (!el) return;
  el.textContent = formatForgotPasswordMessage(message);
  el.style.display = 'block';
}

function formatForgotPasswordMessage(value) {
  if (!value) {
    return 'Something went wrong. Please try again.';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message || 'Something went wrong. Please try again.';
  }

  if (typeof value === 'object') {
    const candidate = value.message || value.error || value.detail || value.details;
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
    }
    try {
      return JSON.stringify(value);
    } catch (e) {
      return 'Something went wrong. Please try again.';
    }
  }

  return String(value);
}

function syncForgotPasswordLocalAccount(username, password, user) {
  const key = String(user?.username || user?.student_id || username || '').toLowerCase();
  if (!key) return;

  try {
    if (typeof loadRegisteredStudents === 'function') {
      loadRegisteredStudents();
    }

    const existing = ACCOUNTS[key] || {};
    const name = user?.full_name || user?.name || existing.name || 'Student';
    const ini = existing.ini || name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'ST';
    const account = {
      ...existing,
      password,
      role: 'student',
      name,
      id: user?.student_id || existing.id || key,
      ini,
      bg: existing.bg || 'rgba(26,162,96,0.2)',
      col: existing.col || '#1AA260',
      isNew: existing.isNew !== undefined ? existing.isNew : false,
      course: user?.course || existing.course || '',
      year: user?.year_level || user?.year || existing.year || '',
      email: user?.email || existing.email || ''
    };

    if (typeof saveStudentRegistration === 'function') {
      saveStudentRegistration(key, account, String(username || '').toLowerCase() !== key ? String(username || '').toLowerCase() : undefined);
    } else {
      ACCOUNTS[key] = account;
    }
  } catch (e) {
    console.error('Failed to sync reset password locally:', e);
  }
}

async function sendForgotPasswordOtp() {
  const username = document.getElementById('fp-student-id')?.value?.trim().toLowerCase() || '';
  const btn = document.getElementById('fp-send-btn');
  const fields = document.getElementById('fp-reset-fields');

  if (!username) {
    setForgotPasswordMessage('error', 'Enter your Student ID or registered university email first.');
    return;
  }

  if (getCanonicalStaffKey(username)) {
    setForgotPasswordMessage('error', 'Password reset is only for student accounts.');
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sending...';
    }
    setForgotPasswordMessage('ok', 'Sending OTP...');
    const response = await apiSendPasswordResetOtp(username);
    if (fields) fields.style.display = 'block';
    if (response && response.devOtp) {
      setForgotPasswordMessage('ok', `Development OTP: ${response.devOtp}. Use this code to continue.`);
    } else {
      setForgotPasswordMessage('ok', 'OTP sent to your registered university email. Check your inbox or Junk Email folder.');
    }
    const codeEl = document.getElementById('fp-code');
    if (codeEl) codeEl.focus();
  } catch (err) {
    setForgotPasswordMessage('error', err || 'Failed to send OTP.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send OTP';
    }
  }
}

async function resetForgotPassword() {
  const username = document.getElementById('fp-student-id')?.value?.trim().toLowerCase() || '';
  const code = document.getElementById('fp-code')?.value?.trim() || '';
  const pw = document.getElementById('fp-pw')?.value || '';
  const pw2 = document.getElementById('fp-pw2')?.value || '';
  const btn = document.getElementById('fp-reset-btn');

  if (!username || !code || !pw || !pw2) {
    setForgotPasswordMessage('error', 'Fill in the Student ID, OTP, and new password fields.');
    return;
  }
  if (!/^[0-9]{8}$/.test(code)) {
    setForgotPasswordMessage('error', 'Enter the 8-digit OTP sent to your university email.');
    return;
  }
  if (pw.length < 6) {
    setForgotPasswordMessage('error', 'Password must be at least 6 characters.');
    return;
  }
  if (pw !== pw2) {
    setForgotPasswordMessage('error', 'Passwords do not match.');
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Resetting...';
    }
    setForgotPasswordMessage('ok', 'Verifying OTP...');
    const response = await apiVerifyPasswordResetOtp(username, code, pw);
    syncForgotPasswordLocalAccount(username, pw, response?.user);
    setForgotPasswordMessage('ok', 'Password reset successful. Redirecting to sign in...');
    setTimeout(() => {
      goLogin();
      const loginId = document.getElementById('login-id');
      const loginPw = document.getElementById('login-pw');
      if (loginId) loginId.value = String(response?.user?.username || response?.user?.student_id || username).toLowerCase();
      if (loginPw) loginPw.value = '';
    }, 900);
  } catch (err) {
    setForgotPasswordMessage('error', err || 'Password reset failed.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reset Password';
    }
  }
}

let presenceHeartbeatInterval = null;

function stopPresenceHeartbeat() {
  if (presenceHeartbeatInterval) {
    clearInterval(presenceHeartbeatInterval);
    presenceHeartbeatInterval = null;
  }
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();

  if (typeof apiSetPresence !== 'function') {
    return;
  }

  presenceHeartbeatInterval = setInterval(() => {
    apiSetPresence(true).catch(() => {
      // Keep UI working even if backend presence sync is unavailable.
    });
  }, 15000);
}

function roleLabelFromRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'student') return 'Student';
  if (r === 'accounting') return 'Accounting';
  if (r === 'registrar') return 'Registrar';
  if (r === 'faculty') return 'Registrar';
  if (r === 'admin') return 'Admin';
  return 'Student';
}

function setUserActiveSession(loginUsername, userData) {
  if (typeof loadUsers === 'function') {
    loadUsers();
  }

  const uname = String(loginUsername || userData?.username || '').toLowerCase();
  const candidateIds = [userData?.student_id, userData?.id].filter(Boolean).map((v) => String(v));

  let idx = USERS.findIndex((u) => {
    const byUname = uname && String(u.uname || '').toLowerCase() === uname;
    const byId = candidateIds.includes(String(u.id || ''));
    return byUname || byId;
  });

  if (idx < 0 && userData) {
    const fullName = userData.full_name || userData.name || uname || 'User';
    const names = fullName.trim().split(/\s+/);
    const ini = ((names[0]?.[0] || 'U') + (names[1]?.[0] || '')).toUpperCase();
    const roleLabel = roleLabelFromRole(userData.role);
    const isStudent = roleLabel === 'Student';
    USERS.unshift({
      name: fullName,
      id: userData.student_id || userData.id || uname,
      role: roleLabel,
      ini,
      bg: isStudent ? 'rgba(26,162,96,0.15)' : 'rgba(37,99,235,0.15)',
      col: isStudent ? '#15803d' : '#1d4ed8',
      status: 'Inactive',
      activeSince: '',
      lastSeenAt: '',
      isNew: false,
      email: userData.email || '',
      course: userData.course || '',
      year: userData.year_level || userData.year || '',
      uname: uname || String(userData.student_id || userData.id || '').toLowerCase(),
      joinDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    });
    idx = 0;
  }

  if (idx >= 0) {
    USERS[idx].status = 'Active';
    USERS[idx].activeSince = new Date().toISOString();
    USERS[idx].lastSeenAt = '';
    if (typeof saveUsers === 'function') {
      saveUsers();
    }
  }
}

function setCurrentUserInactiveSession() {
  if (!currentUser) {
    return;
  }

  if (typeof loadUsers === 'function') {
    loadUsers();
  }

  const uname = String(currentUser.username || currentUser.id || '').toLowerCase();
  const candidateIds = [currentUser.student_id, currentUser.id].filter(Boolean).map((v) => String(v));

  const idx = USERS.findIndex((u) => {
    const byUname = uname && String(u.uname || '').toLowerCase() === uname;
    const byId = candidateIds.includes(String(u.id || ''));
    return byUname || byId;
  });

  if (idx >= 0) {
    USERS[idx].status = 'Inactive';
    USERS[idx].activeSince = '';
    USERS[idx].lastSeenAt = new Date().toISOString();
    if (typeof saveUsers === 'function') {
      saveUsers();
    }
  }
}

function clearPasswordMismatchError() {
  const pwEl = document.getElementById('r-pw');
  const pw2El = document.getElementById('r-pw2');
  const matchEl = document.getElementById('r-pw-match-error');

  if (pwEl) pwEl.classList.remove('field-invalid');
  if (pw2El) pw2El.classList.remove('field-invalid');
  if (matchEl) matchEl.style.display = 'none';
}

function showPasswordMismatchError() {
  const errEl = document.getElementById('reg-err');
  const pwEl = document.getElementById('r-pw');
  const pw2El = document.getElementById('r-pw2');
  const matchEl = document.getElementById('r-pw-match-error');

  if (pwEl) pwEl.classList.add('field-invalid');
  if (pw2El) {
    pw2El.classList.add('field-invalid');
    pw2El.focus();
  }
  if (matchEl) matchEl.style.display = 'block';
  if (errEl) {
    errEl.textContent = 'Passwords do not match. Please make both password fields the same.';
    errEl.style.display = 'block';
  }
}

try {
  ['r-pw', 'r-pw2'].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
      const pw = document.getElementById('r-pw')?.value || '';
      const pw2 = document.getElementById('r-pw2')?.value || '';
      if (!pw || !pw2 || pw === pw2) {
        clearPasswordMismatchError();
      }
    });
  });
} catch (e) {}

function doRegister() {
  const fn = document.getElementById('r-fn').value.trim();
  const ln = document.getElementById('r-ln').value.trim();
  const sid = document.getElementById('r-sid').value.trim();
  const email = document.getElementById('r-email').value.trim();
  const course = document.getElementById('r-course').value;
  const year = document.getElementById('r-year').value;
  const pw = document.getElementById('r-pw').value;
  const pw2 = document.getElementById('r-pw2').value;
  const errEl = document.getElementById('reg-err');
  const okEl = document.getElementById('reg-ok');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  clearPasswordMismatchError();
  if (!fn || !ln || !sid || !email || !course || !year || !pw || !pw2) {
    errEl.textContent = '✕ Please fill in all required fields.';
    errEl.style.display = 'block';
    return;
  }
  if (pw.length < 6) {
    errEl.textContent = '✕ Password must be at least 6 characters.';
    errEl.style.display = 'block';
    return;
  }
  if (pw !== pw2) {
    showPasswordMismatchError();
    return;
  }

  const loginKey = sid.toLowerCase();
  const fullName = fn + ' ' + ln;
  const ini = (fn[0] + (ln[0] || '')).toUpperCase();

  // Check if already exists
  if (ACCOUNTS[loginKey]) {
    errEl.textContent = '✕ Student ID "' + sid + '" is already registered.';
    errEl.style.display = 'block';
    return;
  }

  // Create account object
  const newAccount = {
    password: pw,
    role: 'student',
    name: fullName,
    id: sid,
    ini,
    bg: 'rgba(26,162,96,0.2)',
    col: '#1AA260',
    isNew: true,
    course,
    year,
    email
  };

  // Cross-browser persistence requires backend save (Supabase).
  if (typeof apiRegister === 'undefined') {
    errEl.textContent = '✕ Server API not available. Please run the backend first.';
    errEl.style.display = 'block';
    return;
  }

  // Enforce university email domain client-side before OTP
  const lowerEmail = String(email).toLowerCase();
  if (!lowerEmail.endsWith('@uv.edu.ph')) {
    errEl.textContent = '✕ Registration requires a university email ending with @uv.edu.ph';
    errEl.style.display = 'block';
    return;
  }

  // Persist pending registration locally until OTP verification completes
  const pending = {
    full_name: fullName,
    first_name: fn,
    last_name: ln,
    student_id: sid,
    email: lowerEmail,
    course: course,
    year_level: year,
    password: pw
  };
  localStorage.setItem('pendingRegistration', JSON.stringify(pending));

  // Start OTP via Supabase (frontend-only). otp.js exposes showOtpScreenFor.
  try {
    // Show OTP UI and trigger sending
    showOtpScreenFor(lowerEmail);
  } catch (e) {
    errEl.textContent = '✕ Failed to start OTP flow. Check Supabase configuration.';
    errEl.style.display = 'block';
    console.error('OTP start error:', e);
  }
}

// Send OTP from the registration form (Send OTP button)
async function sendOtpFromForm() {
  const fn = document.getElementById('r-fn').value.trim();
  const ln = document.getElementById('r-ln').value.trim();
  const sid = document.getElementById('r-sid').value.trim();
  const email = document.getElementById('r-email').value.trim();
  const pw = document.getElementById('r-pw').value;
  const pw2 = document.getElementById('r-pw2').value;
  const errEl = document.getElementById('reg-err');
  const okEl = document.getElementById('reg-ok');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  clearPasswordMismatchError();

  if (!fn || !ln || !sid || !email || !pw || !pw2) {
    errEl.textContent = '✕ Please fill First Name, Last Name, Student ID, Email and Password before sending OTP.';
    errEl.style.display = 'block';
    return;
  }
  if (pw.length < 6) {
    errEl.textContent = '✕ Password must be at least 6 characters.';
    errEl.style.display = 'block';
    return;
  }
  if (pw !== pw2) {
    showPasswordMismatchError();
    return;
  }

  const lowerEmail = String(email).toLowerCase();
  if (!lowerEmail.endsWith('@uv.edu.ph')) {
    errEl.textContent = '✕ OTP can only be sent to university email addresses ending with @uv.edu.ph';
    errEl.style.display = 'block';
    return;
  }

  // Persist pending registration locally until OTP verification completes
  const pending = {
    full_name: fn + ' ' + ln,
    first_name: fn,
    last_name: ln,
    student_id: sid,
    email: lowerEmail,
    course: document.getElementById('r-course').value,
    year_level: document.getElementById('r-year').value,
    password: pw
  };
  try {
    localStorage.setItem('pendingRegistration', JSON.stringify(pending));
  } catch (e) {
    console.error('Failed to save pending registration:', e);
  }
  const sendBtn = document.getElementById('r-send-otp');
  // Start UI and attempt send; disable send button with cooldown to prevent spam
  try {
    // Temporarily disable the button to avoid double-clicks while awaiting result
    if (sendBtn) {
      sendBtn.disabled = true;
    }

    // showOtpScreenFor returns the resend promise; await it to know if send succeeded
    const sendPromise = showOtpScreenFor(lowerEmail);
    await sendPromise;

    // On success, start the cooldown (persisted)
    startSendOtpCooldown(30);
  } catch (e) {
    // Re-enable immediately on failure
    console.error('OTP start error (send button):', e);
    if (sendBtn) {
      sendBtn.disabled = false;
      const orig = sendBtn.getAttribute('data-orig-text') || 'Send OTP';
      sendBtn.textContent = orig;
    }
    errEl.textContent = '✕ Failed to start OTP flow. Check Supabase configuration.';
    errEl.style.display = 'block';
  }
}

// Cooldown helpers for the Send OTP button
let __sendOtpTimer = null;
function startSendOtpCooldown(seconds) {
  const btn = document.getElementById('r-send-otp');
  if (!btn) return;
  const orig = btn.getAttribute('data-orig-text') || btn.textContent;
  btn.setAttribute('data-orig-text', orig);
  const until = Date.now() + seconds * 1000;
  try { localStorage.setItem('sendOtpCooldownUntil', String(until)); } catch (e) {}
  btn.disabled = true;
  updateSendOtpButton();
  if (__sendOtpTimer) clearInterval(__sendOtpTimer);
  __sendOtpTimer = setInterval(updateSendOtpButton, 1000);
}

function stopSendOtpCooldown() {
  const btn = document.getElementById('r-send-otp');
  if (!btn) return;
  if (__sendOtpTimer) {
    clearInterval(__sendOtpTimer);
    __sendOtpTimer = null;
  }
  try { localStorage.removeItem('sendOtpCooldownUntil'); } catch (e) {}
  btn.disabled = false;
  const orig = btn.getAttribute('data-orig-text') || 'Send OTP';
  btn.textContent = orig;
}

function updateSendOtpButton() {
  const btn = document.getElementById('r-send-otp');
  if (!btn) return;
  const raw = localStorage.getItem('sendOtpCooldownUntil');
  if (!raw) {
    stopSendOtpCooldown();
    return;
  }
  const until = Number(raw) || 0;
  const remainingMs = until - Date.now();
  if (remainingMs <= 0) {
    stopSendOtpCooldown();
    return;
  }
  const s = Math.ceil(remainingMs / 1000);
  btn.disabled = true;
  btn.textContent = `Send OTP (${s}s)`;
}

// Initialize button state on load
try { updateSendOtpButton(); } catch (e) {}

function doLogin() {
  const uname = document.getElementById('login-id').value.trim().toLowerCase();
  const pw = document.getElementById('login-pw').value;
  const errEl = document.getElementById('login-error');

  const resolveAccountKey = (loginValue) => {
    const raw = String(loginValue || '').trim().toLowerCase();
    if (!raw) {
      return '';
    }
    const canonicalByRole = {
      accounting: 'accounting.office',
      registrar: 'registrar.office',
      admin: 'admin'
    };
    if (ACCOUNTS[raw]) {
      const ownRole = String(ACCOUNTS[raw]?.role || '').toLowerCase();
      return canonicalByRole[ownRole] || raw;
    }
    const found = Object.keys(ACCOUNTS).find((key) => {
      const acc = ACCOUNTS[key];
      return String(acc?.id || '').toLowerCase() === raw;
    });
    if (!found) {
      return raw;
    }
    const foundRole = String(ACCOUNTS[found]?.role || '').toLowerCase();
    return canonicalByRole[foundRole] || found;
  };

  const accountKey = resolveAccountKey(uname);

  // For staff accounts, attempt backend login first; fall back to local auth if backend is unavailable.
  const localAcc = ACCOUNTS[accountKey];
  const localRole = String(localAcc?.role || '').toLowerCase();
  // Intentionally do NOT return here so the shared backend-first flow below runs for staff as well.
  // If backend login fails it will call doLoginLocal(accountKey, pw, errEl) as a fallback.

  if (typeof isDeletedUserRecord === 'function' && isDeletedUserRecord(null, uname)) {
    errEl.style.display = 'block';
    errEl.textContent = '✕ This account has been permanently deleted.';
    document.getElementById('login-pw').value = '';
    errEl.textContent = 'Error: This account has been permanently deleted.';
    return;
  }

  // Prefer the structured API helper so invalid credentials stop cleanly
  if (typeof apiLogin === 'function') {
    apiLogin(uname, pw)
      .then((response) => {
        if (typeof isDeletedUserRecord === 'function' && isDeletedUserRecord(response.user, uname)) {
          errEl.style.display = 'block';
          errEl.textContent = '✕ This account has been permanently deleted.';
          document.getElementById('login-pw').value = '';
          errEl.textContent = 'Error: This account has been permanently deleted.';
          if (typeof apiLogout !== 'undefined') {
            apiLogout();
          }
          return;
        }

        errEl.style.display = 'none';
        currentRole = response.user.role;
        if (currentRole === 'faculty') {
          currentRole = 'registrar';
          response.user.role = 'registrar';
        }
        if (currentRole === 'student') {
          try {
            if (typeof loadUsers === 'function') {
              loadUsers();
            }

            const loginKey = String(uname || '').toLowerCase();
            const backendId = String(response.user.student_id || response.user.id || '');
            const userInList = USERS.find((u) => {
              const byId = backendId && String(u.id || '') === backendId;
              const byUname = loginKey && String(u.uname || '').toLowerCase() === loginKey;
              return byId || byUname;
            });

            if (userInList) {
              response.user.full_name = userInList.name || response.user.full_name;
              response.user.name = userInList.name || response.user.name;
              response.user.email = userInList.email || response.user.email || '';
              response.user.course = userInList.course || response.user.course || '';
              response.user.year_level = userInList.year || response.user.year_level || response.user.year || '';
              response.user.year = response.user.year_level;
              response.user.id = userInList.id || response.user.id;
              response.user.student_id = userInList.id || response.user.student_id || response.user.id;
            }

            if (loginKey) {
              const existing = ACCOUNTS[loginKey] || {};
              ACCOUNTS[loginKey] = {
                ...existing,
                password: existing.password || pw,
                role: 'student',
                name: response.user.full_name || response.user.name || existing.name || 'Student',
                id: response.user.student_id || response.user.id || existing.id || loginKey,
                ini: existing.ini || ((response.user.full_name || response.user.name || 'S').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || 'ST'),
                bg: existing.bg || 'rgba(26,162,96,0.2)',
                col: existing.col || '#1AA260',
                isNew: !!existing.isNew,
                course: response.user.course || existing.course || '',
                year: response.user.year_level || response.user.year || existing.year || '',
                email: response.user.email || existing.email || ''
              };

              if (typeof saveStudentRegistration === 'function') {
                saveStudentRegistration(loginKey, ACCOUNTS[loginKey]);
              }
            }
          } catch (e) {
            console.error('Student profile sync failed during backend login:', e);
          }
        }

        currentUser = { ...response.user, username: accountKey, uname: accountKey };
        setUserActiveSession(accountKey, response.user);

        // Save session to localStorage and refresh announcements when a backend token is present
        try {
          if (response.token) localStorage.setItem('authToken', response.token);
          localStorage.setItem('currentUser', JSON.stringify(response.user));
          try {
            if (response.token && typeof loadAnnouncements === 'function') {
              loadAnnouncements();
            }
          } catch (e) {}
        } catch (e) {
          console.error('Failed to persist session:', e);
        }

        // Update shared presence so admin can see active state across browsers.
        if (typeof apiSetPresence === 'function') {
          apiSetPresence(true).catch((e) => console.log('Presence update skipped:', e.message));
        }
        startPresenceHeartbeat();

        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-screen').style.display = 'block';
        document.getElementById('tb-username').textContent = getDisplayName(currentUser);
        updateTopbarAvatar();
        document.getElementById('role-pill').textContent = {
          student: 'Student',
          accounting: 'Accounting',
          registrar: 'Registrar',
          admin: 'Admin'
        }[response.user.role];
        buildSidebar();
        activeFilter = 'All';
        searchQuery = '';
        showPage(NAVS[currentRole][0].id);

        // For admin, sync Users page from backend (Supabase) when available.
        if (response.user.role === 'admin' && typeof syncUsersFromBackend === 'function') {
          syncUsersFromBackend().then((changed) => {
            if (changed && currentPageId === 'ad-users') {
              showPage('ad-users');
            }
          });
        }
      })
      .catch((error) => {
        if (shouldFallbackToLocalAuth(error)) {
          console.warn('Backend login unavailable, falling back to local auth:', error && error.message ? error.message : error);
          doLoginLocal(accountKey, pw, errEl);
          return;
        }
        errEl.style.display = 'block';
        errEl.textContent = 'âœ• ' + getLoginFailureMessage(uname);
        document.getElementById('login-pw').value = '';
        errEl.textContent = 'Error: ' + getLoginFailureMessage(uname);
      });
    return;
  }

  // Legacy fallback if the structured API helper is unavailable
  if (typeof backendRequest !== 'undefined') {
    backendRequest('/auth/login', { method: 'POST', body: { username: uname, password: pw } })
      .then((response) => {
        // reuse existing success handling (delegate to original flow)
        if (typeof isDeletedUserRecord === 'function' && isDeletedUserRecord(response.user, uname)) {
          errEl.style.display = 'block';
          errEl.textContent = '✕ This account has been permanently deleted.';
          document.getElementById('login-pw').value = '';
          errEl.textContent = 'Error: This account has been permanently deleted.';
          if (typeof apiLogout !== 'undefined') {
            apiLogout();
          }
          return;
        }

        errEl.style.display = 'none';
        currentRole = response.user.role;
        if (currentRole === 'faculty') {
          currentRole = 'registrar';
          response.user.role = 'registrar';
        }
        if (currentRole === 'student') {
          try {
            if (typeof loadUsers === 'function') {
              loadUsers();
            }

            const loginKey = String(uname || '').toLowerCase();
            const backendId = String(response.user.student_id || response.user.id || '');
            const userInList = USERS.find((u) => {
              const byId = backendId && String(u.id || '') === backendId;
              const byUname = loginKey && String(u.uname || '').toLowerCase() === loginKey;
              return byId || byUname;
            });

            if (userInList) {
              response.user.full_name = userInList.name || response.user.full_name;
              response.user.name = userInList.name || response.user.name;
              response.user.email = userInList.email || response.user.email || '';
              response.user.course = userInList.course || response.user.course || '';
              response.user.year_level = userInList.year || response.user.year_level || response.user.year || '';
              response.user.year = response.user.year_level;
              response.user.id = userInList.id || response.user.id;
              response.user.student_id = userInList.id || response.user.student_id || response.user.id;
            }

            if (loginKey) {
              const existing = ACCOUNTS[loginKey] || {};
              ACCOUNTS[loginKey] = {
                ...existing,
                password: existing.password || pw,
                role: 'student',
                name: response.user.full_name || response.user.name || existing.name || 'Student',
                id: response.user.student_id || response.user.id || existing.id || loginKey,
                ini: existing.ini || ((response.user.full_name || response.user.name || 'S').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || 'ST'),
                bg: existing.bg || 'rgba(26,162,96,0.2)',
                col: existing.col || '#1AA260',
                isNew: !!existing.isNew,
                course: response.user.course || existing.course || '',
                year: response.user.year_level || response.user.year || existing.year || '',
                email: response.user.email || existing.email || ''
              };

              if (typeof saveStudentRegistration === 'function') {
                saveStudentRegistration(loginKey, ACCOUNTS[loginKey]);
              }
            }
          } catch (e) {
            console.error('Student profile sync failed during backend login:', e);
          }
        }

        currentUser = { ...response.user, username: accountKey, uname: accountKey };
        setUserActiveSession(accountKey, response.user);
        
        // Save session to localStorage and refresh announcements when a backend token is present
        try {
          localStorage.setItem('currentUser', JSON.stringify(response.user));
          if (response.token) {
            localStorage.setItem('authToken', response.token);
            try { if (typeof loadAnnouncements === 'function') loadAnnouncements(); } catch (e) {}
          } else {
            localStorage.setItem('authToken', response.token || 'backend-token');
          }
        } catch (e) {
          console.error('Failed to persist session:', e);
        }

        // Update shared presence so admin can see active state across browsers.
        if (typeof apiSetPresence === 'function') {
          apiSetPresence(true).catch((e) => console.log('Presence update skipped:', e.message));
        }
        startPresenceHeartbeat();
        
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-screen').style.display = 'block';
        document.getElementById('tb-username').textContent = getDisplayName(currentUser);
        updateTopbarAvatar();
        document.getElementById('role-pill').textContent = {
          student: 'Student',
          accounting: 'Accounting',
          registrar: 'Registrar',
          admin: 'Admin'
        }[response.user.role];
        buildSidebar();
        activeFilter = 'All';
        searchQuery = '';
        showPage(NAVS[currentRole][0].id);

        // For admin, sync Users page from backend (Supabase) when available.
        if (response.user.role === 'admin' && typeof syncUsersFromBackend === 'function') {
          syncUsersFromBackend().then((changed) => {
            if (changed && currentPageId === 'ad-users') {
              showPage('ad-users');
            }
          });
        }
      })
      .catch((error) => {
        if (shouldFallbackToLocalAuth(error)) {
          doLoginLocal(accountKey, pw, errEl);
          return;
        }
        errEl.style.display = 'block';
        errEl.textContent = 'âœ• ' + getLoginFailureMessage(uname);
        document.getElementById('login-pw').value = '';
        errEl.textContent = 'Error: ' + getLoginFailureMessage(uname);
      });
  } else {
    // Use local authentication
    doLoginLocal(accountKey, pw, errEl);
  }
}

function getLoginFailureMessage(username) {
  const key = typeof getCanonicalStaffKey === 'function' ? getCanonicalStaffKey(username) : '';
  return key ? 'Invalid username or password.' : 'Invalid Student ID or password.';
}

function shouldFallbackToLocalAuth(error) {
  if (!error) {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  const status = Number(error.status || 0);
  if (!status) {
    return true;
  }

  if (status === 404) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('could not reach backend') ||
    message.includes('backend route is not available') ||
    message.includes('server currently handling your request')
  );
}

function doLoginLocal(uname, pw, errEl) {
  // CRITICAL: Reload all student data from localStorage before login
  try {
    if (typeof loadStaffAccounts === 'function') {
      loadStaffAccounts();
    }
    if (typeof loadRegisteredStudents === 'function') {
      loadRegisteredStudents();
    }
    if (typeof loadUsers === 'function') {
      loadUsers();
    }
  } catch (e) {
    console.error('Error loading data before login:', e);
  }

  if (typeof isDeletedUserRecord === 'function' && isDeletedUserRecord(null, uname)) {
    errEl.style.display = 'block';
    errEl.textContent = '✕ This account has been permanently deleted.';
    document.getElementById('login-pw').value = '';
    errEl.textContent = 'Error: This account has been permanently deleted.';
    return;
  }
  
  const acc = ACCOUNTS[uname];
  const role = String(acc?.role || '').toLowerCase();
  if (['accounting', 'registrar', 'admin'].includes(role) && typeof isLegacyStaffPassword === 'function' && isLegacyStaffPassword(uname, pw)) {
    errEl.style.display = 'block';
    errEl.textContent = '✕ ' + getLoginFailureMessage(uname);
    document.getElementById('login-pw').value = '';
    errEl.textContent = 'Error: ' + getLoginFailureMessage(uname);
    console.error('Blocked legacy staff password for:', uname);
    return;
  }

  const expectedPw = (['accounting', 'registrar', 'admin'].includes(role) && typeof getStaffExpectedPassword === 'function')
    ? getStaffExpectedPassword(uname)
    : String(acc?.password || '');
  if (!acc || expectedPw !== pw) {
    errEl.style.display = 'block';
    errEl.textContent = '✕ ' + getLoginFailureMessage(uname);
    document.getElementById('login-pw').value = '';
    errEl.textContent = 'Error: ' + getLoginFailureMessage(uname);
    console.error('Login failed for:', uname);
    return;
  }
  errEl.style.display = 'none';
  currentRole = acc.role;
  if (currentRole === 'faculty') {
    currentRole = 'registrar';
  }
  currentUser = { ...acc, username: uname }; // Use a copy to avoid mutations
  currentUser.role = currentRole;
  setUserActiveSession(uname, currentUser);
  startPresenceHeartbeat();
  
  // Mark user as Active in USERS list when they successfully log in
  const userInUsersList = USERS.find(u => u.id === currentUser.id);
  if (userInUsersList && userInUsersList.status !== 'Active') {
    userInUsersList.status = 'Active';
    if (typeof saveUsers === 'function') {
      saveUsers();
    }
  }
  
  // Sync with USERS list to get latest profile data
  if (currentRole === 'student') {
    const userInList = USERS.find(u => u.id === currentUser.id);
    if (userInList) {
      currentUser.name = userInList.name;
      currentUser.email = userInList.email;
      currentUser.course = userInList.course;
      currentUser.year = userInList.year;
    }
    
    // Check if user has a photo under a different ID (UUID vs numeric)
    // Look for any photo and migrate it to the current ID
    try {
      const allPhotoIds = Object.keys(profilePhotos);
      if (allPhotoIds.length > 0 && !profilePhotos[currentUser.id]) {
        // Student has never uploaded a photo with this ID, check if they have one with an old ID
        for (const photoId of allPhotoIds) {
          if (photoId !== currentUser.id) {
            console.log('Found photo with old ID, migrating:', photoId, '→', currentUser.id);
            if (typeof migrateProfilePhoto === 'function') {
              migrateProfilePhoto(photoId, currentUser.id);
            }
            break;
          }
        }
      }
    } catch (e) {
      console.error('Error during photo migration:', e);
      // Continue login even if photo migration fails
    }
  }
  
  // Save session to localStorage
  try {
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    localStorage.setItem('authToken', 'local-' + uname);
  } catch (e) {
    console.error('Error saving auth session:', e);
    errEl.style.display = 'block';
    errEl.textContent = '✕ Error saving session. Please try again.';
    return;
  }
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('tb-username').textContent = getDisplayName(currentUser);
  updateTopbarAvatar();
  document.getElementById('role-pill').textContent = {
    student: 'Student',
    accounting: 'Accounting',
    registrar: 'Registrar',
    admin: 'Admin'
  }[currentRole];
  buildSidebar();
  activeFilter = 'All';
  searchQuery = '';
  showPage(NAVS[currentRole][0].id);
}

async function doLogout() {
  setCurrentUserInactiveSession();
  stopPresenceHeartbeat();

  if (typeof apiSetPresence === 'function') {
    try {
      await apiSetPresence(false);
    } catch (e) {
      console.log('Presence update skipped:', e.message);
    }
  }

  if (typeof saveUsers === 'function') {
    saveUsers();
  }
  if (typeof apiLogout !== 'undefined') {
    apiLogout();
  }
  // CRITICAL: Always clear auth data first before anything else
  try {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('authToken');
  } catch (e) {
    console.error('Error clearing auth data:', e);
  }
  
  // Clear UI
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('register-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-id').value = '';
  document.getElementById('login-pw').value = '';
  document.getElementById('login-error').style.display = 'none';
  
  // Clear session state
  currentUser = null;
  currentRole = 'student';
  currentPageId = 's-dash';
}
