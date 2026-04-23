// Supabase client initialization for OTP flows
// Minimal safe wiring: only create a browser Supabase client when real config is present.
const SUPABASE_URL = window.SUPABASE_URL || '<REPLACE_WITH_SUPABASE_URL>';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '<REPLACE_WITH_SUPABASE_ANON_KEY>';

function isValidHttpUrl(val) {
  try {
    if (!val || typeof val !== 'string') return false;
    return /^https?:\/\//i.test(val);
  } catch (e) {
    return false;
  }
}

function isPlaceholder(val) {
  return typeof val === 'string' && val.includes('<REPLACE');
}

let supabaseClient = null;
if (isValidHttpUrl(SUPABASE_URL) && SUPABASE_ANON_KEY && !isPlaceholder(SUPABASE_ANON_KEY) && !isPlaceholder(SUPABASE_URL)) {
  try {
    if (window.supabasejs && typeof window.supabasejs.createClient === 'function') {
      supabaseClient = window.supabasejs.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch (e) {
    console.warn('Failed to initialize Supabase client in browser:', e.message);
    supabaseClient = null;
  }
} else {
  console.info('Using backend OTP endpoints; browser Supabase client is disabled.');
}

// Expose client if available
window.supabaseClient = supabaseClient;

// Helper wrappers that prefer backend API endpoints only (no client fallback)
function supabaseSendOtp(email) {
  if (typeof apiSendOtp === 'function') return apiSendOtp(String(email || '').trim().toLowerCase());
  return Promise.reject(new Error('Backend OTP API not available (apiSendOtp)'));
}

function supabaseVerifyOtp(email, token, pending) {
  // This project uses a server-side verify-and-register flow. Use apiVerifyOtpAndRegister.
  if (typeof apiVerifyOtpAndRegister === 'function') return apiVerifyOtpAndRegister(String(email || '').trim().toLowerCase(), String(token || '').trim(), pending || {});
  return Promise.reject(new Error('Backend OTP verify API not available (apiVerifyOtpAndRegister)'));
}

window.supabaseSendOtp = supabaseSendOtp;
window.supabaseVerifyOtp = supabaseVerifyOtp;
