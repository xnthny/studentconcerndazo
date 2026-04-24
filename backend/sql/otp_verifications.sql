-- Create OTP verifications table for server-managed OTP flow
-- Run in Supabase SQL editor or via psql

create extension if not exists pgcrypto;

create table if not exists public.otp_verifications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  otp_hash text not null,
  purpose text not null default 'registration',
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_otp_verifications_email on public.otp_verifications(email);
create index if not exists idx_otp_verifications_created_at on public.otp_verifications(created_at);
