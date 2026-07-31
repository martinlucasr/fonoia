-- FonoIA — permite editar informes guardados y trackear cuándo se modificaron
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

alter table public.reports add column if not exists updated_at timestamptz not null default now();

create policy "Users can update their own reports"
  on public.reports for update
  using (auth.uid() = user_id);
