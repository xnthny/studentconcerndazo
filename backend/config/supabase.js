// Supabase configuration
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// Create Supabase client (anon)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Optional: Service role key for admin operations (server-side)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let supabaseAdmin = null;
if (!supabaseServiceKey) {
	console.warn('SUPABASE_SERVICE_ROLE_KEY is not set. Server-side operations that require bypassing RLS (announcement_reads upserts) will fail. Add SUPABASE_SERVICE_ROLE_KEY to your Render environment variables using the Supabase project Service Role Key.');
} else {
	try {
		supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
		console.info('Supabase admin client initialized');
	} catch (e) {
		console.warn('Failed to create Supabase admin client:', e.message);
		supabaseAdmin = null;
	}
}

module.exports = { supabase, supabaseAnonKey, supabaseServiceKey, supabaseAdmin, supabaseUrl };
