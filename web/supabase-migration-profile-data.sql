-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Adds a profile_data JSONB column to user_profiles for storing
-- the extension agent profile (name, address, EEO, links, etc.).

alter table public.user_profiles
  add column if not exists profile_data jsonb not null default '{}';
