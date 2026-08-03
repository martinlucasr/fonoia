-- FonoIA — adjuntos (PDF/Word) como archivos separados, no mezclados con el texto
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

alter table public.patients add column if not exists history_attachments jsonb not null default '[]'::jsonb;
alter table public.patients add column if not exists considerations_attachments jsonb not null default '[]'::jsonb;
alter table public.session_notes add column if not exists attachments jsonb not null default '[]'::jsonb;
