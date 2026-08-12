-- FonoIA — panel de owner: registro de logins + función de estadísticas
-- Pegar y ejecutar en Supabase Dashboard > SQL Editor > New query > Run

-- Se registra un login cada vez que alguien inicia sesión con éxito (no cuenta
-- navegación entre páginas, solo el acto de loguearse).
create table if not exists public.login_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.login_events enable row level security;

create policy "Users can insert their own login events"
  on public.login_events for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own login events"
  on public.login_events for select
  using (auth.uid() = user_id);

create index if not exists idx_login_events_user_id on public.login_events(user_id);

-- Función de estadísticas para el panel de owner. SECURITY DEFINER = corre con
-- privilegios elevados, por eso puede leer auth.users y cruzar todas las tablas
-- sin que le aplique RLS. Por seguridad, se le quita el permiso de ejecución a
-- todos los roles normales (anon, authenticated) y se lo deja SOLO a
-- service_role — es decir, solo se puede llamar con la llave maestra desde el
-- servidor, nunca con la sesión de un usuario común, sin importar quién sea.
create or replace function public.admin_user_stats()
returns table (
  user_id uuid,
  email text,
  full_name text,
  profession text,
  created_at timestamptz,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  patients_count bigint,
  notes_count bigint,
  reports_count bigint,
  reports_error_count bigint,
  login_count bigint,
  login_count_7d bigint,
  login_count_30d bigint
)
language sql
security definer
set search_path = public
as $$
  select
    u.id as user_id,
    u.email,
    u.raw_user_meta_data->>'full_name' as full_name,
    u.raw_user_meta_data->>'profession' as profession,
    u.created_at,
    u.confirmed_at,
    u.last_sign_in_at,
    (select count(*) from patients p where p.user_id = u.id) as patients_count,
    (select count(*) from session_notes n where n.user_id = u.id) as notes_count,
    (select count(*) from reports r where r.user_id = u.id) as reports_count,
    (select count(*) from report_jobs j where j.user_id = u.id and j.status = 'error') as reports_error_count,
    (select count(*) from login_events l where l.user_id = u.id) as login_count,
    (select count(*) from login_events l where l.user_id = u.id and l.created_at > now() - interval '7 days') as login_count_7d,
    (select count(*) from login_events l where l.user_id = u.id and l.created_at > now() - interval '30 days') as login_count_30d
  from auth.users u
  order by u.created_at desc;
$$;

revoke all on function public.admin_user_stats() from public;
revoke all on function public.admin_user_stats() from anon;
revoke all on function public.admin_user_stats() from authenticated;
grant execute on function public.admin_user_stats() to service_role;
