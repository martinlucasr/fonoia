-- FonoIA — plantilla de informe personalizada por fonoaudiólogo
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

create table if not exists public.report_templates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  template_text text,
  filename text,
  updated_at timestamptz not null default now()
);

alter table public.report_templates enable row level security;

create policy "Users can view their own report template"
  on public.report_templates for select
  using (auth.uid() = user_id);

create policy "Users can insert their own report template"
  on public.report_templates for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own report template"
  on public.report_templates for update
  using (auth.uid() = user_id);

create policy "Users can delete their own report template"
  on public.report_templates for delete
  using (auth.uid() = user_id);
