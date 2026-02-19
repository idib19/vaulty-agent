-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Creates the agent_daily_usage table for rate-limiting agent API calls.

create table if not exists agent_daily_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  used_at    date not null default current_date,
  endpoint   text not null check (endpoint in ('fill', 'copilot')),
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_daily_user_date
  on agent_daily_usage (user_id, used_at);

-- RLS: only the service role (your backend) can insert/read.
-- The anon key with the user's JWT can also read their own rows.
alter table agent_daily_usage enable row level security;

create policy "Users can read own usage"
  on agent_daily_usage for select
  using (auth.uid() = user_id);

create policy "Authenticated users can insert own usage"
  on agent_daily_usage for insert
  with check (auth.uid() = user_id);
