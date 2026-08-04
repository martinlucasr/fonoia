-- FonoIA — bucket de Storage para guardar el archivo original de cada adjunto
-- (hasta ahora solo guardábamos el texto extraído, no el PDF/Word en sí)
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy "Users can upload their own attachments"
  on storage.objects for insert
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can view their own attachments"
  on storage.objects for select
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own attachments"
  on storage.objects for delete
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
