// Supabase configuration
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// Create Supabase client (anon)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Optional: Service role key for admin operations (server-side)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let supabaseAdmin = null;
if (supabaseServiceKey) {
	try {
		supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
	} catch (e) {
		console.warn('Failed to create Supabase admin client:', e.message);
		supabaseAdmin = null;
	}
}

module.exports = { supabase, supabaseServiceKey, supabaseAdmin, supabaseUrl };
