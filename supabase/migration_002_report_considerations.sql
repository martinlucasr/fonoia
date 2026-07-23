-- FonoIA — agrega el campo de consideraciones para la generación de informes
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

alter table public.patients add column if not exists report_considerations text;
