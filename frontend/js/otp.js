// OTP UI and flow helpers (server-verified)

function showOtpScreenFor(email) {
  // Persist pending registration and show OTP screen
  try {
    const pending = JSON.parse(localStorage.getItem('pendingRegistration') || 'null');
    if (!pending || pending.email !== email) {
      // leave as-is; pending should already be set by doRegister
    }
  } catch (e) {}

  // Hide register, show OTP UI
  const reg = document.getElementById('register-screen');
  if (reg) reg.style.display = 'none';

  let otp = document.getElementById('otp-screen');
  if (!otp) {
    // Create minimal OTP card if not present
    otp = document.createElement('div');
    otp.id = 'otp-screen';
    otp.className = 'auth-bg';
    otp.style.display = 'flex';
    otp.innerHTML = `
      <div class="auth-card" style="width:420px;max-width:100%;margin:auto;">
        <div class="auth-title">Verify Your University Email</div>
        <div class="auth-sub">Enter the 8-digit code sent to your university email. Check Junk Email if it is not in your inbox.</div>
        <div class="auth-divider"></div>
        <div class="err-box" id="otp-err" style="display:none"></div>
        <div class="ok-box" id="otp-ok" style="display:none"></div>
        <div class="fg"><label class="fl">University Email</label><input class="fi" id="otp-email-display" readonly/></div>
        <div class="fg"><label class="fl">One-time code (8 digits)</label><input class="fi" id="otp-code" maxlength="8" inputmode="numeric" pattern="\\d{8}" placeholder="Enter 8-digit code"/></div>
        <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn-main" id="otp-verify-btn">Verify</button><button class="btn" id="otp-back-btn">Back</button><button class="btn" id="otp-resend-btn">Resend OTP</button></div>
        <div style="margin-top:8px;font-size:12px;color:var(--n500);" id="otp-info"></div>
      </div>`;
    document.body.appendChild(otp);

    document.getElementById('otp-back-btn').addEventListener('click', () => {
      // Show register again
      const r = document.getElementById('register-screen');
      if (r) r.style.display = 'flex';
      otp.style.display = 'none';
    });

    document.getElementById('otp-verify-btn').addEventListener('click', async () => {
      const code = ((document.getElementById('otp-code') || {}).value || '').trim();
      const emailVal = ((document.getElementById('otp-email-display') || {}).value || '').trim().toLowerCase();
      const errEl = document.getElementById('otp-err');
      errEl.style.display = 'none';
      // Expect exactly 8 numeric digits
      if (!/^[0-9]{8}$/.test(code)) {
        errEl.textContent = '✕ Please enter the 8-digit code sent to your university email.';
        errEl.style.display = 'block';
        return;
      }

      try {
        document.getElementById('otp-verify-btn').disabled = true;
        document.getElementById('otp-info').textContent = 'Verifying…';

        const pending = JSON.parse(localStorage.getItem('pendingRegistration') || 'null');
        if (!pending) throw new Error('Pending registration data not found');

        // Call server endpoint to verify OTP and finalize registration
        const resp = await apiVerifyOtpAndRegister(emailVal, code, pending);
        if (!resp || resp.error) {
          throw new Error((resp && resp.message) || (resp && resp.error) || 'Verification failed');
        }

        // Clear pending
        localStorage.removeItem('pendingRegistration');
        document.getElementById('otp-ok').textContent = '✓ Email verified and account created. Redirecting…';
        document.getElementById('otp-ok').style.display = 'block';
        document.getElementById('otp-info').textContent = '';
        setTimeout(() => {
          // Go to login screen and prefill username
          if (document.getElementById('otp-screen')) document.getElementById('otp-screen').style.display = 'none';
          if (document.getElementById('register-screen')) document.getElementById('register-screen').style.display = 'none';
          if (document.getElementById('login-screen')) document.getElementById('login-screen').style.display = 'flex';
          if (document.getElementById('login-id')) document.getElementById('login-id').value = pending.student_id.toLowerCase();
        }, 1400);
      } catch (err) {
        const msg = err?.message || String(err || 'Verification failed');
        const e = document.getElementById('otp-err');
        e.textContent = '✕ ' + msg;
        e.style.display = 'block';
        document.getElementById('otp-info').textContent = '';
      } finally {
        document.getElementById('otp-verify-btn').disabled = false;
      }
    });

    document.getElementById('otp-resend-btn').addEventListener('click', async () => {
      const emailVal = (document.getElementById('otp-email-display') || {}).value || '';
      await resendOtpFlow(emailVal);
    });
    } else {
    otp.style.display = 'flex';
  }

  // Populate email field
  const emailInput = document.getElementById('otp-email-display');
  if (emailInput) emailInput.value = email;

  // Trigger an OTP send when screen is shown
  return resendOtpFlow(email);

  // Autofocus the OTP input when visible
  setTimeout(() => {
    const codeEl = document.getElementById('otp-code');
    if (codeEl) {
      codeEl.focus();
      codeEl.select();
    }
  }, 120);
}

async function resendOtpFlow(email) {
  const errEl = document.getElementById('otp-err');
  errEl.style.display = 'none';
  const info = document.getElementById('otp-info');
  const resendBtn = document.getElementById('otp-resend-btn');
  if (resendBtn) resendBtn.disabled = true;
  try {
  info.textContent = 'Sending OTP…';
  const r = await apiSendOtp(email);
  if (r && r.error) throw r.error;
  info.textContent = 'OTP sent. Check your university email inbox or Junk Email folder.';
    // Cooldown 30s
    let t = 30;
    const origText = resendBtn ? resendBtn.textContent : 'Resend OTP';
    const iv = setInterval(() => {
      if (!resendBtn) return clearInterval(iv);
      t -= 1;
      resendBtn.textContent = `Resend (${t}s)`;
      if (t <= 0) {
        clearInterval(iv);
        resendBtn.disabled = false;
        resendBtn.textContent = origText;
      }
    }, 1000);
  } catch (err) {
    errEl.textContent = '✕ Failed to send OTP. ' + (err?.message || err || '');
    errEl.style.display = 'block';
    if (resendBtn) resendBtn.disabled = false;
    info.textContent = '';
  }
}
