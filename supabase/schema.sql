-- FonoIA — esquema inicial
-- Pegar y ejecutar este script completo en Supabase Dashboard > SQL Editor > New query > Run

create extension if not exists "pgcrypto";

-- ==========================================================================
-- Pacientes
-- ==========================================================================
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  birth_date date,
  diagnosis text,
  history text,
  created_at timestamptz not null default now()
);

alter table public.patients enable row level security;

create policy "Users can view their own patients"
  on public.patients for select
  using (auth.uid() = user_id);

create policy "Users can insert their own patients"
  on public.patients for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own patients"
  on public.patients for update
  using (auth.uid() = user_id);

create policy "Users can delete their own patients"
  on public.patients for delete
  using (auth.uid() = user_id);

-- ==========================================================================
-- Notas de sesión
-- ==========================================================================
create table if not exists public.session_notes (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_date date not null default current_date,
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.session_notes enable row level security;

create policy "Users can view their own session notes"
  on public.session_notes for select
  using (auth.uid() = user_id);

create policy "Users can insert their own session notes"
  on public.session_notes for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own session notes"
  on public.session_notes for update
  using (auth.uid() = user_id);

create policy "Users can delete their own session notes"
  on public.session_notes for delete
  using (auth.uid() = user_id);

-- ==========================================================================
-- Informes generados con IA
-- ==========================================================================
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

create policy "Users can view their own reports"
  on public.reports for select
  using (auth.uid() = user_id);

create policy "Users can insert their own reports"
  on public.reports for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own reports"
  on public.reports for delete
  using (auth.uid() = user_id);

-- ==========================================================================
-- Índices
-- ==========================================================================
create index if not exists idx_patients_user_id on public.patients(user_id);
create index if not exists idx_session_notes_patient_id on public.session_notes(patient_id);
create index if not exists idx_session_notes_user_id on public.session_notes(user_id);
create index if not exists idx_reports_patient_id on public.reports(patient_id);
