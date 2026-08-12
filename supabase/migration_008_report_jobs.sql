-- FonoIA — jobs de generación de informes en segundo plano
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

create table if not exists public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  result text,
  error text,
  used_fallback_model boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.report_jobs enable row level security;

create policy "Users can view their own report jobs"
  on public.report_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own report jobs"
  on public.report_jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own report jobs"
  on public.report_jobs for update
  using (auth.uid() = user_id);

create index if not exists idx_report_jobs_patient_id on public.report_jobs(patient_id);
