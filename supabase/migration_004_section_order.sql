-- FonoIA — orden del índice de secciones para la generación de informes
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

alter table public.report_templates add column if not exists section_order jsonb;
